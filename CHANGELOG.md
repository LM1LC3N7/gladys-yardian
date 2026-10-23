# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- After a command, a fourth follow-up read at 55 s: a start applied late is
  seen within the minute a stop watches it, whatever the refresh interval.

## [0.1.1] - 2026-10-23

### Added

- First version: a Yardian sprinkler controller read over its local HTTP API
  (the YP API on port 880 and the YC API of the C1 models on port 80), with an
  access token.
- The controller: watering now, the zones watering now, the rain delay left,
  the standby, a "Stop all watering" button.
- Each enabled zone: watering now, "Start watering" and "Stop watering"
  buttons (never a switch).
- Starting a zone is off by default ("Allow starting the zones"), decided on
  the identity and the zones watering read just before, for the configured
  length (60 minutes at most), with a guard against a second start.
- Stopping is never held by the option, a pause, a refused token or a guard;
  it cancels the starts not sent yet, and is sent again while the zones are
  still read watering (3 times at most). It is refused unsent only when
  another controller answers at the address, the controller is no longer at
  its address, no token is set, or the running waterings of a C1 model cannot
  be read (then it is sent as soon as a read shows them, within a minute).
- A start sent before a stop but applied after it is caught: the stop keeps
  watching until that start settles, then for a minute (a dry read does not
  end that watch), and is sent again if the zone waters (3 times at most).
- On a C1 model with more than 32 running waterings, or unreadable ones, the
  readable ones (32 at most) are stopped.
- An answer giving only the serial number of a controller known by its yid
  (or the reverse) is not "another controller": a stop is sent, a start is
  refused, and the identifiers are merged only once an answer proves them;
  an answer without a model keeps the known API family.
- Reads never sooner than the interval, even after a restart; 429/5xx pauses
  and refused tokens persisted in /data (a salted fingerprint, never the
  token); a "Check the controller" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-yardian/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-yardian/releases/tag/v0.1.1
