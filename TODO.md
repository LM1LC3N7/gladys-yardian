# TODO

## To confirm on a real controller

- [ ] The answer of `API_GET_DEVICEINFO`: is `yid` always there (the
      external ids are built from it, `sn-<serialNumber>` otherwise)?
- [ ] The answer of the YP start and stop commands (`POST /` with `sEvent`):
      a JSON with `iCode` 0? Anything else than -1000 for a refused token?
- [ ] Does a token refused answer HTTP 200 with `{"iCode": -1000}` on every
      endpoint, or a 401/403 too?
- [ ] `API_ZONE_GET_OPENINGZONE`: 0-based zone ids, as pyyardian and Home
      Assistant use them?
- [ ] YC (C1 models): `output_id` of `/res/running-task` 0-based like the
      `output_durs` of `/res/inst-program`? The answer of the PATCH stop?
      Where is the rain delay (`iRainDelay` in `/res/controller`)?
- [ ] `iStandby` and `iRainDelay`: epoch ends or seconds left? Does the
      controller send a `Date` header (needed for an epoch end)?
- [ ] Does `AE_IRR_STOP_INST_TASK` also stop a run started by a schedule of
      the controller, or only an instant one?
- [ ] Does the controller answer while a zone starts (time to open the valve:
      the confirmation read comes about 0.5 s after the command)?

## Later

- [ ] Several controllers (one address and one token each).
- [ ] Scene actions (water a zone for N minutes, stop), scene triggers
      (watering started / finished), a dashboard widget.
- [ ] Rain delay and standby commands (a rain delay is protective, ending a
      standby is not: off by default).
- [ ] The schedules of the controller.

## Decisions

- Version 0.1.0 set by hand in package.json, package-lock.json, the manifest
  and the `docker_image` tag; the first Release (patch) gives 0.1.1.
- Reference ported: pyyardian 1.4.2 (MIT, Aeon Matrix, the manufacturer; the
  library of Home Assistant), checked in its LICENSE. Home Assistant's Yardian
  integration (Apache-2.0) for the meaning of `yid`, `iRainDelay`, `iStandby`.
  Neighbour followed: LM1LC3N7/gladys-rachio (the domain), with the command
  safety of LM1LC3N7/gladys-opengarage (approved, published).
- Identity rule (frozen, it fixes the external ids): the `yid`, or
  `sn-<serialNumber>` when there is no yid; the same controller is recognized
  by its yid, or by its serial when one side has no yid. Only a differing yid
  (or serial, when one side has no yid) is "another controller"; an answer
  with no field in common with the record (a yid on one side, a serial on the
  other) at its address proves nothing: its states are taken for the record
  there, a stop is sent, a start is refused, and the identifiers are merged
  only on proof (review 1 M1, approval 1 M7). An answer with neither is a failed read. Checked at every read and
  before every command. An answer without a model keeps the known API family
  (M2).
- External ids: `yardian:<id>` for the controller, `yardian-zone:<id>-<n>` for
  zone n (1-based, the API id is n - 1). Feature keys: `watering`,
  `current_zone`, `rain_delay`, `standby`, `stop`; zone: `watering`, `start`,
  `stop`.
- Commands are buttons (`button`/`push`), the states read-only
  `unknown`/`binary`: no "turn everything on/off" reaches a valve.
- Start = sensitive (opens a valve): off by default, option checked on
  arrival, after the fresh reads and in `beforeSend`; sent within 3.5 s;
  one queue per controller; a guard (start kind) saved to /data (awaited)
  before the connection, its request number set in `beforeSend`, lifted by a
  read sent after it showing the zone watering, or 60 s (a second start is
  refused at once meanwhile); refused by the controller (token, 4xx, 429, negative iCode): no
  guard, never counts as a newer start; 5xx or silence: "sent, without
  confirmation", the guard stays.
- Watering length: the configured minutes (default 10, 1 to 60), capped at 60
  in the code too. The controller ends the run by itself.
- Stop = protective: never held (option, pause, refused tokens, guards), out
  of the queue, cancels the starts not sent yet (aborts their connection);
  one try. The identity is read first (1.2 s at most) unless the controller is
  paused; another controller answering: refused; no answer or unreadable: the
  stop leaves (in doubt, the stop goes). YP: one request stops every zone
  (the API has no stop by zone). YC: the running tasks are read, then one
  PATCH per task, all at once, each checked against its deadline; the YC API
  has no stop of every zone, so with more than 32 tasks or unreadable entries
  the readable ones (32 at most) are stopped (M3); tasks unreadable: refused
  unsent, but the stop guard is set and the follow-up reads send it.
  Refused unsent only: another controller, no longer at its address, no
  token, YC tasks unreadable (documented, review 1 I1). The stop guard is on
  disk (awaited) before its first byte (M6).
- A start that LEFT before a stop and is not settled keeps the stop guard
  from being lifted (10 s at most); when it settles as "may have left" (2xx,
  5xx, silence), the stop guard is armed again from that point and the
  follow-up reads start again, so the stop is resent if the zone waters
  (review 1, B1; also a YC stop that found no task while a start was out).
  A guard armed again this way is "sticky": a dry read never lifts it (the
  controller may apply the start seconds later), only its end, 60 s after
  the start settled; at most 3 resends meanwhile (approval 1).
- Stop guard (protective kind): the follow-up reads that still see its zones
  watering send it again, at most 3 times within 60 s (counted in memory;
  a resend never extends the guard), unless a start the controller answered
  2xx left after it (request numbers; times after a restart). A failed resend
  keeps the guard (the next read retries).
- Confirmation: only a read showing the requested state (zone watering after
  a start, zones dry after a stop) answers success; otherwise "sent, without
  confirmation". No confirmation read during a 429/5xx pause.
- A token refused on a READ (401/403 or iCode -1000) is final: persisted as a
  salted fingerprint, no read until another token is saved or the Check
  button succeeds (it tries once, never sooner than the interval). A token
  refused on a START holds the starts only (15 min, 1 h, 6 h, 24 h), never
  the reads nor the stops. No fingerprint of an accepted token is kept.
- HTTP 429/5xx on a main endpoint: a pause of 1 min to 6 h persisted in
  /data, applied to the reads and the starts; a 5xx on a secondary endpoint
  (rain delay, standby, zone names) only leaves those values unknown.
- Reads never sooner than the interval (default 30 s, as Home Assistant;
  10 to 600 s): the time of the last try is written to /data before the read
  (at most once a minute, a restart waits a whole interval).
- Epoch values (standby end, rain delay end) are compared with the `Date`
  header of the controller, never the clock of Gladys; without it, the value
  is not published.
- One controller per integration in this version (each controller has its own
  token).
- Docker and the store validator were not run here (no Docker on this PC; the
  validator runs in the maintainer's terminal).
