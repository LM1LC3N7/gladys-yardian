// -----------------------------------------------------------------------------
// The local HTTP API of a Yardian controller (plain HTTP, no cloud), ported
// from pyyardian 1.4.2 (MIT, Aeon Matrix, the library of the Home Assistant
// integration). Every request carries the access token in the
// `Yardian-Token` header.
//
//   both families   GET  :880/API_GET_DEVICEINFO        name, model, serialNumber, yid
//   YP (port 880)   GET  /API_MGR_GET_OPERINFO          zones, iRainDelay, iStandby...
//                   GET  /API_ZONE_GET_OPENINGZONE      the zones watering now
//                   POST /  {sEvent: AE_IRR_START_INST, sPayload: "[[-1, 0, 0, zone, s]]"}
//                   POST /  {sEvent: AE_IRR_STOP_INST_TASK}   stops every zone
//   YC (port 80)    GET  /res/controller                rain delay...
//                   GET  /res/sch-setting               standby_mode
//                   GET  /res/output-setting            the zones (names)
//                   GET  /res/running-task              [{id, output_id}]
//                   POST /res/inst-program  {output_durs: [[zone, s]], store: false}
//                   PATCH /res/running-task/<id>?action=stop
//
// An answer `{"iCode": -1000}` means the token was refused. Every answer is
// size-capped and parsed once.
// -----------------------------------------------------------------------------

import { FAMILY, LIMITS, PORTS, TIMINGS, TOKEN_REFUSED_CODE } from '../constants.js';
import { YardianError } from './errors.js';
import { httpRequest } from './http.js';

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The `Date` header of an answer in ms, or undefined (the clock of the controller). */
export function dateOf(header) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : undefined;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The `iCode` of an answer object, when it has one. */
const codeOf = (data) =>
  isObject(data) && Object.hasOwn(data, 'iCode') && Number.isInteger(data.iCode)
    ? data.iCode
    : undefined;

/** pyyardian: `resp.get("result", resp)`. */
export const resultOf = (data) =>
  isObject(data) && Object.hasOwn(data, 'result') ? data.result : data;

