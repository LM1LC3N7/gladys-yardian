// -----------------------------------------------------------------------------
// The scenarios of review 1 (H1, H1b, H1c, H4, H4b, H5, H6, M2): a start that
// left before a stop but is applied after it, an identity without a field in
// common, a YC task list too long or unreadable, a model missing.
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
const YC_ID = 'yid0002';
const controllerId = (id = YID) => `ext:${SELECTOR}:yardian:${id}`;
const zoneId = (number, id = YID) => `ext:${SELECTOR}:yardian-zone:${id}-${number}`;
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

async function setup(t, { config = {}, net = fakeNetwork(), request, now = clock() } = {}) {
  const fullConfig = { address: HOST, access_token: TOKEN, ...config };
  const gladys = createFakeGladys({ selector: SELECTOR, config: fullConfig, devices: [] });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new YardianApp({
    gladys,
    logger,
    client: new YardianClient({ request: request ?? net.request, now }),
    store: new MemoryStore(undefined, now),
    timers,
    now,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  return { gladys, app, net, now };
}

const deviceOf = (gladys, id) => gladys.fake.discoveredDevices.find((d) => d.external_id === id);
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
async function press(gladys, id, key) {
  const device = deviceOf(gladys, id);
  return gladys.fake.setValue(device, featureOf(device, key), 1);
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const events = (net) =>
  net
    .commands()
    .map((c) => (c.method === 'PATCH' ? `PATCH ${c.path}` : (JSON.parse(c.body).sEvent ?? 'inst')));

/** A request where the start leaves (beforeSend) but reaches the controller only on `open()`. */
function gatedStart(net, matches, { timeout = false } = {}) {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const request = async (options) => {
    if (matches(options)) {
      options.beforeSend?.();
      await gate;
      const answer = await net.request({ ...options, beforeSend: undefined });
      if (timeout) {
        throw new YardianError('timeout', { sent: true });
      }
      return answer;
    }
    return net.request(options);
  };
  return { request, open };
}

const ypStart = (o) => o.method === 'POST' && String(o.body).includes('AE_IRR_START_INST');

async function followUps(app, now, steps) {
  for (const ms of steps) {
    now.advance(ms);
    await app.read();
    await tick();
  }
}

test('H1: YP, a start that left before the stop is applied after it: the stop is sent again', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  const gated = gatedStart(net, ypStart);
  const { gladys, app } = await setup(t, {
    now,
    net,
    request: gated.request,
    config: { allow_start: true },
  });
  const start = press(gladys, zoneId(1), 'start');
  await tick();
  const stop = await press(gladys, controllerId(), 'stop');
  assert.equal(stop.success, true, stop.error);
  assert.ok(app.data.guards[YID].stop, 'the stop guard is not lifted while the start is out');
  gated.open();
  await start;
  assert.deepEqual(net.table[HOST].active, [0], 'the late start waters');
  await followUps(app, now, [5_000]);
  assert.deepEqual(events(net), [
    'AE_IRR_STOP_INST_TASK',
    'AE_IRR_START_INST',
    'AE_IRR_STOP_INST_TASK',
  ]);
  assert.deepEqual(net.table[HOST].active, []);
});

test('H1c: YP, the start answer times out after the stop, applied late: the stop is sent again', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  const gated = gatedStart(net, ypStart, { timeout: true });
  const { gladys, app } = await setup(t, {
    now,
    net,
    request: gated.request,
    config: { allow_start: true },
  });
  const start = press(gladys, zoneId(1), 'start');
  await tick();
  await press(gladys, controllerId(), 'stop');
  gated.open();
  const started = await start;
  assert.match(started.error, /sans confirmation/);
  await followUps(app, now, [5_000, 10_000, 15_000]);
  assert.deepEqual(net.table[HOST].active, []);
  assert.equal(events(net).at(-1), 'AE_IRR_STOP_INST_TASK');
});

test('H1b: YC, the start becomes a task only after the stop read the tasks: the stop is sent again', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  const gated = gatedStart(net, (o) => o.method === 'POST' && o.path === '/res/inst-program');
  const { gladys, app } = await setup(t, {
    now,
    net,
    request: gated.request,
    config: { address: YC_HOST, allow_start: true },
  });
  const start = press(gladys, zoneId(1, YC_ID), 'start');
  await tick();
  const stop = await press(gladys, controllerId(YC_ID), 'stop');
  assert.equal(stop.success, true, stop.error);
  assert.ok(app.data.guards[YC_ID].stop, 'an empty task list keeps the watch while a start is out');
  gated.open();
  await start;
  assert.equal(net.table[YC_HOST].tasks.length, 1);
  await followUps(app, now, [5_000, 10_000]);
  assert.deepEqual(net.table[YC_HOST].tasks, []);
  assert.equal(events(net).at(-1), 'PATCH /res/running-task/100?action=stop');
});

