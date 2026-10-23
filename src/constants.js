// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, the
// Yardian API facts, limits and timings.
// -----------------------------------------------------------------------------

/** External id types: `gladys.externalIds(type, platformId)`. Frozen. */
export const EXTERNAL_ID_TYPES = {
  CONTROLLER: 'yardian',
  ZONE: 'yardian-zone',
};

/** Manifest `actions` keys. */
export const ACTIONS = {
  CHECK: 'check_controller',
};

// Gladys core enum (server/utils/constants.js), not exported by the SDK.
export const BUTTON_PUSH = { PRESSED: 1 };

/**
 * The two API families of the Yardian controllers (pyyardian 1.4.2): the
 * "YP" ones (model without a C<n> suffix) answer on port 880 with the
 * `API_*` endpoints; the "YC" ones (model ending in C<n>, e.g. PRO1900C1)
 * answer on port 80 with the `/res/*` endpoints. API_GET_DEVICEINFO is on
 * port 880 for both.
 */
export const FAMILY = { YP: 'yp', YC: 'yc' };
export const PORTS = { INFO: 880, YP: 880, YC: 80 };

/** Zones per model (pyyardian const.py); a C<n> model has the zones of its base. */
export const MODEL_ZONES = {
  YDN1600: 12,
  YDN1602: 8,
  PRO1600: 12,
  PRO1602: 8,
  PRO1900: 12,
  PRO1902: 8,
  PRO1906: 6,
};

/** `iCode` of an answer whose token was refused (pyyardian: NotAuthorizedException). */
export const TOKEN_REFUSED_CODE = -1000;

/** Watering length of a zone started from Gladys, in minutes. */
export const WATERING_MINUTES = { default: 10, min: 1, max: 60 };

/** Configuration bounds of the refresh interval, in seconds (mirrored by the manifest). */
export const POLL_INTERVAL = { default: 30, min: 10, max: 600 };

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Zones read from one controller (the largest model has 12). */
  zones: 32,
  /** Controllers remembered in /data (one typed address; the previous ones keep their device). */
  devices: 8,
  /** Body of a controller answer (a few kB). */
  responseBytes: 64 * 1024,
  /** Running tasks of a YC controller stopped by one command. */
  tasks: 32,
};

export const TIMINGS = {
  /** One HTTP request of the polling. */
  requestTimeout: 5000,
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** Measurements of a same feature are spaced by this much (none here is a measure). */
  measureInterval: 60_000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** Saving /data waits this long for more changes. */
  persistDelay: 1000,
  /** The time of the last read is written to /data at most this often. */
  lastTrySave: 60_000,
  /**
   * A command leaves within this many ms of its arrival, or is refused
   * unsent: Gladys gives up waiting for the ack after 5 s.
   */
  commandSendBy: 3500,
  /** The ack is given by then: past it, "sent, without confirmation". */
  commandAnswerBy: 4300,
  /** The identity read before a stop: short, a stop never waits long for it. */
  stopIdentityTimeout: 1200,
  /**
   * Reads after a command (a valve opens or closes within seconds); the last
   * one falls inside the 60 s a stop guard watches (a start applied late).
   */
  followUps: [5000, 15_000, 30_000, 55_000],
  /**
   * After a start that may have left, no other start on the controller until
   * a read sent after it shows the zone watering, or this long after it.
   */
  startGuard: 60_000,
  /**
   * After a stop, the follow-up reads that still see the zones watering send
   * the stop again (unless a start really left after it), for this long.
   */
  stopGuard: 60_000,
  /** A start that left is waited for that long at most (it settles by its answer deadline). */
  inFlightMax: 10_000,
  /** A stop is sent again at most this many times. */
  stopResends: 3,
  /** Transient failures: the next reads, never sooner than the interval. */
  backoff: [30_000, 60_000, 120_000, 300_000],
  /** A start refused for its token: the next starts allowed after these, then every 24 h. */
  tokenRetries: [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000],
  /** HTTP 429 or 5xx: a pause within these bounds. */
  pauseMin: 60_000,
  pauseMax: 6 * 60 * 60_000,
  /** An epoch value (standby end, rain delay end) is above this many seconds. */
  absoluteThreshold: 365 * 24 * 3600,
};
