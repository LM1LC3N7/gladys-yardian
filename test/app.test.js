// -----------------------------------------------------------------------------
// YardianApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), fake controllers behind the client's `request`, a memory
// store and a hand-driven clock. No network, no timers running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YardianApp } from '../src/app.js';
import { YardianClient } from '../src/yardian/client.js';
import { YardianError } from '../src/yardian/errors.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { HOST, TOKEN, YID, fakeNetwork } from './helpers/fakeYardian.js';

const SELECTOR = 'yardian';
const YC_HOST = '192.168.1.61';
const controllerId = (id = YID, key) => `ext:${SELECTOR}:yardian:${id}${key ? `:${key}` : ''}`;
const zoneId = (number, key, id = YID) =>
  `ext:${SELECTOR}:yardian-zone:${id}-${number}${key ? `:${key}` : ''}`;

/** Timers that never fire: the tests drive the polling and the flushes. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
};

function clock(start = 1_800_000_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

async function setup(
  t,
  {
    config = {},
    net = fakeNetwork(),
    store = new MemoryStore(),
    devices = [],
    now = clock(),
    appTimers = timers,
    request,
  } = {},
) {
  const fullConfig = { address: HOST, access_token: TOKEN, ...config };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new YardianApp({
    gladys,
    logger,
    client: new YardianClient({ request: request ?? net.request, now }),
    store,
    timers: appTimers,
    now,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { gladys, app, net, logs, store, now, config: fullConfig };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, externalId) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === externalId);
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

async function press(gladys, deviceExternalId, key, value = 1) {
  const device = deviceOf(gladys, deviceExternalId);
  return gladys.fake.setValue(device, featureOf(device, key), value);
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test('the controller and its enabled zones become the devices of the Discovery tab', async (t) => {
  const { gladys } = await setup(t);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [controllerId(), ...[1, 2, 4, 5, 6, 7, 8].map((n) => zoneId(n))],
    'zone 3 is disabled, the 9th entry is beyond the 8 zones of a PRO1902',
  );
  assert.equal(devices[0].name, 'Garden');
  assert.equal(devices[1].name, 'Lawn (Garden)');
  assert.deepEqual(
    devices[0].features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type, f.unit]),
    [
      ['watering', 'unknown', 'binary', undefined],
      ['current_zone', 'text', 'text', undefined],
      ['rain_delay', 'duration', 'integer', 'minutes'],
      ['standby', 'unknown', 'binary', undefined],
      ['stop', 'button', 'push', undefined],
    ],
  );
  assert.deepEqual(
    devices[1].features.map((f) => [f.external_id.split(':').at(-1), f.category, f.type]),
    [
      ['watering', 'unknown', 'binary'],
      ['start', 'button', 'push'],
      ['stop', 'button', 'push'],
    ],
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /Garden: 7 zone\(s\)/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Le démarrage des zones est désactivé/);
});

test('watering is never a switch nor a commandable binary', async (t) => {
  const { gladys } = await setup(t);
  for (const device of gladys.fake.discoveredDevices) {
    for (const feature of device.features) {
      assert.notEqual(feature.category, 'switch', feature.external_id);
      assert.ok(feature.read_only || feature.type === 'push', feature.external_id);
    }
  }
});

test('states: only for the created devices, the last values when created', async (t) => {
  const { gladys, app, net } = await setup(t);
  await app.publisher.flush();
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  await app.publisher.flush();
  const last = (id) => gladys.fake.lastState(id);
  assert.equal(last(controllerId(YID, 'watering')), 0);
  assert.equal(last(controllerId(YID, 'current_zone')), 'aucune');
  assert.equal(last(controllerId(YID, 'rain_delay')), 0);
  assert.equal(last(controllerId(YID, 'standby')), 0);
  assert.equal(last(zoneId(2, 'watering')), 0);
  // No token in a request other than its header.
  for (const call of net.calls) {
    assert.ok(!call.path.includes(TOKEN));
    assert.equal(call.headers['Yardian-Token'], TOKEN);
  }
});

test('start is refused by default: nothing read, nothing sent', async (t) => {
  const { gladys, net } = await setup(t);
  const before = net.calls.length;
  const result = await press(gladys, zoneId(1), 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé dans la configuration/);
  assert.equal(net.calls.length, before);
});

test('start, allowed: read just before, sent for the configured length, confirmed', async (t) => {
  const { gladys, net, app } = await setup(t, {
    config: { allow_start: true, watering_minutes: 7 },
  });
  await createAll(gladys);
  const before = net.calls.length;
  const result = await press(gladys, zoneId(2), 'start');
  assert.equal(result.success, true, result.error);
  const calls = net.calls.slice(before).map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(calls, [
    'GET /API_GET_DEVICEINFO',
    'GET /API_ZONE_GET_OPENINGZONE',
    'POST /',
    'GET /API_ZONE_GET_OPENINGZONE',
  ]);
  const post = JSON.parse(net.commands().at(-1).body);
  assert.deepEqual(post, { sEvent: 'AE_IRR_START_INST', sPayload: '[[-1, 0, 0, 1, 420]]' });
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(zoneId(2, 'watering')), 1);
  assert.equal(gladys.fake.lastState(controllerId(YID, 'current_zone')), 'Roses');
});

test('the watering length is capped at 60 minutes', async (t) => {
  const { gladys, net } = await setup(t, {
    config: { allow_start: true, watering_minutes: 500 },
  });
  await press(gladys, zoneId(1), 'start');
  assert.match(net.commands().at(-1).body, /3600\]\]/);
});

test('start: a zone already watering is not sent again', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_start: true } });
  net.table[HOST].active = [0];
  const result = await press(gladys, zoneId(1), 'start');
  assert.equal(result.success, true);
  assert.equal(net.commands().length, 0);
});

test('start: a disabled zone or a bad value is refused', async (t) => {
  const { gladys, app, net } = await setup(t, { config: { allow_start: true } });
  const zone = deviceOf(gladys, zoneId(1));
  const result = await gladys.fake.setValue(zone, featureOf(zone, 'start'), 0);
  assert.equal(result.success, false);
  app.data.devices[YID].zones[0].enabled = false;
  const disabled = await press(gladys, zoneId(1), 'start');
  assert.match(disabled.error, /inconnue ou désactivée/);
  const watering = await gladys.fake.setValue(zone, featureOf(zone, 'watering'), 1);
  assert.equal(watering.success, false);
  assert.equal(net.commands().length, 0);
});

test('start: the option turned off during the read: nothing leaves', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_start: true } });
  const release = net.hold(HOST, 'GET /API_ZONE_GET_OPENINGZONE');
  const pending = press(gladys, zoneId(1), 'start');
  await tick();
  app.config.allowStart = false;
  release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé/);
  assert.equal(net.commands().length, 0);
});

test('start: the option is checked again right before the request leaves (beforeSend)', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_start: true } });
  const release = net.hold(HOST, 'POST /');
  const pending = press(gladys, zoneId(1), 'start');
  await tick();
  app.config.allowStart = false;
  release();
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /désactivé/);
  assert.equal(net.commands().length, 0);
  assert.equal(app.data.guards[YID], undefined, 'no guard for a start never sent');
});

test('start: another controller at the address is refused, nothing sent', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_start: true } });
  net.table[HOST].info = { ...net.table[HOST].info, yid: 'other', serialNumber: 'SN9' };
  const result = await press(gladys, zoneId(1), 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /inconnu, ou plus à son adresse/);
  assert.equal(net.commands().length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /yid0001 was at this address, other/);
});

test('start: an unreadable identity or zones watering: refused, never "another controller"', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_start: true } });
  net.fail(HOST, 'GET /API_GET_DEVICEINFO', { body: '{"result":{}}' });
  const first = await press(gladys, zoneId(1), 'start');
  assert.match(first.error, /n'ont pas pu être lues/);
  net.fail(HOST, 'GET /API_ZONE_GET_OPENINGZONE', { body: '{"result":"x"}' });
  const second = await press(gladys, zoneId(1), 'start');
  assert.match(second.error, /n'ont pas pu être lues/);
  assert.equal(net.commands().length, 0);
  assert.equal(app.data.devices[YID].host, HOST);
});

test('start not taken: "sent, without confirmation", then a guard refuses another start', async (t) => {
  const now = clock();
  const { gladys, net, app } = await setup(t, { config: { allow_start: true }, now });
  net.table[HOST].takes = false;
  const result = await press(gladys, zoneId(1), 'start');
  assert.equal(result.success, false);
  assert.match(result.error, /envoyée, sans confirmation/);
  assert.equal(net.commands().length, 1);
  assert.ok(app.data.guards[YID].start, 'guard persisted');
  assert.deepEqual((await app.store.load()).guards[YID].start.zones, [1]);
  const again = await press(gladys, zoneId(2), 'start');
  assert.match(again.error, /vient d'être démarrée/);
  assert.equal(net.commands().length, 1);
  now.advance(61_000);
  net.table[HOST].takes = true;
  const later = await press(gladys, zoneId(2), 'start');
  assert.equal(later.success, true, later.error);
  assert.equal(net.commands().length, 2);
});

test('start: a token refused by the controller holds the starts, never the stops', async (t) => {
  const { gladys, net, app } = await setup(t, { config: { allow_start: true } });
  net.fail(HOST, 'POST /', { status: 403 });
  const result = await press(gladys, zoneId(1), 'start');
  assert.match(result.error, /a refusé le jeton/);
  assert.ok(app.data.startBlock);
  assert.equal(app.data.guards[YID], undefined, 'refused: no guard');
  const again = await press(gladys, zoneId(1), 'start');
  assert.match(again.error, /a refusé le jeton d'accès il y a peu/);
  assert.equal(net.commands().length, 1);
  const stop = await press(gladys, zoneId(1), 'stop');
  assert.equal(stop.success, true, stop.error);
  assert.equal(net.commands().length, 2);
  assert.ok(!JSON.stringify(app.store.data).includes(TOKEN));
});

test('stop: never held by the option, and cancels a start not sent yet', async (t) => {
  const { gladys, net } = await setup(t, { config: { allow_start: true } });
  net.table[HOST].active = [3];
  const release = net.hold(HOST, 'GET /API_ZONE_GET_OPENINGZONE');
  const start = press(gladys, zoneId(1), 'start');
  await tick();
  const stop = await press(gladys, controllerId(), 'stop');
  assert.equal(stop.success, true, stop.error);
  release();
  const started = await start;
  assert.equal(started.success, false);
  assert.match(started.error, /Annulée par une commande d'arrêt/);
  assert.deepEqual(
    net.commands().map((c) => JSON.parse(c.body).sEvent),
    ['AE_IRR_STOP_INST_TASK'],
  );
  assert.deepEqual(net.table[HOST].active, []);
});

test('stop: sent during a 429 pause (one try, no identity read) and before any read', async (t) => {
  const now = clock();
  const store = new MemoryStore(undefined, now);
  const first = await setup(t, { store, now });
  first.net.fail(HOST, 'GET /API_GET_DEVICEINFO', {
    status: 429,
    headers: { 'retry-after': '600' },
  });
  now.advance(31_000);
  await first.app.tick();
  assert.ok(first.app.paused());
  await first.app.stop();
  // A restart: the controller comes from /data, no read (paused), stop still goes.
  const net = fakeNetwork();
  net.table[HOST].active = [0];
  const { gladys, app } = await setup(t, { store, now, net });
  assert.equal(net.calls.length, 0, 'no read during the pause');
  assert.match(gladys.fake.connectionStatus.message.fr, /lectures en pause/);
  const stop = await press(gladys, zoneId(1), 'stop');
  // Taken, but no read may confirm it during the pause: said exactly.
  assert.equal(stop.success, false);
  assert.match(stop.error, /envoyée, sans confirmation/);
  assert.deepEqual(
    net.calls.map((c) => `${c.method} ${c.path}`),
    ['POST /'],
  );
  assert.deepEqual(net.table[HOST].active, []);
  assert.ok(app.paused(), 'the pause stays');
});

test('stop not taken: "sent, without confirmation", sent again by the follow-up reads, 3 times at most', async (t) => {
  const now = clock();
  const { gladys, net, app } = await setup(t, { now });
  net.table[HOST].active = [0];
  net.table[HOST].takes = false;
  const stop = await press(gladys, zoneId(1), 'stop');
  assert.equal(stop.success, false);
  assert.match(stop.error, /envoyée, sans confirmation/);
  const stops = () => net.commands().length;
  assert.equal(stops(), 1);
  for (let i = 0; i < 5; i += 1) {
    now.advance(10_000);
    await app.read();
    await tick();
  }
  assert.equal(stops(), 4, 'the stop and 3 resends');
});

test('stop resent unless a start the controller took left after it', async (t) => {
  const now = clock();
  const { gladys, net, app } = await setup(t, { now, config: { allow_start: true } });
  net.table[HOST].active = [0];
  net.table[HOST].takes = false;
  await press(gladys, controllerId(), 'stop');
  net.table[HOST].takes = true;
  net.table[HOST].active = [];
  const start = await press(gladys, zoneId(2), 'start');
  assert.equal(start.success, true, start.error);
  now.advance(10_000);
  await app.read();
  await tick();
  assert.deepEqual(
    net.commands().map((c) => JSON.parse(c.body).sEvent),
    ['AE_IRR_STOP_INST_TASK', 'AE_IRR_START_INST'],
    'the newer start is not stopped',
  );
});

test('YC controller: start posts an instant program, stop a zone stops only its task', async (t) => {
  const { gladys, net, app } = await setup(t, {
    config: { address: YC_HOST, allow_start: true },
  });
  await createAll(gladys);
  const devices = gladys.fake.discoveredDevices.map((d) => d.external_id);
  assert.deepEqual(devices, [
    controllerId('yid0002'),
    zoneId(1, undefined, 'yid0002'),
    zoneId(2, undefined, 'yid0002'),
  ]);
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(controllerId('yid0002', 'rain_delay')), 120);
  const one = await press(gladys, zoneId(1, undefined, 'yid0002'), 'start');
  assert.equal(one.success, true, one.error);
  // The guard of the first start was lifted by its confirmation read.
  const two = await press(gladys, zoneId(2, undefined, 'yid0002'), 'start');
  assert.equal(two.success, true, two.error);
  assert.deepEqual(
    net.table[YC_HOST].tasks.map((t) => t.output_id),
    [0, 1],
  );
  assert.deepEqual(JSON.parse(net.commands()[0].body), { output_durs: [[0, 600]], store: false });
  const stop = await press(gladys, zoneId(2, undefined, 'yid0002'), 'stop');
  assert.equal(stop.success, true, stop.error);
  assert.deepEqual(
    net.table[YC_HOST].tasks.map((t) => t.output_id),
    [0],
  );
  assert.equal(net.commands().at(-1).method, 'PATCH');
  assert.equal(net.commands().at(-1).path, '/res/running-task/101?action=stop');
});

test('never read sooner than the interval: connected, scan, check, saved config, restart', async (t) => {
  const now = clock();
  const store = new MemoryStore(undefined, now);
  const first = await setup(t, { store, now });
  const reads = () => first.net.reads().filter((c) => c.path === '/API_GET_DEVICEINFO').length;
  assert.equal(reads(), 1);
  // A reconnection to Gladys (the `connected` handler) and a configuration saved unchanged.
  await first.app.start(first.config);
  await first.app.scan();
  await first.app.checkController();
  await first.app.tick();
  assert.equal(reads(), 1);
  now.advance(30_000);
  await first.app.tick();
  assert.equal(reads(), 2);
  await first.app.stop();
  // A restart right after: no read before an interval.
  now.advance(5_000);
  const second = await setup(t, { store, now });
  assert.equal(second.net.calls.length, 0);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.match(second.gladys.fake.connectionStatus.message.en, /answered the last read before/);
  now.advance(31_000);
  await second.app.tick();
  assert.equal(second.net.calls.length > 0, true);
});

test('a token refused on a read: persisted, no read again until the Check button succeeds', async (t) => {
  const now = clock();
  const store = new MemoryStore(undefined, now);
  const net = fakeNetwork();
  net.table[HOST].token = 'another';
  const { gladys, app } = await setup(t, { now, store, net });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /Access token refused/);
  assert.ok(store.data.tokenBlock || app.data.tokenBlock);
  const count = net.calls.length;
  now.advance(10 * 60_000);
  await app.tick();
  assert.equal(net.calls.length, count, 'never retried by itself');
  // The button tries once; the controller still refuses.
  await app.checkController();
  assert.equal(net.calls.length, count + 1);
  await app.checkController();
  assert.equal(net.calls.length, count + 1, 'never sooner than the interval');
  // The token was fixed on the controller side: the button lifts the refusal.
  net.table[HOST].token = TOKEN;
  now.advance(30_000);
  const answer = await app.checkController();
  assert.match(answer.en, /"Garden"/);
  assert.equal(app.data.tokenBlock, undefined);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a new token is tried (by the next due read)', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  net.table[HOST].token = 'another';
  const { app, config } = await setup(t, { now, net });
  assert.ok(app.tokenBlocked());
  await app.start({ ...config, access_token: 'another' });
  assert.equal(app.tokenBlocked(), false);
  now.advance(30_000);
  await app.tick();
  assert.equal(app.status.id, YID);
});

test('a read of an older configuration ending late publishes nothing', async (t) => {
  const now = clock();
  const { app, net, gladys, config } = await setup(t, { now });
  now.advance(30_000);
  const release = net.hold(HOST, 'GET /API_GET_DEVICEINFO');
  const reading = app.tick();
  await tick();
  await app.start({ ...config, address: YC_HOST });
  const status = gladys.fake.connectionStatus;
  release();
  await reading;
  assert.deepEqual(gladys.fake.connectionStatus, status);
  assert.equal(app.status.address, YC_HOST);
});

test('a secondary endpoint failing never stops the read', async (t) => {
  const net = fakeNetwork();
  net.fail(HOST, 'GET /API_MGR_GET_OPERINFO', { status: 500 });
  const { gladys, app } = await setup(t, { net });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(app.paused(), false);
});

test('the token is never in a log line, a status nor /data', async (t) => {
  const net = fakeNetwork();
  net.fail(HOST, 'GET /API_ZONE_GET_OPENINGZONE', new YardianError('timeout', { sent: true }));
  const { gladys, logs, store, app } = await setup(t, { net });
  await app.stop();
  assert.ok(!logs.join('\n').includes(TOKEN));
  assert.ok(!JSON.stringify(gladys.fake.connectionStatus).includes(TOKEN));
  assert.ok(!JSON.stringify(store.data).includes(TOKEN));
});

test('a created device never loses a feature', async (t) => {
  const extra = {
    name: 'Old',
    external_id: `${controllerId()}:old`,
    category: 'unknown',
    type: 'binary',
    min: 0,
    max: 1,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
  const { gladys } = await setup(t, {
    devices: [{ name: 'Garden', external_id: controllerId(), features: [extra] }],
  });
  const device = deviceOf(gladys, controllerId());
  assert.ok(device.features.some((f) => f.external_id === extra.external_id));
});