test('a start that left AFTER the stop is not stopped again', async (t) => {
  const now = clock();
  const { gladys, app, net } = await setup(t, { now, config: { allow_start: true } });
  await press(gladys, controllerId(), 'stop');
  const start = await press(gladys, zoneId(2), 'start');
  assert.equal(start.success, true, start.error);
  await followUps(app, now, [5_000, 10_000]);
  assert.deepEqual(net.table[HOST].active, [1]);
});

test('H4/M1/M7: known by yid only, then the serial only: stop goes, start refused, no merge', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  net.table[HOST].info = { name: 'Garden', model: 'PRO1902', yid: YID };
  const { gladys, app } = await setup(t, { now, net, config: { allow_start: true } });
  net.table[HOST].info = { name: 'Garden', model: 'PRO1902', serialNumber: 'SN0001' };
  net.table[HOST].active = [0];
  const stop = await press(gladys, controllerId(), 'stop');
  assert.equal(stop.success, true, stop.error);
  const start = await press(gladys, zoneId(2), 'start');
  assert.equal(start.success, false);
  assert.match(start.error, /identifiant sous lequel il est connu/);
  assert.deepEqual(events(net), ['AE_IRR_STOP_INST_TASK']);
  assert.equal(app.data.devices[YID].host, HOST, 'never "moved" on no proof');
  now.advance(30_000);
  await app.tick();
  assert.deepEqual(Object.keys(app.data.devices), [YID], 'no sn-… record');
  assert.equal(app.data.devices[YID].serial, undefined, 'merged only on proof');
  // A proof (the yid and the serial together): merged, and starts allowed.
  net.table[HOST].info = { name: 'Garden', model: 'PRO1902', yid: YID, serialNumber: 'SN0001' };
  now.advance(30_000);
  await app.tick();
  assert.equal(app.data.devices[YID].serial, 'SN0001');
  const later = await press(gladys, zoneId(2), 'start');
  assert.equal(later.success, true, later.error);
});

test('a yid that differs is another controller: stop refused, nothing sent', async (t) => {
  const net = fakeNetwork();
  const { gladys } = await setup(t, { net });
  net.table[HOST].info = { ...net.table[HOST].info, yid: 'other', serialNumber: 'SN9' };
  const stop = await press(gladys, controllerId(), 'stop');
  assert.equal(stop.success, false);
  assert.deepEqual(events(net), []);
});

test('M2: an answer without a model keeps the YC family', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  const { app } = await setup(t, { now, net, config: { address: YC_HOST } });
  net.table[YC_HOST].info = { ...net.table[YC_HOST].info, model: '' };
  now.advance(30_000);
  await app.tick();
  assert.equal(app.data.devices[YC_ID].family, 'yc');
  assert.equal(app.status.id, YC_ID);
});

test('H5/M3: YC with 33 running tasks and an unreadable one: the readable ones are stopped', async (t) => {
  const net = fakeNetwork();
  const { gladys } = await setup(t, { net, config: { address: YC_HOST } });
  net.table[YC_HOST].tasks = [
    { id: 'bad id!', output_id: 0 },
    ...Array.from({ length: 33 }, (_, i) => ({ id: 500 + i, output_id: i % 2 })),
  ];
  const stop = await press(gladys, controllerId(YC_ID), 'stop');
  assert.equal(stop.success, false, 'not all could be stopped: no confirmation');
  assert.equal(events(net).length, 32);
  assert.equal(net.table[YC_HOST].tasks.length, 2);
});

