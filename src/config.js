// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The access token
// is kept here only: never logged, never in /data, never in a status or an
// error (only a salted fingerprint of a token the controller REFUSED is kept
// in /data, removed at the first success).
// -----------------------------------------------------------------------------

import { POLL_INTERVAL, WATERING_MINUTES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  address: '',
  allow_start: false,
  watering_minutes: WATERING_MINUTES.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** The optional fields without a default in the manifest (the token is a secret). */
const OPTIONAL = { access_token: '' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** An access token as the Yardian app shows it: printable ASCII without spaces. */
const TOKEN = /^[\x21-\x7e]{1,128}$/;

/** A text read from a controller, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * The address typed by the user: an IPv4 address or a host name. A pasted URL
 * ("http://192.168.1.30:880/") is reduced to its host; the port is dropped
 * (the controller answers on fixed ports, 880 and 80); credentials in it are
 * refused (the token belongs in its field).
 * @returns {string | undefined}
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  text = text.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  if (text.includes('@')) {
    return undefined;
  }
  const match = /^([^:]+)(?::\d{1,5})?$/.exec(text.toLowerCase());
  if (!match) {
    return undefined;
  }
  const host = match[1];
  if (host.length > 253) {
    return undefined;
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? host : undefined;
}

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  const token = typeof c.access_token === 'string' ? c.access_token.trim() : '';
  let tokenProblem;
  if (token === '') {
    tokenProblem = 'missing';
  } else if (!TOKEN.test(token)) {
    tokenProblem = 'invalid';
  }
  return {
    address,
    /** Shown in the status when it is not an address: cut at an '@' and a query. */
    invalidAddress:
      typed !== '' && !address
        ? typed
            .replace(/^.*@/, '…@')
            .replace(/[?#].*$/, '…')
            .slice(0, 60)
        : undefined,
    /** The access token, or undefined (none, or unusable: said in the status). */
    token: tokenProblem ? undefined : token,
    tokenProblem,
    allowStart: strictTrue(c.allow_start),
    wateringMinutes: bounded(c.watering_minutes, WATERING_MINUTES),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/**
 * What changes the controller asked or the commands sent: a new value starts
 * a new generation (compared in memory only, never stored).
 */
export const generationKey = (config) => JSON.stringify([config.address ?? '', config.token ?? '']);
