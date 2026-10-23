// -----------------------------------------------------------------------------
// The pure parts: configuration, parsing of the answers, /data sanitizing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress } from '../src/config.js';
import { MemoryStore, sanitize } from '../src/store.js';
import {
  identityOf,
  rainDelayOf,
  sameController,
  standbyOf,
  ycTasksOf,
  ypActiveOf,
  ypZonesOf,
} from '../src/yardian/parse.js';

test('the address: a host, a pasted URL reduced, credentials refused', () => {
  assert.equal(parseAddress(' 192.168.1.60 '), '192.168.1.60');
  assert.equal(parseAddress('http://192.168.1.60:880/API_GET_DEVICEINFO'), '192.168.1.60');
  assert.equal(parseAddress('yardian.local'), 'yardian.local');
  assert.equal(parseAddress('user:pw@192.168.1.60'), undefined);
  assert.equal(parseAddress('999.1.1.1'), undefined);
  assert.equal(parseAddress('__proto__'), undefined);
});

test('the configuration: start off unless exactly true, bounds, token problems', () => {
  const c = normalizeConfig({ address: '10.0.0.2', access_token: ' abc ', allow_start: 'yes' });
  assert.equal(c.allowStart, false);
  assert.equal(c.token, 'abc');
  assert.equal(c.wateringMinutes, 10);
  assert.equal(c.pollInterval, 30);
  assert.equal(normalizeConfig({ allow_start: true }).allowStart, true);
  assert.equal(normalizeConfig({ watering_minutes: 0 }).wateringMinutes, 1);
  assert.equal(normalizeConfig({ watering_minutes: '' }).wateringMinutes, 10);
  assert.equal(normalizeConfig({ poll_interval: 1 }).pollInterval, 10);
  assert.equal(normalizeConfig({}).tokenProblem, 'missing');
  assert.equal(normalizeConfig({ access_token: 'a b' }).tokenProblem, 'invalid');
  assert.equal(normalizeConfig({ address: 'x@y?k=1' }).invalidAddress, '…@y…');
});

test('identity: the yid, else sn-<serial>; unreadable without both', () => {
  const id = identityOf({ yid: 'Y1', serialNumber: 'S1', model: 'PRO1902C1', name: 'G\u0007' });
  assert.deepEqual(id, {
    id: 'Y1',
    yid: 'Y1',
    serial: 'S1',
    model: 'PRO1902C1',
    family: 'yc',
    name: 'G',
  });
  assert.equal(identityOf({ serialNumber: 'S1', model: 'PRO1902' }).id, 'sn-S1');
  assert.equal(identityOf({ yid: 'a/b' }).id, undefined);
  assert.equal(identityOf(null).id, undefined);
  assert.equal(identityOf({ model: 'YDN1600' }).family, 'yp');
  assert.ok(sameController({ yid: 'Y1' }, { yid: 'Y1' }));
  assert.ok(!sameController({ yid: 'Y2', serial: 'S1' }, { yid: 'Y1', serial: 'S1' }));
  assert.ok(sameController({ serial: 'S1' }, { yid: 'Y1', serial: 'S1' }));
  assert.ok(!sameController({}, {}));
});

test('zones and zones watering: checked, capped, never guessed', () => {
  const zones = ypZonesOf({ zones: [['A', 1], ['B', 0], 'junk', [null, 1]] }, 'PRO1906');
  assert.deepEqual(zones, [
    { index: 0, number: 1, name: 'A', enabled: true },
    { index: 1, number: 2, name: 'B', enabled: false },
    { index: 2, number: 3, name: 'Zone 3', enabled: false },
    { index: 3, number: 4, name: 'Zone 4', enabled: true },
  ]);
  assert.equal(ypZonesOf({}, 'PRO1906'), undefined);
  assert.deepEqual([...ypActiveOf([0, 3])], [0, 3]);
  assert.equal(ypActiveOf([0, 'x']), undefined);
  assert.equal(ypActiveOf({}), undefined);
  assert.deepEqual(ycTasksOf([{ id: 7, output_id: 1 }]), {
    active: new Set([1]),
    tasks: [{ id: '7', zone: 1 }],
  });
  assert.equal(ycTasksOf([{ id: '../x', output_id: 1 }]), undefined);
});

test('standby and rain delay: an epoch end needs the clock of the controller', () => {
  const date = Date.parse('2026-10-22T10:00:00Z');
  const epoch = Math.floor(date / 1000);
  assert.equal(standbyOf(0), false);
  assert.equal(standbyOf(2147483647), true);
  assert.equal(standbyOf(epoch + 60, date), true);
  assert.equal(standbyOf(epoch - 60, date), false);
  assert.equal(standbyOf(epoch + 60, undefined), undefined, 'never "expired" without a clock');
  assert.equal(standbyOf('x'), undefined);
  assert.equal(rainDelayOf({ iRainDelay: 7200 }), 120);
  assert.equal(rainDelayOf({ iRainDelay: epoch + 90 }, date), 2);
  assert.equal(rainDelayOf({ iRainDelay: epoch + 90 }), undefined);
  assert.equal(rainDelayOf({}), undefined);
});

test('/data: checked on load, no prototype pollution, bounds from now', async () => {
  const now = 1_800_000_000_000;
  const data = sanitize(
    JSON.parse(
      '{"salt":"00112233445566778899aabbccddeeff","__proto__":{"polluted":1},' +
        '"devices":{"__proto__":{"id":"__proto__"},"Y1":{"id":"Y1","host":"10.0.0.2","family":"yp",' +
        '"zones":[{"number":1,"name":"A","enabled":true},{"number":1},{"number":99}]},' +
        '"Y2":{"id":"Y2","host":"x@y","family":"yp"}},' +
        '"pause":{"host":"10.0.0.2","until":9e15,"failures":3},' +
        '"guards":{"Y1":{"start":{"zones":[1],"at":9e15,"until":9e15},"stop":{"zones":"all","until":0}}}}',
    ),
    now,
  );
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(data.devices), ['Y1']);
  assert.deepEqual(data.devices.Y1.zones, [{ number: 1, name: 'A', enabled: true }]);
  assert.equal(data.pause.until, now + 6 * 3600_000);
  assert.equal(data.guards.Y1.start.at, now);
  assert.equal(data.guards.Y1.start.until, now + 60_000);
  assert.equal(data.guards.Y1.stop.zones, 'all');
  const store = new MemoryStore(data, () => now);
  assert.deepEqual(await store.load(), data);
});