test('H6: YC tasks unreadable: refused unsent, then the next read sends the stop', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  const { gladys, app } = await setup(t, { now, net, config: { address: YC_HOST } });
  net.table[YC_HOST].tasks = [{ id: 7, output_id: 0 }];
  net.fail(YC_HOST, 'GET /res/running-task', new YardianError('timeout', { sent: true }));
  const stop = await press(gladys, controllerId(YC_ID), 'stop');
  assert.equal(stop.success, false);
  assert.match(stop.error, /n'ont pas pu être lus/);
  assert.ok(app.data.guards[YC_ID].stop);
  await followUps(app, now, [5_000]);
  assert.deepEqual(events(net), ['PATCH /res/running-task/7?action=stop']);
  assert.deepEqual(net.table[YC_HOST].tasks, []);
});

test('M6: the guards are on disk before the first byte', async (t) => {
  const net = fakeNetwork();
  let saved;
  const request = async (options) => {
    if (options.method !== 'GET') {
      saved = JSON.parse(JSON.stringify(app.store.data.guards ?? {}));
    }
    return net.request(options);
  };
  const { gladys, app } = await setup(t, { net, request, config: { allow_start: true } });
  await press(gladys, zoneId(1), 'start');
  assert.deepEqual(saved[YID].start.zones, [1]);
  await press(gladys, zoneId(1), 'stop');
  assert.deepEqual(saved[YID].stop.zones, [1]);
});

test('H16: YP, the start answer times out, the controller applies it 12 s later: the stop is sent again', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const request = async (options) => {
    if (ypStart(options)) {
      options.beforeSend?.();
      await gate;
      throw new YardianError('timeout', { sent: true });
    }
    return net.request(options);
  };
  const { gladys, app } = await setup(t, { now, net, request, config: { allow_start: true } });
  const start = press(gladys, zoneId(1), 'start');
  await tick();
  await press(gladys, controllerId(), 'stop');
  open();
  await start;
  await followUps(app, now, [5_000]);
  assert.ok(
    app.data.guards[YID].stop,
    'a dry read does not lift a guard armed by a start that may have left',
  );
  net.table[HOST].active = [0]; // applied late by the controller
  await followUps(app, now, [7_000]);
  assert.deepEqual(net.table[HOST].active, []);
  assert.deepEqual(events(net), ['AE_IRR_STOP_INST_TASK', 'AE_IRR_STOP_INST_TASK']);
  // Lifted by time only.
  await followUps(app, now, [60_000]);
  assert.equal(app.data.guards[YID]?.stop, undefined);
});

test('H18: YC, start answered 2xx at once, its task listed 3 s later, stop in between: stopped', async (t) => {
  const now = clock();
  const net = fakeNetwork();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const request = async (options) => {
    if (options.method === 'POST' && options.path === '/res/inst-program') {
      options.beforeSend?.();
      await gate;
      return { status: 200, headers: {}, body: Buffer.from('{}') };
    }
    return net.request(options);
  };
  const { gladys, app } = await setup(t, {
    now,
    net,
    request,
    config: { address: YC_HOST, allow_start: true },
  });
  const start = press(gladys, zoneId(1, YC_ID), 'start');
  await tick();
  const stop = await press(gladys, controllerId(YC_ID), 'stop');
  assert.equal(stop.success, true, stop.error);
  open();
  await start;
  now.advance(3_000);
  net.table[YC_HOST].tasks.push({ id: 300, output_id: 0 });
  await followUps(app, now, [2_000, 10_000, 15_000]);
  assert.deepEqual(
    net.commands().map((c) => `${c.method} ${c.path}`),
    ['PATCH /res/running-task/300?action=stop'],
  );
  assert.deepEqual(net.table[YC_HOST].tasks, []);
});

test('N1: a stop guard armed again is read at 5, 15, 30 and 55 s, within its minute', async (t) => {
  const delays = [];
  const recording = {
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (_fn, ms) => {
      delays.push(ms);
      return 1;
    },
    clearTimeout: () => {},
  };
  const net = fakeNetwork();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { address: HOST, access_token: TOKEN },
    devices: [],
  });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new YardianApp({
    gladys,
    logger,
    client: new YardianClient({ request: net.request }),
    store: new MemoryStore(),
    timers: recording,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  delays.length = 0;
  await press(gladys, controllerId(), 'stop');
  const followUps = delays.filter((ms) => ms >= 5000);
  assert.deepEqual(followUps, [5000, 15_000, 30_000, 55_000]);
  assert.ok(Math.max(...followUps) < 60_000);
});
