// -----------------------------------------------------------------------------
// The failures of a request to a controller, by kind. Messages are our own
// words only: never an address, a header (it carries the token) or a body.
// -----------------------------------------------------------------------------

/**
 * - timeout:     no complete answer in time
 * - unreachable: no connection, or a connection lost
 * - late:        a command could not leave before its deadline (nothing sent)
 * - cancelled:   cancelled before its connection was up (nothing sent)
 * - busy:        HTTP 429 or 5xx, the controller asks for a pause
 * - token:       the access token refused (HTTP 401/403, or iCode -1000)
 * - http:        another HTTP status
 * - refused:     a 2xx answer with a negative iCode (the command not taken)
 * - invalid:     not the JSON a Yardian controller answers
 * - tooLarge:    the answer exceeds the size cap
 */
export class YardianError extends Error {
  constructor(kind, { status, sent = false, retryAfter, code } = {}) {
    super(status ? `${kind} (HTTP ${status})` : code !== undefined ? `${kind} (${code})` : kind);
    this.name = 'YardianError';
    this.kind = kind;
    this.status = status;
    this.sent = sent;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

/** A short reason for the logs and the user: the kind, and the status if any. */
export const reasonOf = (err) => (err instanceof YardianError ? err.message : 'unexpected error');
