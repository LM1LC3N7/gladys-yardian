// -----------------------------------------------------------------------------
// Yardian answers -> identity, zones and reading (pure). After pyyardian
// 1.4.2 and the Home Assistant integration (coordinator, sensor and
// binary_sensor): `yid` identifies the controller (Home Assistant's unique
// id), `model` says the family (a C<n> suffix: the YC API), the YP zones are
// `[name, enabled, ...]` lists, the zones watering are their 0-based ids,
// `iRainDelay` is a number of seconds (or an epoch end), `iStandby` the epoch
// end of the standby (2147483647: until further notice). Own properties only,
// every number checked: a missing or odd value is undefined, never 0, and the
// parsing is linear in the size of the answer (itself capped).
// -----------------------------------------------------------------------------

import { cleanText } from '../config.js';
import { FAMILY, LIMITS, MODEL_ZONES, TIMINGS } from '../constants.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (data, key) => (isObject(data) && Object.hasOwn(data, key) ? data[key] : undefined);

/** A finite integer (or its exact text) within bounds, else undefined. */
export function integerOf(value, min, max) {
  let number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && /^\s*-?\d{1,12}\s*$/.test(value)) {
    number = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

/** An identifier as it may enter an external id: letters, digits, - and _ only. */
export function idOf(value) {
  const text = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof text !== 'string') {
    return undefined;
  }
  const trimmed = text.trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

/** The family of a model: a C<n> suffix is the YC API (pyyardian detect_model). */
export const familyOf = (model) => (/C\d+$/.test(model.toUpperCase()) ? FAMILY.YC : FAMILY.YP);

/** The zones of a model (pyyardian MODEL_DETAIL; a C<n> model has the zones of its base). */
export function zoneCountOf(model) {
  const upper = model.toUpperCase();
  return MODEL_ZONES[upper] ?? MODEL_ZONES[upper.replace(/C\d+$/, '')];
}

/**
 * The identity of a controller: `{ id, yid, serial, model, family, name }`.
 * Frozen rule (it fixes the external ids): the id is the `yid`, or
 * `sn-<serialNumber>` when the answer has no yid; `id` undefined when it has
 * neither (unreadable: never "another controller").
 */
export function identityOf(info) {
  const yid = idOf(own(info, 'yid'));
  const serial = idOf(own(info, 'serialNumber'));
  const model = cleanText(own(info, 'model'), 32);
  return {
    id: yid ?? (serial ? `sn-${serial}` : undefined),
    yid,
    serial,
    model,
    family: familyOf(model),
    name: cleanText(own(info, 'name'), 64),
  };
}

/**
 * Whether an identity is the controller of a record: the same yid, or the
 * same serial number when one of them has no yid. Missing on both: no.
 */
export function sameController(identity, record) {
  if (identity.yid && record.yid) {
    return identity.yid === record.yid;
  }
  return Boolean(identity.serial && record.serial && identity.serial === record.serial);
}

const zoneName = (value, number) => cleanText(value, 64) || `Zone ${number}`;

/** YP: `zones` of API_MGR_GET_OPERINFO -> `[{ index, number, name, enabled }]`, or undefined. */
export function ypZonesOf(oper, model) {
  const list = own(oper, 'zones');
  if (!Array.isArray(list)) {
    return undefined;
  }
  const count = Math.min(LIMITS.zones, zoneCountOf(model) ?? LIMITS.zones);
  const zones = [];
  for (let index = 0; index < Math.min(count, list.length); index += 1) {
    const entry = list[index];
    const number = index + 1;
    if (!Array.isArray(entry)) {
      zones.push({ index, number, name: `Zone ${number}`, enabled: false });
      continue;
    }
    zones.push({
      index,
      number,
      name: zoneName(entry[0], number),
      enabled: entry[1] === 1 || entry[1] === true,
    });
  }
  return zones;
}

/** YC: /res/output-setting -> zones (all enabled, as pyyardian reads them), or undefined. */
export function ycZonesOf(outputs, model) {
  if (!Array.isArray(outputs)) {
    return undefined;
  }
  const count = Math.min(LIMITS.zones, zoneCountOf(model) ?? LIMITS.zones);
  return outputs.slice(0, count).map((output, index) => ({
    index,
    number: index + 1,
    name: zoneName(own(output, 'name'), index + 1),
    enabled: true,
  }));
}

/** YP: API_ZONE_GET_OPENINGZONE -> the 0-based zone ids watering, or undefined. */
export function ypActiveOf(result) {
  if (!Array.isArray(result) || result.length > LIMITS.zones) {
    return undefined;
  }
  const active = new Set();
  for (const value of result) {
    const zone = integerOf(value, 0, LIMITS.zones - 1);
    if (zone === undefined) {
      return undefined;
    }
    active.add(zone);
  }
  return active;
}

/** YC: /res/running-task -> `{ active, tasks: [{ id, zone }] }`, or undefined. */
export function ycTasksOf(result) {
  if (!Array.isArray(result) || result.length > LIMITS.tasks) {
    return undefined;
  }
  const tasks = [];
  for (const task of result) {
    const id = idOf(own(task, 'id'));
    const zone = integerOf(own(task, 'output_id'), 0, LIMITS.zones - 1);
    if (id === undefined || zone === undefined) {
      return undefined;
    }
    tasks.push({ id, zone });
  }
  return { active: new Set(tasks.map((t) => t.zone)), tasks };
}

/**
 * Seconds left of a value that is either a delay in seconds or an epoch end
 * (Home Assistant's threshold of a year). An epoch end is compared with the
 * clock of the controller (its `Date` header): without it, undefined.
 */
export function secondsLeft(value, deviceDate) {
  const number = integerOf(value, 0, 2 ** 31);
  if (number === undefined) {
    return undefined;
  }
  if (number <= TIMINGS.absoluteThreshold) {
    return number;
  }
  if (deviceDate === undefined) {
    return undefined;
  }
  return Math.max(0, number - Math.floor(deviceDate / 1000));
}

/** YP `iStandby`: 0 no, 2147483647 until further notice, else an end (or seconds left). */
export function standbyOf(value, deviceDate) {
  const number = integerOf(value, 0, 2 ** 31);
  if (number === undefined) {
    return undefined;
  }
  if (number === 0) {
    return false;
  }
  if (number >= 2 ** 31 - 1) {
    return true;
  }
  const left = secondsLeft(number, deviceDate);
  return left === undefined ? undefined : left > 0;
}

/** YC /res/sch-setting `standby_mode`. */
export function ycStandbyOf(settings) {
  const mode = own(settings, 'standby_mode');
  if (typeof mode === 'boolean') {
    return mode;
  }
  const number = integerOf(mode, 0, 2 ** 31);
  return number === undefined ? undefined : number > 0;
}

/** The rain delay left, in minutes (rounded up), or undefined. */
export function rainDelayOf(oper, deviceDate) {
  const seconds = secondsLeft(own(oper, 'iRainDelay'), deviceDate);
  return seconds === undefined ? undefined : Math.ceil(seconds / 60);
}
