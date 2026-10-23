# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15). It reads
a **Yardian** sprinkler controller over its local HTTP API (an access token in
the `Yardian-Token` header) and exposes the controller and its zones as Gladys
devices, with start and stop buttons. Unofficial: not affiliated with Aeon
Matrix or Yardian. Ported from pyyardian 1.4.2 (MIT), see
THIRD_PARTY_NOTICES.md.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npm run cover                             # regenerates cover.png (800×534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit. The tests
must pass on Node 22 and 24 (the CI runs both).

## Architecture

```
index.js                SDK wiring only
src/handlers.js         the SDK handlers (shared with the tests)
src/app.js              YardianApp: reads, devices, status, start / stop, Check button
src/yardian/client.js   the endpoints of the two API families, request bodies
src/yardian/http.js     the only network access (node:http, deadline, size cap, beforeSend)
src/yardian/parse.js    answers -> identity, zones, zones watering (pure)
src/yardian/errors.js   YardianError kinds
src/model.js            the Gladys devices, feature keys, values (pure)
src/store.js            /data: known controllers, pauses, refused tokens, guards
src/publisher.js        states within 300/min
src/config.js           config_schema normalized
src/constants.js        API facts, limits, timings, manifest keys
src/i18n.js             runtime texts (en/fr)
test/helpers/           fake controllers behind the client's `request`
```

## Rules

- **Unofficial.** Every user-facing surface says it. Never use the Yardian
  logo.
- **Keys are forever**: manifest keys, external id types (`yardian`,
  `yardian-zone`), the identity rule (yid, else `sn-<serial>`), feature keys
  (`src/model.js`). Never rename them.
- **The token is a secret**: only in the `Yardian-Token` header to the typed
  address; never in a URL, a log line, an error, a status or /data (only a
  salted fingerprint of a REFUSED token, removed at the first success).
- **Starting a zone opens a valve**: off by default, never a switch, decided
  on a fresh read, option checked again in `beforeSend`, capped length.
  **Stopping is never held** by the option, a pause, a refused token or a
  guard; the few cases where it is refused unsent are listed in the docs and
  in the header of `src/app.js`, and must stay documented exactly.
- **Never read sooner than the interval** (restart included); 429/5xx and
  refused tokens are persisted, never retried in a loop.
- **Built blind**: no controller was available. Every endpoint lives in
  `src/yardian/client.js`, every field name in `src/yardian/parse.js`;
  `TODO.md` lists what to confirm.
- **Read-only rootfs**: write nothing outside /data.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag
  (0.1.0 was set once by hand).
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync; the secret field says "kept by Gladys in its database, never shown
  again" (never "encrypted": Gladys stores it in clear).
- **Tests never touch the network** except `test/http.test.js` (a local
  server on 127.0.0.1).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
