// -----------------------------------------------------------------------------
// The integration: the Yardian controller at the typed address, polled over
// its local HTTP API, the Gladys devices built from it (the controller and
// its enabled zones), and the start / stop commands. index.js only wires the
// SDK handlers to it (src/handlers.js).
//
// Reads:
//   - API_GET_DEVICEINFO at every read: its yid says which controller
//     answers, so the identity is checked at every read (a new DHCP lease
//     moves a controller, never its device); an answer without a yid nor a
//     serial number is a failed read, never "another controller";
//   - then the zones and the zones watering (YP: API_MGR_GET_OPERINFO and
//     API_ZONE_GET_OPENINGZONE; YC: /res/controller, /res/sch-setting,
//     /res/output-setting and /res/running-task). A failure of a secondary
//     endpoint (rain delay, standby, zone names) never stops the rest;
//   - never sooner than the interval: not on a reconnection to Gladys, a
//     configuration saved unchanged, the Discovery scan or the "Check" button,
//     nor after a restart (the time of the last read is kept in /data); a
//     reconnection during a read shares it;
//   - failures: 30 s, 1, 2, 5 min, never sooner than the interval; HTTP 429
//     or 5xx: a pause of 1 min to 6 h persisted in /data; a token refused: no
//     read at all (persisted) until another token is saved or the "Check"
//     button succeeds;
//   - a read of an older configuration that ends late publishes nothing and
//     sets no status (the generation is checked after every await).
//
// Commands (buttons, never a switch):
//   - Start (a zone): opens a valve, so it is off by default ("Allow
//     starting the zones", checked on arrival, after the fresh reads and
//     right before the request leaves). It is decided on the identity and the
//     zones watering read just now; already watering: nothing sent. The
//     watering length is the configured one, at most 60 minutes. One queue
//     per controller; a guard (set before the first byte, persisted) refuses
//     another start until a read sent after it shows the zone watering, or
//     60 s; a token refused holds the starts (15 min, 1 h, 6 h, then 24 h);
//     a 429/5xx pause holds them.
//   - Stop (a zone, or every zone of the controller): never held. Not
//     queued, not held by the option, a pause, a refused token or a guard;
//     it cancels on arrival the starts not sent yet (queued ones included);
//     one try, never retried in a loop. The identity is read first when the
//     controller is not paused (another controller answering: refused; no
//     answer: the stop leaves anyway). The YP API only stops every zone at
//     once; the YC one stops task by task (the readable ones, 32 at most).
//     Refused unsent only when another controller answers, the controller is
//     no longer at its address, no token is set, or the YC tasks cannot be
//     read (then the guard is set and the next reads send it). After a stop,
//     the follow-up reads that still see the zones watering send it again
//     (3 times, 60 s), unless a start the controller took left after it. A
//     start that left BEFORE the stop and has not settled keeps the stop
//     guard; once it settles as "may have left", the guard is armed again.
//     Both guards are on disk before the first byte of their command.
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s;
//     confirmed only by a read showing the requested state; a request that
//     may have reached the controller is never answered "not sent": "sent,
//     without confirmation", then reads;
//   - the ack never waits for a publication to Gladys; the token is never in
//     a log line, a status, an error or /data.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { generationKey, normalizeConfig, numberOf } from './config.js';
import { BUTTON_PUSH, FAMILY, LIMITS, TIMINGS, WATERING_MINUTES } from './constants.js';
import { ERRORS, T, join, word } from './i18n.js';
import {
  buildControllerDevice,
  buildZoneDevice,
  controllerFeatures,
  controllerIds,
  offeredZones,
  valuesOf,
  zoneFeatures,
  zoneIds,
} from './model.js';
import { StatePublisher } from './publisher.js';
import { FileStore, emptyData } from './store.js';
import { YardianClient } from './yardian/client.js';
import { YardianError, reasonOf } from './yardian/errors.js';
import {
  identityOf,
  rainDelayOf,
  sameController,
  standbyOf,
  ycStandbyOf,
  ycStopTargetsOf,
  ycTasksOf,
  ycZonesOf,
  ypActiveOf,
  ypZonesOf,
} from './yardian/parse.js';

/** A command value, strictly: a finite number or its exact text ('' and null are not 0). */
const strictNumber = (value) => (typeof value === 'boolean' ? undefined : numberOf(value));

/** The zones of a stop guard that a reading still shows watering. */
const stillWatering = (zones, active) =>
  zones === 'all' ? active.size > 0 : zones.some((n) => active.has(n - 1));

