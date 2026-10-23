// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume):
//   - the known controllers (by yid), their address, API family and zones, so
//     watering can be stopped after a restart before the first read, and a
//     created device never loses a feature;
//   - the pause asked by the controller (429/5xx);
//   - the access tokens REFUSED: a salted fingerprint only (never the token,
//     never a fingerprint of a token the controller accepted), removed at the
//     first success, so a wrong token is never replayed in a loop;
//   - the guards of the last start and the last stop of each controller, with
//     the time they left;
//   - the time of the last read (written at most once a minute), so a restart
//     never reads sooner than the interval, and the outcome of that read (the
//     status until the first read).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanText, parseAddress } from './config.js';
import { FAMILY, LIMITS, TIMINGS } from './constants.js';
import { idOf } from './yardian/parse.js';

export const newSalt = () => randomBytes(16).toString('hex');

export const emptyData = () => ({
  salt: newSalt(),
  lastTry: undefined,
  lastRead: undefined,
  devices: {},
  pause: undefined,
  tokenBlock: undefined,
  startBlock: undefined,
  guards: {},
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const failuresOf = (value) => (Number.isInteger(value) ? Math.min(Math.max(value, 1), 100) : 1);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function zonesOf(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const zones = [];
  for (const zone of list.slice(0, LIMITS.zones)) {
    if (
      !isObject(zone) ||
      !Number.isInteger(zone.number) ||
      zone.number < 1 ||
      zone.number > LIMITS.zones ||
      zones.some((z) => z.number === zone.number)
    ) {
      continue;
    }
    zones.push({
      number: zone.number,
      name: cleanText(zone.name, 64) || `Zone ${zone.number}`,
      enabled: zone.enabled === true,
    });
  }
  return zones;
}

/** A guard as kept: `{ zones: [n...] | 'all', at, until }` (times only, no request number). */
function guardOf(guard, now, longest) {
  if (!isObject(guard) || !Number.isFinite(guard.until)) {
    return undefined;
  }
  const zones =
    guard.zones === 'all'
      ? 'all'
      : Array.isArray(guard.zones)
        ? guard.zones
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= LIMITS.zones)
            .slice(0, LIMITS.zones)
        : undefined;
  if (zones === undefined || (zones !== 'all' && zones.length === 0)) {
    return undefined;
  }
  return {
    zones,
    // Unknown or in the future: now, the safe side.
    at: Number.isFinite(guard.at) ? Math.min(guard.at, now) : now,
    until: Math.min(guard.until, now + longest),
    // A stop guard armed again by a start that may have left: lifted by time only.
    ...(guard.sticky === true ? { sticky: true } : {}),
  };
}

/**
 * What a file holds, checked: unknown keys dropped, ids and addresses
 * checked, every end of a pause or a guard never later than its longest
 * bound from now (a clock that jumped, a file edited by hand).
 */
export function sanitize(data, now = Date.now()) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)) {
    base.salt = data.salt;
  }
  if (Number.isFinite(data.lastTry)) {
    base.lastTry = Math.min(data.lastTry, now);
  }
  if (isObject(data.lastRead) && typeof data.lastRead.ok === 'boolean') {
    const at = Number.isFinite(data.lastRead.at) ? Math.min(data.lastRead.at, now) : now;
    const address = parseAddress(data.lastRead.address);
    if (address === data.lastRead.address) {
      base.lastRead =
        data.lastRead.ok && DEVICE_ID.test(String(data.lastRead.id ?? ''))
          ? { ok: true, id: data.lastRead.id, address, at }
          : { ok: false, address, at };
    }
  }
  if (isObject(data.devices)) {
    for (const [id, record] of Object.entries(data.devices).slice(0, LIMITS.devices)) {
      if (
        !DEVICE_ID.test(id) ||
        !isObject(record) ||
        record.id !== id ||
        typeof record.host !== 'string' ||
        (record.host !== '' && parseAddress(record.host) !== record.host) ||
        !Object.values(FAMILY).includes(record.family)
      ) {
        continue;
      }
      base.devices[id] = {
        id,
        yid: idOf(record.yid),
        serial: idOf(record.serial),
        host: record.host,
        family: record.family,
        model: cleanText(record.model, 32),
        name: cleanText(record.name, 64),
        zones: zonesOf(record.zones),
      };
    }
  }
  if (isObject(data.pause) && parseAddress(data.pause.host) === data.pause.host) {
    const until = Number.isFinite(data.pause.until)
      ? Math.min(data.pause.until, now + TIMINGS.pauseMax)
      : now;
    base.pause = { host: data.pause.host, until, failures: failuresOf(data.pause.failures) };
  }
  if (isObject(data.tokenBlock) && FINGERPRINT.test(String(data.tokenBlock.fingerprint ?? ''))) {
    base.tokenBlock = {
      fingerprint: data.tokenBlock.fingerprint,
      at: Number.isFinite(data.tokenBlock.at) ? Math.min(data.tokenBlock.at, now) : now,
    };
  }
  if (isObject(data.startBlock) && FINGERPRINT.test(String(data.startBlock.fingerprint ?? ''))) {
    const longest = TIMINGS.tokenRetries.at(-1);
    base.startBlock = {
      fingerprint: data.startBlock.fingerprint,
      failures: failuresOf(data.startBlock.failures),
      until: Number.isFinite(data.startBlock.until)
        ? Math.min(data.startBlock.until, now + longest)
        : now,
    };
  }
  if (isObject(data.guards)) {
    for (const [id, guards] of Object.entries(data.guards).slice(0, LIMITS.devices)) {
      if (!DEVICE_ID.test(id) || !isObject(guards)) {
        continue;
      }
      const start = guardOf(guards.start, now, TIMINGS.startGuard);
      const stop = guardOf(guards.stop, now, TIMINGS.stopGuard);
      if (start || stop) {
        base.guards[id] = {};
        if (start) base.guards[id].start = start;
        if (stop) base.guards[id].stop = stop;
      }
    }
  }
  return base;
}

/** The JSON written: undefined fields dropped, never a token. */
const serialize = (data) => JSON.stringify(data);

export class FileStore {
  constructor({
    dir = process.env.DATA_DIR || '/data',
    name = 'yardian.json',
    now = Date.now,
  } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.now = now;
  }

  async load() {
    try {
      return sanitize(JSON.parse(await readFile(this.path, 'utf8')), this.now());
    } catch {
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, serialize(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData(), now = Date.now) {
    this.data = JSON.parse(serialize(data));
    this.saves = 0;
    this.now = now;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)), this.now());
  }

  async save(data) {
    this.data = JSON.parse(serialize(data));
    this.saves += 1;
  }
}