/** A task id of a YC controller as it may travel in a path. */
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class YardianClient {
  constructor({ request = httpRequest, timeout = TIMINGS.requestTimeout, now = Date.now } = {}) {
    this.request = request;
    this.timeout = timeout;
    this.now = now;
  }

  /**
   * One exchange.
   * @returns {Promise<{ data: any, date: number | undefined }>} the JSON answered
   *   (null for an empty body) and the clock of the controller
   */
  async call(host, port, method, path, token, options = {}) {
    const { body, timeout, sendWithin, beforeSend, signal } = options;
    const answer = await this.request({
      method,
      host,
      port,
      path,
      headers: token ? { 'Yardian-Token': token } : {},
      body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)),
      timeout: timeout ?? this.timeout,
      sendWithin,
      maxBytes: LIMITS.responseBytes,
      beforeSend,
      signal,
    });
    const { status } = answer;
    if (status === 429 || (status >= 500 && status <= 599)) {
      throw new YardianError('busy', {
        status,
        sent: true,
        retryAfter: retryAfterOf(answer.headers?.['retry-after'], this.now()),
      });
    }
    if (status === 401 || status === 403) {
      throw new YardianError('token', { status, sent: true });
    }
    if (status < 200 || status > 299) {
      throw new YardianError('http', { status, sent: true });
    }
    const text = answer.body.toString('utf8').trim();
    let data = null;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        throw new YardianError('invalid', { sent: true });
      }
    }
    if (codeOf(data) === TOKEN_REFUSED_CODE) {
      throw new YardianError('token', { sent: true, code: TOKEN_REFUSED_CODE });
    }
    return { data, date: dateOf(answer.headers?.date) };
  }

  /** The identity: name, model, serialNumber, yid. */
  async deviceInfo(host, token, options) {
    const { data, date } = await this.call(
      host,
      PORTS.INFO,
      'GET',
      '/API_GET_DEVICEINFO',
      token,
      options,
    );
    return { info: resultOf(data), date };
  }

  /** YP: zones, rain delay, standby. */
  async ypOperInfo(host, token, options) {
    const { data, date } = await this.call(
      host,
      PORTS.YP,
      'GET',
      '/API_MGR_GET_OPERINFO',
      token,
      options,
    );
    return { oper: resultOf(data), date };
  }

  /** YP: the zone ids watering now. */
  async ypActiveZones(host, token, options) {
    const { data } = await this.call(
      host,
      PORTS.YP,
      'GET',
      '/API_ZONE_GET_OPENINGZONE',
      token,
      options,
    );
    return resultOf(data);
  }

  /** YC: the controller variables. */
  async ycController(host, token, options) {
    const { data, date } = await this.call(
      host,
      PORTS.YC,
      'GET',
      '/res/controller',
      token,
      options,
    );
    return { oper: resultOf(data), date };
  }

  /** YC: the schedule settings (standby_mode). */
  async ycScheduleSettings(host, token, options) {
    const { data } = await this.call(host, PORTS.YC, 'GET', '/res/sch-setting', token, options);
    return resultOf(data);
  }

  /** YC: the zones (outputs) and their names. */
  async ycOutputs(host, token, options) {
    const { data } = await this.call(host, PORTS.YC, 'GET', '/res/output-setting', token, options);
    return resultOf(data);
  }

  /** YC: the running tasks, `[{ id, output_id }]`. */
  async ycRunningTasks(host, token, options) {
    const { data } = await this.call(host, PORTS.YC, 'GET', '/res/running-task', token, options);
    return resultOf(data);
  }

  /** The zones watering now, by family (raw: parsed by parse.js). */
  activeZones(host, family, token, options) {
    return family === FAMILY.YC
      ? this.ycRunningTasks(host, token, options)
      : this.ypActiveZones(host, token, options);
  }

  /** A 2xx answer of a command with a negative iCode: not taken. */
  static checkCommand(data) {
    const code = codeOf(data);
    if (code !== undefined && code < 0) {
      throw new YardianError('refused', { sent: true, code });
    }
  }

  /** Starts one zone (`zone`: its 0-based id) for `seconds`. */
  async startZone(host, family, token, zone, seconds, options = {}) {
    if (!Number.isInteger(zone) || zone < 0 || !Number.isInteger(seconds) || seconds <= 0) {
      throw new YardianError('invalid');
    }
    const request =
      family === FAMILY.YC
        ? {
            port: PORTS.YC,
            path: '/res/inst-program',
            body: { output_durs: [[zone, seconds]], store: false },
          }
        : {
            port: PORTS.YP,
            path: '/',
            body: { sEvent: 'AE_IRR_START_INST', sPayload: `[[-1, 0, 0, ${zone}, ${seconds}]]` },
          };
    const { data } = await this.call(host, request.port, 'POST', request.path, token, {
      ...options,
      body: request.body,
    });
    YardianClient.checkCommand(data);
  }

  /** YP: stops every zone (the YP API has no stop by zone). */
  async ypStop(host, token, options = {}) {
    const { data } = await this.call(host, PORTS.YP, 'POST', '/', token, {
      ...options,
      body: { sEvent: 'AE_IRR_STOP_INST_TASK' },
    });
    YardianClient.checkCommand(data);
  }

  /** YC: stops one running task. */
  async ycStopTask(host, token, taskId, options = {}) {
    const id = String(taskId ?? '');
    if (!TASK_ID.test(id)) {
      throw new YardianError('invalid');
    }
    const { data } = await this.call(
      host,
      PORTS.YC,
      'PATCH',
      `/res/running-task/${encodeURIComponent(id)}?action=stop`,
      token,
      options,
    );
    YardianClient.checkCommand(data);
  }
}
