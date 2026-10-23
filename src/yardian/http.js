// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP request to a
// Yardian controller on node:http (the controllers speak no TLS). A deadline
// for the whole exchange, a size cap on the body, no redirect followed, no
// keep-alive, one connection per request. Resolves { status, headers, body }
// for any status; rejects a YardianError for the transport failures, with
// `sent` true as soon as the connection was up (the request may then have
// reached the controller). `sendWithin`: the connection must be up within
// this many ms, else nothing is written (a command never leaves late).
// `beforeSend`: the last check of a command, once connected, right before the
// first byte is written. The headers carry the access token: they are never
// put in an error nor a log line. Adapted from LM1LC3N7/gladys-opengarage
// (same author, Apache-2.0).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { YardianError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) {
    return new YardianError('invalid', { sent });
  }
  // Only our own words: a system message may carry an address.
  return new YardianError('unreachable', { sent });
}

/**
 * @param {object} options
 * @param {string} options.method GET, POST or PATCH
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.path
 * @param {Record<string, string>} [options.headers]
 * @param {Buffer} [options.body]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] if it throws, nothing is sent and
 *   its error is passed on with `beforeSend` set
 * @param {AbortSignal} [options.signal] aborted before the connection is up:
 *   'cancelled', nothing sent; ignored once the request may have left
 */
export function httpRequest({
  method = 'GET',
  host,
  port,
  path,
  headers = {},
  body,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
  signal,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    // Until the connection is up, nothing of the request has left.
    let connected = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new YardianError('timeout', { sent: connected })),
      Math.max(0, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new YardianError('late'));
              }
            },
            Math.max(0, sendWithin),
          );
    // Cancelled while the connection is not up yet: nothing has left, the
    // attempt is dropped at once (a request already sent is never aborted).
    const onAbort = () => {
      if (!connected) {
        finish(new YardianError('cancelled'));
      }
    };
    if (signal?.aborted) {
      finish(new YardianError('cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      req.end(body);
    };

    try {
      req = http.request({
        method,
        host,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json',
          host: port === 80 ? host : `${host}:${port}`,
          connection: 'close',
          ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
          ...headers,
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new YardianError('tooLarge', { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err, true)));
      });
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markConnected();
        } else {
          socket.once('connect', markConnected);
        }
      });
      req.on('error', (err) => finish(transportError(err, connected)));
    } catch (err) {
      // http.request throws on a path or a header it refuses: a failure, never a crash.
      finish(transportError(err, false));
    }
  });
}
