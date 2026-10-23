// -----------------------------------------------------------------------------
// Fake Yardian controllers behind the `request` of YardianClient
// (src/yardian/http.js replaced): answers shaped after pyyardian 1.4.2, the
// commands changing the zones watering, a log of every call, and hooks to make
// a request slow or fail. No network.
// -----------------------------------------------------------------------------

import { YardianError } from '../../src/yardian/errors.js';

export const TOKEN = 'FCE25479';
export const HOST = '192.168.1.60';
export const YID = 'yid0001';

const zone = (name, enabled = 1) => [name, enabled, 0, 0];

/** A YP controller (port 880 API) and, at `.61`, a YC one (port 80 API). */
export function controllers() {
  return {
    [HOST]: {
      token: TOKEN,
      info: { name: 'Garden', model: 'PRO1902', serialNumber: 'SN0001', yid: YID },
      oper: {
        zones: [
          zone('Lawn'),
          zone('Roses'),
          zone('Unused', 0),
          zone('Hedge'),
          zone('Z5'),
          zone('Z6'),
          zone('Z7'),
          zone('Z8'),
          zone('beyond the model'),
        ],
        iRainDelay: 0,
        iStandby: 0,
      },
      active: [],
    },
    '192.168.1.61': {
      token: TOKEN,
      info: { name: 'Back', model: 'PRO1906C1', serialNumber: 'SN0002', yid: 'yid0002' },
      controller: { iRainDelay: 7200 },
      settings: { standby_mode: false },
      outputs: [{ name: 'Front' }, { name: 'Side' }],
      tasks: [],
      nextTask: 100,
    },
  };
}

/** Waits for `promise` like a connection: late after `sendWithin`, cancelled on abort. */
function waitConnection(promise, { sendWithin, signal }) {
  return new Promise((resolve, reject) => {
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => done(new YardianError('cancelled'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);
    if (sendWithin !== undefined) {
      timer = setTimeout(() => done(new YardianError('late')), Math.max(0, sendWithin));
    }
    promise.then(() => done());
  });
}

/**
 * The `request` of YardianClient over the fake controllers.
 * - `hold(host, key)`: the next request matching waits for `release()`
 *   (before its connection: `sendWithin` and the signal apply);
 * - `fail(host, key, error | { status, headers, body }, { before })`: the
 *   next one fails; `before`: before the connection (nothing sent);
 * - `takes: false` on a controller: commands answered 200 but not applied.
 * `key` is "METHOD path" (prefix match).
 */
export function fakeNetwork(table = controllers()) {
  const calls = [];
  const holds = [];
  const failures = [];
  const matches = (entry, host, key) =>
    entry.host === host && key.startsWith(entry.key) && !entry.used;
  const request = async (options) => {
    const { method, host, port, path, headers, body, beforeSend } = options;
    const key = `${method} ${path}`;
    const hold = holds.find((h) => matches(h, host, key));
    if (hold) {
      hold.used = true;
      await waitConnection(hold.promise, options);
    }
    const device = table[host];
    if (!device) {
      throw new YardianError('unreachable');
    }
    const early = failures.find((f) => matches(f, host, key) && f.before);
    if (early) {
      early.used = true;
      throw early.error;
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        err.sent = false;
        throw err;
      }
    }
    calls.push({ host, port, method, path, headers, body: body?.toString('utf8') });
    const failure = failures.find((f) => matches(f, host, key) && !f.before);
    if (failure) {
      failure.used = true;
      if (failure.error) {
        throw failure.error;
      }
      return {
        status: failure.status ?? 200,
        headers: failure.headers ?? {},
        body: Buffer.from(failure.body ?? ''),
      };
    }
    const json = (value, extra = {}) => ({
      status: 200,
      headers: { date: device.date ?? new Date().toUTCString(), ...extra },
      body: Buffer.from(JSON.stringify(value)),
    });
    if (headers?.['Yardian-Token'] !== device.token) {
      return json({ iCode: -1000 });
    }
    const yc = /C\d+$/.test(device.info.model);
    if (port === 880 && key === 'GET /API_GET_DEVICEINFO') {
      return json({ result: device.info });
    }
    const parsed = body ? JSON.parse(body.toString('utf8')) : undefined;
    if (!yc && port === 880) {
      if (key === 'GET /API_MGR_GET_OPERINFO') return json({ result: device.oper });
      if (key === 'GET /API_ZONE_GET_OPENINGZONE') return json({ result: device.active });
      if (key === 'POST /' && parsed?.sEvent === 'AE_IRR_START_INST') {
        const [[, , , zoneId]] = JSON.parse(parsed.sPayload);
        if (device.takes !== false && !device.active.includes(zoneId)) {
          device.active.push(zoneId);
        }
        return json({ iCode: 0 });
      }
      if (key === 'POST /' && parsed?.sEvent === 'AE_IRR_STOP_INST_TASK') {
        if (device.takes !== false) device.active = [];
        return json({ iCode: 0 });
      }
    }
    if (yc && port === 80) {
      if (key === 'GET /res/controller') return json(device.controller);
      if (key === 'GET /res/sch-setting') return json(device.settings);
      if (key === 'GET /res/output-setting') return json(device.outputs);
      if (key === 'GET /res/running-task') return json(device.tasks);
      if (key === 'POST /res/inst-program') {
        const [[output]] = parsed.output_durs;
        if (device.takes !== false) {
          device.tasks.push({ id: device.nextTask, output_id: output });
          device.nextTask += 1;
        }
        return json({});
      }
      const stop = /^PATCH \/res\/running-task\/([^?]+)\?action=stop$/.exec(key);
      if (stop) {
        if (device.takes !== false) {
          device.tasks = device.tasks.filter((t) => String(t.id) !== stop[1]);
        }
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
    }
    return { status: 404, headers: {}, body: Buffer.from('not found') };
  };
  return {
    request,
    calls,
    table,
    hold(host, key) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      holds.push({ host, key, promise });
      return release;
    },
    fail(host, key, failure, { before = false } = {}) {
      failures.push({
        host,
        key,
        before,
        ...(failure instanceof Error ? { error: failure } : failure),
      });
    },
    commands: () => calls.filter((c) => c.method !== 'GET'),
    reads: () => calls.filter((c) => c.method === 'GET'),
  };
}