export class YardianApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'yardian' }),
    client = new YardianClient(),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.config = undefined;
    this.data = undefined;
    /** Bumped when the address or the token change: a late answer of before is dropped. */
    this.generation = 0;
    this.generationKey = undefined;
    this.publisher = new StatePublisher({
      gladys,
      logger,
      now,
      timers,
      interval: TIMINGS.measureInterval,
    });
    /** The reads of the typed address: { address, lastTry, next, failures, id?, error? } */
    this.status = undefined;
    /** No read before this time (a restart soon after the last read). */
    this.notBefore = 0;
    this.lastTrySaved = -Infinity;
    /** id -> reachable */
    this.reachable = new Map();
    /** [previous id, new id] when another controller answers at the address */
    this.moved = undefined;
    /** deviceId -> transport badge last published */
    this.transports = new Map();
    /** featureId -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** featureId -> { id, kind: 'controller' | 'zone', number?, key } */
    this.features = new Map();
    /** id -> tail of its start queue */
    this.queues = new Map();
    /** id -> tickets of the starts not sent yet */
    this.tickets = new Map();
    /** id -> the start between its plan and its answer */
    this.flights = new Map();
    /** id -> { seq, at, refused } of the last start that LEFT */
    this.lastStarts = new Map();
    /** id -> starts that LEFT and are not settled yet (no answer, failure or timeout) */
    this.startsInFlight = new Map();
    /** id -> handles of the reads after its last command */
    this.followUps = new Map();
    /** ids whose stop is being sent again */
    this.reaffirming = new Set();
    /** The read in progress (a poll, a follow-up and the button share it). */
    this.reading = undefined;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.saving = Promise.resolve();
    this.lastStatus = undefined;
    this.warned = new Set();
    /** Every request gets a number: a guard is lifted only by a read sent after its command. */
    this.sequence = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  async start(raw = {}) {
    const first = !this.data;
    if (first) {
      this.data = await this.store.load().catch(() => emptyData());
    }
    this.config = normalizeConfig(raw);
    if (first && this.data.lastTry !== undefined) {
      // The last read may be later than the one written (once a minute): a
      // whole interval from now is never sooner than the interval.
      if (this.now() - this.data.lastTry < this.interval + TIMINGS.lastTrySave) {
        this.notBefore = this.now() + this.interval;
      }
    }
    const key = generationKey(this.config);
    if (key !== this.generationKey) {
      this.generationKey = key;
      this.generation += 1;
      // A new address: its own reads (the same one keeps its last try, so a
      // configuration saved again never reads sooner).
      if (this.status?.address !== this.config.address) {
        this.status = undefined;
        this.moved = undefined;
      }
      this.reading = undefined;
    }
    // Gladys keeps the status and the Discovery tab in memory: sent again at every start.
    this.lastStatus = undefined;
    this.transports.clear();
    this.refreshCreated();
    this.publisher.start();
    await this.publishDevices();
    await this.publishAllTransports();
    this.schedule();
    this.updateStatus();
    const changed = await this.poll();
    if (changed) {
      await this.publishDevices();
    }
    this.updateStatus();
  }

  stop() {
    this.publisher.stop();
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handles of this.followUps.values()) {
      for (const handle of handles) {
        this.timers.clearTimeout(handle);
      }
    }
    this.followUps.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.save();
    }
    return this.saving;
  }

  schedule() {
    this.timers.clearInterval(this.pollTimer);
    // The timer only looks: the address is read when due.
    this.pollTimer = this.timers.setInterval(() => this.tick(), Math.min(this.interval, 5000));
  }

  tick() {
    return this.poll()
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${reasonOf(err)}`));
  }

  /** Saves /data now, one write at a time. */
  save() {
    this.saving = this.saving
      .then(() => this.store.save(this.data))
      .catch(() => this.logger.warn('Could not save /data'));
    return this.saving;
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.save();
    }, TIMINGS.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  get records() {
    return Object.values(this.data?.devices ?? {});
  }

  nextSequence() {
    this.sequence += 1;
    return this.sequence;
  }

  // --- Pauses (429, 5xx) and refused tokens ---------------------------------

  paused() {
    const pause = this.data.pause;
    return Boolean(pause && pause.host === this.config.address && pause.until > this.now());
  }

  /** A failure: a pause asked by the controller is persisted. */
  onFailure(host, err) {
    if (!(err instanceof YardianError) || err.kind !== 'busy' || !host) {
      return;
    }
    const previous = this.data.pause?.host === host ? this.data.pause : undefined;
    const failures = previous ? previous.failures + 1 : 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    this.logger.warn(`Yardian: ${err.message}, paused for ${Math.round(wait / 1000)} s`);
    this.data.pause = { host, failures, until: this.now() + wait };
    this.persist();
    this.updateStatus();
  }

  onSuccess(host) {
    if (this.data.pause?.host === host) {
      this.data.pause = undefined;
      this.persist();
    }
  }

  /** A salted fingerprint of a token, only ever kept for a token the controller refused. */
  fingerprint(token) {
    return createHmac('sha256', this.data.salt).update(token).digest('hex');
  }

  /** The current token was refused on a read: no read until it changes or the button succeeds. */
  tokenBlocked() {
    const block = this.data.tokenBlock;
    return Boolean(
      block && this.config.token && block.fingerprint === this.fingerprint(this.config.token),
    );
  }

  /** The current token was refused on a start lately: the starts wait. */
  startBlocked() {
    const block = this.data.startBlock;
    return Boolean(
      block &&
      this.config.token &&
      block.until > this.now() &&
      block.fingerprint === this.fingerprint(this.config.token),
    );
  }

  onTokenRefused(token) {
    this.data.tokenBlock = { fingerprint: this.fingerprint(token), at: this.now() };
    this.warnOnce(`token:${this.data.tokenBlock.fingerprint}`, 'Yardian: access token refused');
    this.save();
    this.updateStatus();
  }

  onStartTokenRefused(token) {
    const fingerprint = this.fingerprint(token);
    const previous = this.data.startBlock;
    const failures = previous?.fingerprint === fingerprint ? previous.failures + 1 : 1;
    const wait = TIMINGS.tokenRetries[Math.min(failures, TIMINGS.tokenRetries.length) - 1];
    this.data.startBlock = { fingerprint, failures, until: this.now() + wait };
    this.logger.warn('Yardian: access token refused for a start');
    this.save();
    this.updateStatus();
  }

  /** A token that worked: no fingerprint of it stays in /data. */
  onTokenAccepted(token, { command = false } = {}) {
    const fingerprint = this.fingerprint(token);
    let changed = false;
    if (this.data.tokenBlock?.fingerprint === fingerprint) {
      this.data.tokenBlock = undefined;
      changed = true;
    }
    if (command && this.data.startBlock?.fingerprint === fingerprint) {
      this.data.startBlock = undefined;
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  // --- Reads -----------------------------------------------------------------

  statusOf() {
    if (!this.status) {
      this.status = { address: this.config.address, lastTry: undefined, next: 0, failures: 0 };
    }
    return this.status;
  }

  /**
   * Whether a read is due. `force` (the Check button) only lifts the hold of
   * a refused token, never the interval, a backoff or a pause.
   */
  isDue({ force = false } = {}) {
    if (!this.config.address || !this.config.token) {
      return false;
    }
    if (this.now() < this.notBefore || this.paused()) {
      return false;
    }
    const status = this.status;
    if (this.tokenBlocked()) {
      if (!force) {
        return false;
      }
      const last = status?.lastTry ?? this.data.lastTry;
      return last === undefined || this.now() - last >= this.interval;
    }
    return !status || status.lastTry === undefined || this.now() >= status.next;
  }

  /** The time of the last read, written to /data at most once a minute. */
  markTry() {
    this.data.lastTry = this.now();
    if (this.now() - this.lastTrySaved >= TIMINGS.lastTrySave) {
      this.lastTrySaved = this.now();
      this.persist();
    }
  }

  /** One read when due; true when a Gladys device changes. */
  async poll(options) {
    if (!this.isDue(options)) {
      return this.reading ?? false;
    }
    return this.read();
  }

  /** Reads the controller; a read already running is shared. */
  read() {
    if (this.reading) {
      return this.reading;
    }
    const promise = this.doRead(this.generation).finally(() => {
      if (this.reading === promise) {
        this.reading = undefined;
      }
    });
    this.reading = promise;
    return promise;
  }

  async doRead(generation) {
    const host = this.config.address;
    const token = this.config.token;
    const status = this.statusOf();
    status.lastTry = this.now();
    // Written before the read: a crash during it never reads sooner after.
    this.markTry();
    // When this read left: it can only lift a guard of a command sent before it.
    const origin = { seq: this.nextSequence(), at: this.now() };
    const fail = (err) => {
      if (generation !== this.generation) {
        return false;
      }
      if (err?.kind === 'token') {
        this.onTokenRefused(token);
      }
      this.onFailure(host, err);
      this.failed(status, err?.kind ?? 'error');
      this.logger.debug(`Read failed: ${reasonOf(err)}`);
      return false;
    };
    let info;
    try {
      ({ info } = await this.client.deviceInfo(host, token));
    } catch (err) {
      return fail(err);
    }
    if (generation !== this.generation) {
      return false;
    }
    const identity = identityOf(info);
    if (!identity.id) {
      // Unreadable: a failed read, never "another controller".
      this.failed(status, 'notController');
      this.warnOnce(`notController:${host}`, 'Yardian: no yid nor serial number in the answer');
      return false;
    }
    identity.family = this.familyFor(identity, this.recordOf(identity, host));
    let reading;
    try {
      reading = await this.readState(host, token, identity, generation);
    } catch (err) {
      return fail(err);
    }
    if (!reading || generation !== this.generation) {
      return false;
    }
    if (!reading.active) {
      // The zones watering are required. On a YC controller whose task list
      // is only partly readable, a stop being watched is still sent again to
      // the tasks that can be read.
      const known = this.recordOf(identity, host);
      if (known && reading.stopTasks?.length > 0) {
        // -1: tasks whose zone is unreadable (only a stop of every zone takes them).
        const zones = new Set(reading.stopTasks.map((t) => t.zone).filter((z) => z !== undefined));
        this.reaffirmStop(
          known,
          { active: zones.size > 0 ? zones : new Set([-1]), tasks: reading.stopTasks },
          origin,
        );
      }
      return fail(new YardianError('invalid', { sent: true }));
    }
    this.onSuccess(host);
    this.onTokenAccepted(token);
    const changed = this.remember(identity, host, reading.zones);
    const record = this.recordOf(identity, host);
    status.failures = 0;
    status.next = status.lastTry + this.interval;
    status.error = undefined;
    status.id = record.id;
    this.rememberRead({ ok: true, id: record.id, address: host, at: status.lastTry });
    this.liftGuards(record, reading, origin);
    this.recordValues(record, reading);
    this.setReachable(record, true);
    this.reaffirmStop(record, reading, origin);
    return changed;
  }

  /**
   * The zones, the zones watering, the rain delay and the standby of the
   * controller. The zones watering are required (a failure fails the read);
   * the other endpoints are secondary: a failure leaves their values unknown.
   */
  async readState(host, token, identity, generation) {
    const secondary = async (task) => {
      try {
        return await task();
      } catch (err) {
        if (err?.kind === 'token') {
          throw err;
        }
        this.logger.debug(`Secondary read failed: ${reasonOf(err)}`);
        return undefined;
      }
    };
    const reading = { zones: undefined, active: undefined, tasks: undefined };
    if (identity.family === FAMILY.YC) {
      const controller = await secondary(() => this.client.ycController(host, token));
      const settings = await secondary(() => this.client.ycScheduleSettings(host, token));
      const outputs = await secondary(() => this.client.ycOutputs(host, token));
      const raw = await this.client.ycRunningTasks(host, token);
      const parsed = ycTasksOf(raw);
      if (generation !== this.generation) {
        return undefined;
      }
      // For a stop only: the readable tasks, when the whole list is not.
      reading.stopTasks = parsed ? undefined : ycStopTargetsOf(raw)?.tasks;
      reading.zones = ycZonesOf(outputs, identity.model);
      reading.rainDelayMinutes = controller
        ? rainDelayOf(controller.oper, controller.date)
        : undefined;
      reading.standby = settings === undefined ? undefined : ycStandbyOf(settings);
      reading.active = parsed?.active;
      reading.tasks = parsed?.tasks;
    } else {
      const oper = await secondary(() => this.client.ypOperInfo(host, token));
      const active = ypActiveOf(await this.client.ypActiveZones(host, token));
      if (generation !== this.generation) {
        return undefined;
      }
      reading.zones = oper ? ypZonesOf(oper.oper, identity.model) : undefined;
      reading.rainDelayMinutes = oper ? rainDelayOf(oper.oper, oper.date) : undefined;
      reading.standby = oper ? standbyOf(oper.oper?.iStandby, oper.date) : undefined;
      reading.active = active;
    }
    return reading;
  }

  /** The outcome of the last read, kept in /data with lastTry (the status after a restart). */
  rememberRead(outcome) {
    const previous = this.data.lastRead;
    this.data.lastRead = outcome;
    if (previous?.ok !== outcome.ok || previous?.id !== outcome.id) {
      this.persist();
    }
  }

  failed(status, error) {
    status.failures += 1;
    status.error = error;
    status.id = undefined;
    this.rememberRead({ ok: false, address: status.address, at: status.lastTry });
    const wait = TIMINGS.backoff[Math.min(status.failures, TIMINGS.backoff.length) - 1];
    status.next = status.lastTry + Math.max(wait, this.interval);
    for (const record of this.records) {
      if (record.host === status.address) {
        this.setReachable(record, false);
      }
    }
  }

  /**
   * The record of an identity: the same yid (or serial number); else, at the
   * same address, the record that nothing contradicts (a yid on one side, a
   * serial number on the other: the same controller, its fields merged).
   */
  recordOf(identity, host) {
    return (
      this.records.find((record) => sameController(identity, record) === true) ??
      (host
        ? this.records.find(
            (record) => record.host === host && sameController(identity, record) !== false,
          )
        : undefined)
    );
  }

  /** The family of an answer without a model is the one known for the controller. */
  familyFor(identity, record) {
    return identity.model || !record ? identity.family : record.family;
  }

  /** Adds or updates the controller answering; true when a Gladys device changes. */
  remember(identity, host, zones) {
    const devices = this.data.devices;
    const existing = this.recordOf(identity, host);
    const proven = !existing || sameController(identity, existing) === true;
    if (!existing && Object.keys(devices).length >= LIMITS.devices) {
      // The oldest one not at this address makes room.
      const oldest = this.records.find((r) => r.host !== host);
      if (oldest) {
        delete devices[oldest.id];
      }
    }
    let changed = false;
    // One address, one controller: another one known at this address has moved.
    for (const other of this.records) {
      if (other !== existing && other.host === host) {
        this.logger.warn(`Yardian ${other.id} no longer answers, ${identity.id} does`);
        this.moved = [other.id, existing?.id ?? identity.id];
        other.host = '';
        this.setReachable(other, false);
        changed = true;
      }
    }
    if (this.moved && this.moved[0] === (existing?.id ?? identity.id)) {
      this.moved = undefined;
    }
    const record = {
      id: existing?.id ?? identity.id,
      // The identifiers are merged only on proof (the same yid or serial).
      yid: proven ? (identity.yid ?? existing?.yid) : existing.yid,
      serial: proven ? (identity.serial ?? existing?.serial) : existing.serial,
      host,
      family: this.familyFor(identity, existing),
      model: identity.model || existing?.model || '',
      name: identity.name || existing?.name || '',
      zones: this.mergeZones(existing?.zones ?? [], zones),
    };
    for (const key of ['yid', 'serial']) {
      if (record[key] === undefined) {
        delete record[key];
      }
    }
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      if (existing && existing.host !== host) {
        this.logger.info(`Yardian ${record.id} answers at a new address`);
      }
      if (existing) {
        // The same object: a command running for it sees the change.
        for (const key of Object.keys(existing)) {
          if (!(key in record)) delete existing[key];
        }
        Object.assign(existing, record);
      } else {
        devices[record.id] = record;
      }
      changed = true;
      this.persist();
    }
    return changed;
  }

  /** The zones read win; a zone no longer read is kept (its device never vanishes). */
  mergeZones(previous, next) {
    if (!next) {
      return previous;
    }
    const byNumber = new Map(previous.map((zone) => [zone.number, { ...zone }]));
    for (const zone of next) {
      byNumber.set(zone.number, { number: zone.number, name: zone.name, enabled: zone.enabled });
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number).slice(0, LIMITS.zones);
  }

  recordValues(record, reading) {
    for (const [featureId, entry] of valuesOf(this.gladys, record, reading, {
      language: this.config.language,
    })) {
      this.lastValues.set(featureId, entry);
      if (this.created.has(featureId)) {
        this.publisher.push(featureId, entry);
      }
    }
  }

  setReachable(record, reachable) {
    const previous = this.reachable.get(record.id);
    this.reachable.set(record.id, reachable);
    if (previous !== reachable) {
      this.publishTransportsOf(record).catch((err) =>
        this.logger.warn(`Transport badge failed: ${reasonOf(err)}`),
      );
    }
  }

  // --- Gladys devices ----------------------------------------------------------

  /** Every device of a record: [deviceIds, kind, zone number, features]. */
  devicesOf(record, created) {
    const out = [
      {
        ids: controllerIds(this.gladys, record),
        kind: 'controller',
        build: () => buildControllerDevice(this.gladys, record, { language: this.config.language }),
        keys: controllerFeatures().map((f) => f.key),
      },
    ];
    for (const zone of record.zones) {
      const ids = zoneIds(this.gladys, record, zone.number);
      // The enabled zones, and the ones the user created (kept when disabled since).
      if (!zone.enabled && !created.has(ids.device)) {
        continue;
      }
      out.push({
        ids,
        kind: 'zone',
        number: zone.number,
        build: () => buildZoneDevice(this.gladys, record, zone, { language: this.config.language }),
        keys: zoneFeatures().map((f) => f.key),
      });
    }
    return out;
  }

  /**
   * The Discovery tab. A created device never loses a feature: the features
   * it has that the code no longer gives are published as they are (Gladys
   * would otherwise mark it changed, and "Update" would drop their history).
   */
  async publishDevices() {
    const devices = [];
    this.features.clear();
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    for (const record of this.records) {
      for (const entry of this.devicesOf(record, created)) {
        const device = entry.build();
        for (const key of entry.keys) {
          this.features.set(entry.ids.feature(key), {
            id: record.id,
            kind: entry.kind,
            number: entry.number,
            key,
          });
        }
        const published = new Set(device.features.map((f) => f.external_id));
        for (const feature of created.get(device.external_id)?.features ?? []) {
          if (!published.has(feature.external_id)) {
            const kept = {};
            for (const field of [
              'name',
              'external_id',
              'category',
              'type',
              'min',
              'max',
              'unit',
              'read_only',
              'has_feedback',
              'keep_history',
            ]) {
              if (feature[field] !== undefined && feature[field] !== null) {
                kept[field] = feature[field];
              }
            }
            device.features.push(kept);
          }
        }
        devices.push(device);
      }
    }
    this.publisher.configure({ throttled: new Set(), events: new Set() });
    await this.gladys
      .publishDiscoveredDevices(devices)
      .catch((err) =>
        this.logger.warn(`Publishing the discovered devices failed: ${reasonOf(err)}`),
      );
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const feature of device?.features ?? []) {
      const value = this.lastValues.get(feature.external_id);
      if (value) {
        this.publisher.push(feature.external_id, value);
      }
    }
    const record = this.records.find((r) =>
      this.devicesOf(r, this.createdDevices()).some((e) => e.ids.device === device?.external_id),
    );
    if (record) {
      await this.publishTransportsOf(record).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  transportOf(record) {
    return this.reachable.get(record.id) === false
      ? DEVICE_TRANSPORTS.UNREACHABLE
      : DEVICE_TRANSPORTS.LOCAL;
  }

  /** The badges of the created devices of a record that changed. */
  transportEntries(record, created) {
    if (!this.reachable.has(record.id)) {
      return [];
    }
    const transport = this.transportOf(record);
    const entries = [];
    for (const { ids } of this.devicesOf(record, created)) {
      if (created.has(ids.device) && this.transports.get(ids.device) !== transport) {
        this.transports.set(ids.device, transport);
        entries.push({ external_id: ids.device, transport });
      }
    }
    return entries;
  }

  async publishTransportsOf(record) {
    const entries = this.transportEntries(record, this.createdDevices());
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries);
    }
  }

  async publishAllTransports() {
    const created = this.createdDevices();
    const entries = this.records.flatMap((record) => this.transportEntries(record, created));
    if (entries.length > 0) {
      await this.gladys
        .publishTransports(entries.slice(0, 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${reasonOf(err)}`));
    }
  }

  updateStatus() {
    const { address, invalidAddress, tokenProblem } = this.config;
    const parts = [];
    let connected = false;
    if (!address) {
      parts.push(invalidAddress ? T.invalidAddress(invalidAddress) : T.noAddress);
    } else if (tokenProblem) {
      parts.push(T.token[tokenProblem]);
    } else if (this.tokenBlocked()) {
      parts.push(T.tokenRefused);
    } else {
      const status = this.status;
      if (status?.lastTry !== undefined) {
        const record = status.id ? this.data.devices[status.id] : undefined;
        connected = Boolean(record);
        if (record) {
          const reading = this.lastValues.get(
            controllerIds(this.gladys, record).feature('watering'),
          );
          parts.push(
            T.ok(record.name || record.id, offeredZones(record).length, reading?.state === 1),
          );
        } else if (status.error === 'notController') {
          parts.push(T.notController);
        } else {
          parts.push(T.failed(status.error ?? 'error'));
        }
      } else {
        // After a restart, before the first read (never sooner than the
        // interval): the outcome of the last read kept in /data.
        const last = this.data.lastRead;
        connected = Boolean(last?.ok && last.address === address);
        parts.push(connected ? T.restored(this.config.pollInterval) : T.waiting);
      }
      if (this.paused()) {
        parts.push(T.paused);
      }
      if (this.startBlocked()) {
        parts.push(T.startTokenRefused);
      }
      if (!this.config.allowStart) {
        parts.push(T.startsOff);
      }
      if (this.moved) {
        parts.push(T.moved(this.moved[0], this.moved[1]));
      }
    }
    const message = join(parts);
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${reasonOf(err)}`));
  }

  /** The Discovery tab scan: a read only when due, then the devices. */
  async scan() {
    await this.poll();
    await this.publishDevices();
    this.updateStatus();
  }

  /**
   * "Check the controller": what it answered, read again only when due. A
   * refused token is tried once (never sooner than the interval): a success
   * lifts the refusal.
   */
  async checkController() {
    if (!this.config.address) {
      return T.check.none;
    }
    if (this.config.tokenProblem) {
      return join([T.token[this.config.tokenProblem]]);
    }
    if (await this.poll({ force: true })) {
      await this.publishDevices();
    }
    this.updateStatus();
    const status = this.status;
    const lines = [];
    if (!status || status.lastTry === undefined) {
      lines.push(T.check.pending);
    } else {
      const age = Math.max(0, Math.round((this.now() - status.lastTry) / 1000));
      const record = status.id ? this.data.devices[status.id] : undefined;
      lines.push(
        record
          ? T.check.ok(
              record.name || record.id,
              record.id,
              record.model,
              offeredZones(record).length,
              age,
            )
          : T.check.failed(status.error ?? 'error', age),
      );
    }
    if (this.tokenBlocked()) {
      lines.push(T.tokenRefused);
    }
    if (this.paused()) {
      lines.push(T.paused);
    }
    lines.push(T.check.interval(this.config.pollInterval));
    return join(lines, '\n');
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config?.language ?? 'fr'));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    // Before the first start, or a feature not published: a refusal, never a
    // publication awaited by the ack.
    const target = this.data && this.config && this.features.get(feature?.external_id);
    const record = target && this.data.devices[target.id];
    if (!record) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (target.key !== 'start' && target.key !== 'stop') {
      throw this.refusal(ERRORS.readOnly);
    }
    if (strictNumber(value) !== BUTTON_PUSH.PRESSED) {
      throw this.refusal(ERRORS.badValue);
    }
    if (target.key === 'stop') {
      return this.stopCommand(record, target.kind === 'zone' ? [target.number] : 'all', received);
    }
    return this.startCommand(record, target.number, received);
  }

  // --- Start (a valve opens: off by default) ---------------------------------

  /** The permission of a start, read now from the current configuration. */
  checkStartOption() {
    if (!this.config.allowStart) {
      throw this.refusal(ERRORS.startDisabled);
    }
    if (!this.config.token) {
      throw this.refusal(ERRORS.noToken);
    }
  }

  async startCommand(record, number, received) {
    const zone = record.zones.find((z) => z.number === number);
    if (!zone || !zone.enabled) {
      throw this.refusal(ERRORS.unknownZone);
    }
    this.checkStartOption();
    // A start already on its way: another one is refused at once.
    if (this.flights.get(record.id)?.sent) {
      throw this.refusal(ERRORS.justStarted);
    }
    const ticket = {
      cancelled: false,
      sent: false,
      generation: this.generation,
      abort: new AbortController(),
    };
    if (!this.tickets.has(record.id)) {
      this.tickets.set(record.id, new Set());
    }
    this.tickets.get(record.id).add(ticket);
    // One queue per controller; the wait ends by sendBy - 200 ms: the answer
    // always comes within 3.5 s.
    const previous = this.queues.get(record.id) ?? Promise.resolve();
    let timer;
    const turn = new Promise((resolve, reject) => {
      previous.then(resolve, resolve);
      timer = this.timers.setTimeout(
        () => {
          const flying = this.flights.get(record.id);
          reject(this.refusal(flying?.sent ? ERRORS.justStarted : ERRORS.tooSlow));
        },
        Math.max(0, received + TIMINGS.commandSendBy - 200 - this.now()),
      );
    }).finally(() => this.timers.clearTimeout(timer));
    const run = turn.then(() => this.runStart(record, zone, received, ticket));
    // The next start waits for this one AND everything before it.
    const tail = Promise.allSettled([previous, run]).then(() => {});
    this.queues.set(record.id, tail);
    try {
      return await run;
    } finally {
      this.tickets.get(record.id)?.delete(ticket);
      tail.then(() => {
        if (this.queues.get(record.id) === tail) {
          this.queues.delete(record.id);
        }
      });
    }
  }

  /**
   * The guard of a start, set before its connection (the caller awaits its
   * save: it is on disk before the first byte); its request number and time
   * are set again in beforeSend, when the request really leaves.
   */
  guardStart(record, number) {
    const guard = {
      zones: [number],
      at: this.now(),
      seq: this.nextSequence(),
      until: this.now() + TIMINGS.startGuard,
    };
    this.data.guards[record.id] = { ...this.data.guards[record.id], start: guard };
    return guard;
  }

  /** A start whose request just left: tracked until it settles. */
  trackStart(record, entry) {
    if (!this.startsInFlight.has(record.id)) {
      this.startsInFlight.set(record.id, new Set());
    }
    this.startsInFlight.get(record.id).add(entry);
  }

  /**
   * A start that left has settled. `left`: it may have reached the
   * controller (2xx, 5xx, silence, a dropped connection). A stop guard set
   * after it left could not see it yet: the guard is armed again from now
   * (only a read sent after this point may lift it) and the follow-up reads
   * start again, so the stop is sent again if the zone waters.
   */
  settleStart(record, entry, left) {
    this.startsInFlight.get(record.id)?.delete(entry);
    const guard = this.data.guards[record.id]?.stop;
    if (!left || !guard || entry.seq === undefined) {
      return;
    }
    const before = guard.seq === undefined ? entry.at <= guard.at : entry.seq < guard.seq;
    if (!before) {
      return;
    }
    guard.seq = this.nextSequence();
    guard.at = this.now();
    guard.until = Math.max(guard.until, this.now() + TIMINGS.stopGuard);
    guard.resends = 0;
    // Lifted by time only (60 s): follow-up reads, at most 3 resends.
    guard.sticky = true;
    this.logger.info(
      `Yardian ${record.id}: a start sent before the stop settled, stop watched again`,
    );
    this.save();
    this.followUp(record);
  }

  /** A start that left before a stop guard and has not settled: the guard cannot be lifted. */
  startPendingBefore(record, guard) {
    for (const entry of this.startsInFlight.get(record.id) ?? []) {
      // Bounded: a start always settles within its answer deadline.
      if (entry.seq === undefined || this.now() - entry.at > TIMINGS.inFlightMax) {
        continue;
      }
      if (guard.seq === undefined ? entry.at <= guard.at : entry.seq < guard.seq) {
        return true;
      }
    }
    return false;
  }

  /** The controller surely did nothing (a refusal): the guard of this start goes. */
  unguard(record, kind, guard) {
    const guards = this.data.guards[record.id];
    if (guard && guards?.[kind] === guard) {
      delete guards[kind];
      if (!guards.start && !guards.stop) {
        delete this.data.guards[record.id];
      }
      this.save();
    }
  }

  /** Whether a read started after a guard (request numbers, or times after a restart). */
  static after(guard, origin) {
    return guard.seq === undefined ? origin.at > guard.at : origin.seq > guard.seq;
  }

  clampGuard(guard, longest) {
    if (guard && guard.at > this.now()) {
      // A clock that went back: never a longer hold than planned.
      guard.at = this.now();
      guard.until = Math.min(guard.until, this.now() + longest);
      this.persist();
    }
    return guard;
  }

  /** A start guard holds until a read sent after it shows its zone watering, or its end. */
  startGuardHolds(record, active, origin) {
    const guard = this.clampGuard(this.data.guards[record.id]?.start, TIMINGS.startGuard);
    if (!guard) {
      return false;
    }
    if (this.now() >= guard.until) {
      this.unguard(record, 'start', guard);
      return false;
    }
    if (active && YardianApp.after(guard, origin) && guard.zones.some((n) => active.has(n - 1))) {
      this.unguard(record, 'start', guard);
      return false;
    }
    return true;
  }

  /** A stop guard ends when a read sent after it shows its zones dry, or at its end. */
  stopGuardHolds(record, active, origin) {
    const guard = this.clampGuard(this.data.guards[record.id]?.stop, TIMINGS.stopGuard);
    if (!guard) {
      return false;
    }
    // A start that left before the stop and is not settled may still water.
    if (this.startPendingBefore(record, guard)) {
      return true;
    }
    if (this.now() >= guard.until) {
      this.unguard(record, 'stop', guard);
      return false;
    }
    // Armed again by a start that may have left: a dry read proves nothing
    // (the controller may apply it seconds later), only time lifts it.
    if (
      !guard.sticky &&
      active &&
      YardianApp.after(guard, origin) &&
      !stillWatering(guard.zones, active)
    ) {
      this.unguard(record, 'stop', guard);
      return false;
    }
    return true;
  }

  /** A read (polling, follow-up) may lift the guards, by the same rules. */
  liftGuards(record, reading, origin) {
    this.startGuardHolds(record, reading.active, origin);
    this.stopGuardHolds(record, reading.active, origin);
  }

  async runStart(record, zone, received, ticket) {
    try {
      return await this.doStart(record, zone, received, ticket);
    } finally {
      if (this.flights.get(record.id) === ticket) {
        this.flights.delete(record.id);
      }
    }
  }

  async doStart(record, zone, received, ticket) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => {
      if (ticket.cancelled) throw this.refusal(ERRORS.cancelled);
      if (ticket.generation !== this.generation) throw this.refusal(ERRORS.configChanged);
      this.checkStartOption();
      if (
        !record.host ||
        record.host !== this.config.address ||
        this.data.devices[record.id] !== record
      ) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (this.paused()) throw this.refusal(ERRORS.blocked);
      if (this.tokenBlocked() || this.startBlocked()) throw this.refusal(ERRORS.tokenRefused);
      if (this.now() > sendBy) throw this.refusal(ERRORS.tooSlow);
    };
    check();
    const host = record.host;
    const token = this.config.token;
    const left = () => sendBy - this.now() - 200;
    const origin = { seq: this.nextSequence(), at: this.now() };
    const readFailure = (err) => {
      if (err.refusal) return err;
      if (err.kind === 'cancelled' || ticket.cancelled) return this.refusal(ERRORS.cancelled);
      this.onFailure(host, err);
      if (err.kind === 'busy') return this.refusal(ERRORS.blocked);
      if (err.kind === 'token') {
        this.onTokenRefused(token);
        return this.refusal(ERRORS.tokenRefusedNow);
      }
      return this.refusal(
        err.kind === 'timeout' && left() <= 0 ? ERRORS.tooSlow : ERRORS.unknownState,
      );
    };
    // The identity and the zones watering, read just now.
    let identity;
    let active;
    try {
      if (left() <= 0) throw this.refusal(ERRORS.tooSlow);
      const options = () => ({ timeout: left(), signal: ticket.abort.signal });
      ({ info: identity } = await this.client.deviceInfo(host, token, options()));
      identity = identityOf(identity);
      if (!identity.id) throw this.refusal(ERRORS.unknownState);
      const same = sameController(identity, record);
      // No field in common (a yid on one side, a serial on the other):
      // nothing contradicts, nothing proves. A valve is opened only on proof
      // (a stop still goes in that case).
      if (same === undefined) throw this.refusal(ERRORS.identityUnproven);
      if (same === false) {
        if (ticket.generation === this.generation && record.host === host) {
          this.logger.warn(`Yardian ${record.id} no longer answers at its address`);
          this.moved = [record.id, identity.id];
          record.host = '';
          this.setReachable(record, false);
          this.persist();
          this.updateStatus();
        }
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (left() <= 0) throw this.refusal(ERRORS.tooSlow);
      const raw = await this.client.activeZones(host, record.family, token, options());
      active = record.family === FAMILY.YC ? ycTasksOf(raw)?.active : ypActiveOf(raw);
    } catch (err) {
      throw readFailure(err);
    }
    if (!active) {
      throw this.refusal(ERRORS.unknownState);
    }
    if (ticket.generation === this.generation) {
      // Shown in the background: the ack never waits for Gladys.
      this.recordValues(record, { active });
    }
    // Cancelled or no longer allowed while it read: said so before any other reason.
    check();
    const flying = this.flights.get(record.id);
    if (flying && flying !== ticket) {
      throw this.refusal(ERRORS.justStarted);
    }
    if (this.startGuardHolds(record, active, origin)) {
      throw this.refusal(ERRORS.justStarted);
    }
    if (active.has(zone.number - 1)) {
      // Already watering: nothing sent.
      return;
    }
    this.flights.set(record.id, ticket);
    check();
    const minutes = Math.min(WATERING_MINUTES.max, this.config.wateringMinutes);
    this.logger.info(`Yardian ${record.id}: start zone ${zone.number} for ${minutes} min`);
    // The guard is on disk before the first byte (a restart while the start
    // is out keeps it); it goes if the start never leaves.
    const guard = this.guardStart(record, zone.number);
    await this.save();
    // Counts as a newer start (over a stop) only once the controller took it.
    const sent = { seq: undefined, at: undefined, accepted: false };
    try {
      check();
      await this.client.startZone(host, record.family, token, zone.number - 1, minutes * 60, {
        timeout: Math.max(100, answerBy - this.now()),
        signal: ticket.abort.signal,
        sendWithin: sendBy - this.now(),
        // The very last check, right before the request leaves.
        beforeSend: () => {
          check();
          ticket.sent = true;
          guard.seq = this.nextSequence();
          guard.at = this.now();
          sent.seq = guard.seq;
          sent.at = guard.at;
          this.lastStarts.set(record.id, sent);
          this.trackStart(record, sent);
        },
      });
    } catch (err) {
      if (err.refusal || err.beforeSend) {
        this.unguard(record, 'start', guard);
        throw err;
      }
      const reason = reasonOf(err);
      if (!err.sent) {
        this.settleStart(record, sent, false);
        this.unguard(record, 'start', guard);
        this.logger.warn(`Yardian ${record.id}: start NOT sent (${reason})`);
        if (err.kind === 'cancelled' || ticket.cancelled) throw this.refusal(ERRORS.cancelled);
        throw this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      const refusedByController =
        err.kind === 'token' ||
        err.kind === 'refused' ||
        err.status === 429 ||
        (err.kind === 'http' && err.status >= 400 && err.status <= 499);
      this.onFailure(host, err);
      if (refusedByController) {
        // The controller did not take it: it never counts as a newer start.
        this.settleStart(record, sent, false);
        this.unguard(record, 'start', guard);
        this.logger.warn(`Yardian ${record.id}: start refused (${reason})`);
        if (err.kind === 'token') {
          this.onStartTokenRefused(token);
          throw this.refusal(ERRORS.tokenRefusedNow);
        }
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection, a 5xx: it may have reached the
      // controller, the guard stays.
      this.settleStart(record, sent, true);
      this.followUp(record);
      this.logger.warn(`Yardian ${record.id}: start sent, NOT confirmed (${reason})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    sent.accepted = true;
    this.settleStart(record, sent, true);
    this.onTokenAccepted(token, { command: true });
    // Confirmed only by a read showing the zone watering.
    const confirmed = await this.confirm(record, token, answerBy, (seen) =>
      seen.has(zone.number - 1),
    );
    this.followUp(record);
    if (!confirmed) {
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.config.language)));
    }
  }

  /**
   * A read of the zones watering right after a command, within its answer
   * deadline: true when `wanted(active)`. It lifts the guards it can.
   */
  async confirm(record, token, answerBy, wanted) {
    const timeout = answerBy - this.now() - 100;
    // A pause asked by the controller holds this read too.
    if (timeout < 200 || this.paused()) {
      return false;
    }
    const origin = { seq: this.nextSequence(), at: this.now() };
    try {
      const raw = await this.client.activeZones(record.host, record.family, token, { timeout });
      const active = record.family === FAMILY.YC ? ycTasksOf(raw)?.active : ypActiveOf(raw);
      if (!active) {
        return false;
      }
      this.liftGuards(record, { active }, origin);
      this.recordValues(record, { active });
      return wanted(active);
    } catch {
      return false;
    }
  }

  // --- Stop (protective: never held) -----------------------------------------

  /** Cancels the starts of a controller not sent yet (queued ones included). */
  cancelStarts(record) {
    for (const pending of this.tickets.get(record.id) ?? []) {
      if (!pending.sent) {
        pending.cancelled = true;
        // Its connection attempt, if any, is dropped at once.
        pending.abort.abort();
      }
    }
  }

  /**
   * The guard of a stop, set before its connection (the caller awaits its
   * save); its request number is set again when the stop really leaves.
   */
  guardStop(record, zones) {
    const previous = this.data.guards[record.id]?.stop;
    const live = previous && previous.until > this.now() ? previous : undefined;
    // Two stops in a row: the guard covers both.
    let merged = zones;
    if (live) {
      merged =
        live.zones === 'all' || zones === 'all'
          ? 'all'
          : [...new Set([...live.zones, ...zones])].sort((a, b) => a - b);
    }
    const guard = {
      zones: merged,
      at: this.now(),
      seq: this.nextSequence(),
      until: this.now() + TIMINGS.stopGuard,
    };
    if (live?.sticky) {
      // Still watching a start that may have left: kept until its end.
      guard.sticky = true;
    }
    this.data.guards[record.id] = { ...this.data.guards[record.id], stop: guard };
    return guard;
  }

  async stopCommand(record, zones, received) {
    if (!this.config.token) {
      throw this.refusal(ERRORS.noToken);
    }
    // On arrival, before anything else: the starts waiting are cancelled.
    this.cancelStarts(record);
    if (!record.host) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const host = record.host;
    const token = this.config.token;
    const left = () => sendBy - this.now() - 200;
    // The identity first, when the controller is not paused (a stop gets one
    // try only): another controller answering is refused; no answer, or an
    // unreadable one, lets the stop leave (in doubt, the stop goes).
    if (!this.paused() && left() > 300) {
      try {
        const { info } = await this.client.deviceInfo(host, token, {
          timeout: Math.min(TIMINGS.stopIdentityTimeout, left() - 200),
        });
        const identity = identityOf(info);
        if (identity.id && sameController(identity, record) === false) {
          throw this.refusal(ERRORS.unknownDevice);
        }
      } catch (err) {
        if (err.refusal) throw err;
        this.logger.debug(`Identity before a stop: ${reasonOf(err)}`);
      }
    }
    let tasks;
    if (record.family === FAMILY.YC) {
      // The YC API stops tasks by id (it has no stop of every zone): the
      // running ones are read first; the readable ones are stopped even when
      // others are not readable or there are too many.
      let failure;
      try {
        if (left() > 0) {
          tasks = ycStopTargetsOf(
            await this.client.ycRunningTasks(host, token, { timeout: left() }),
          );
        }
      } catch (err) {
        failure = err;
        this.onFailure(host, err);
      }
      if (!tasks) {
        // Nothing can be sent now: the guard watches, and the next reads that
        // see the zones watering send the stop.
        this.guardStop(record, zones);
        await this.save();
        this.followUp(record);
        this.logger.warn(`Yardian ${record.id}: running tasks unreadable (${reasonOf(failure)})`);
        throw this.refusal(ERRORS.stopTasksUnknown);
      }
    }
    const outcome = await this.sendStop(record, zones, { token, tasks, sendBy, answerBy });
    if (outcome.error) {
      throw outcome.error;
    }
    const confirmed = await this.confirm(
      record,
      token,
      answerBy,
      (active) => !stillWatering(zones, active),
    );
    this.followUp(record);
    if (!confirmed) {
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.notSeen, this.config.language)));
    }
  }

  /**
   * Sends a stop: YP one request (every zone), YC one PATCH per task of the
   * zones, all written at once, each checked against its deadline right
   * before it leaves. Resolves `{ sent, error }`, never rejects.
   */
  async sendStop(record, zones, { token, tasks, sendBy, answerBy, resend }) {
    const host = record.host;
    // A resend keeps the guard of its stop (never a longer watch); a new
    // stop sets its guard and has it on disk before the first byte.
    const guard = resend ?? this.guardStop(record, zones);
    if (!resend) {
      await this.save();
    }
    let left = false;
    const beforeSend = () => {
      if (this.now() > sendBy) throw this.refusal(ERRORS.tooSlow);
      if (!resend && !left) {
        // The stop leaves now: only a start leaving after this point is newer.
        left = true;
        guard.seq = this.nextSequence();
        guard.at = this.now();
      }
    };
    const options = () => ({
      timeout: Math.max(100, answerBy - this.now()),
      sendWithin: sendBy - this.now(),
      beforeSend,
    });
    let requests;
    if (record.family === FAMILY.YC) {
      const targets = (tasks?.tasks ?? []).filter(
        (task) => zones === 'all' || zones.includes(task.zone + 1),
      );
      if (targets.length === 0) {
        // Nothing running (yet: a start may still be on its way): nothing to
        // stop, the guard still watches.
        this.followUp(record);
        return { sent: true };
      }
      requests = targets.map((task) => this.client.ycStopTask(host, token, task.id, options()));
    } else {
      requests = [this.client.ypStop(host, token, options())];
    }
    this.logger.info(`Yardian ${record.id}: stop ${zones === 'all' ? 'all' : `zone ${zones}`}`);
    const results = await Promise.allSettled(requests);
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failures.length === 0) {
      return { sent: true };
    }
    const err = failures[0];
    const anySent = failures.some((f) => f.sent) || failures.length < results.length;
    const reason = err.refusal ? err.message : reasonOf(err);
    if (!anySent) {
      // The guard stays: the next reads that see the zones watering send it.
      this.followUp(record);
      this.logger.warn(`Yardian ${record.id}: stop NOT sent (${reason})`);
      return {
        sent: false,
        error: err.refusal
          ? err
          : this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason)),
      };
    }
    this.onFailure(host, err);
    this.followUp(record);
    if (err.kind === 'token') {
      this.logger.warn(`Yardian ${record.id}: stop refused (token)`);
      return { sent: true, error: this.refusal(ERRORS.stopTokenRefused) };
    }
    if (err.kind === 'refused' || (err.kind === 'http' && err.status < 500) || err.status === 429) {
      this.logger.warn(`Yardian ${record.id}: stop refused (${reason})`);
      return { sent: true, error: this.refusal(ERRORS.refused(reason)) };
    }
    this.logger.warn(`Yardian ${record.id}: stop sent, NOT confirmed (${reason})`);
    return { sent: true, error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
  }

  /**
   * A read still sees the zones of a recent stop watering: the stop is sent
   * again, unless a start the controller took left after it (request
   * numbers, or times after a restart). A failed resend keeps the guard: the
   * next follow-up read tries again.
   */
  reaffirmStop(record, reading, origin) {
    const guard = this.data.guards[record.id]?.stop;
    if (
      !guard ||
      !YardianApp.after(guard, origin) ||
      !stillWatering(guard.zones, reading.active) ||
      this.reaffirming.has(record.id) ||
      (guard.resends ?? 0) >= TIMINGS.stopResends ||
      !this.config.token ||
      record.host !== this.config.address
    ) {
      return;
    }
    const start = this.lastStarts.get(record.id);
    // Only a start the controller answered 2xx counts; in doubt, the stop goes.
    if (start?.accepted) {
      const newer = guard.seq === undefined ? start.at > guard.at : start.seq > guard.seq;
      if (newer) {
        return;
      }
    }
    this.reaffirming.add(record.id);
    // Counted in memory only: after a restart, the guard allows its resends again.
    guard.resends = (guard.resends ?? 0) + 1;
    const now = this.now();
    this.logger.warn(`Yardian ${record.id}: still watering after a stop, stop sent again`);
    this.sendStop(record, guard.zones, {
      token: this.config.token,
      tasks: reading.tasks ? { tasks: reading.tasks } : undefined,
      sendBy: now + TIMINGS.commandSendBy,
      answerBy: now + TIMINGS.commandAnswerBy,
      resend: guard,
    })
      .then((outcome) => {
        if (outcome.error) {
          this.logger.warn(`Stop sent again: ${outcome.error.message}`);
        }
      })
      .finally(() => this.reaffirming.delete(record.id));
  }

  /**
   * Reads after a command, spaced. One series per controller: a new command
   * replaces the reads of the previous one, and a read shares the one of the
   * polling if it runs. Never during a pause, a token refusal, nor sooner
   * than a backoff.
   */
  followUp(record) {
    for (const handle of this.followUps.get(record.id) ?? []) {
      this.timers.clearTimeout(handle);
    }
    const handles = TIMINGS.followUps.map((delay) =>
      this.timers.setTimeout(() => {
        const status = this.status;
        if (
          this.data.devices[record.id] !== record ||
          !record.host ||
          record.host !== this.config.address ||
          !this.config.token ||
          this.paused() ||
          this.tokenBlocked() ||
          (status?.failures > 0 && this.now() < status.next)
        ) {
          return;
        }
        this.read()
          .then((changed) => (changed ? this.publishDevices() : undefined))
          .then(() => this.updateStatus())
          .catch(() => this.logger.warn('Read after a command failed'));
      }, delay),
    );
    this.followUps.set(record.id, handles);
  }
}
