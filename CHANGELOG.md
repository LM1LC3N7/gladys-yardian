# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
- Stopping is never refused (option, pause, refused token, guard), cancels the
  starts not sent yet, and is sent again while the zones are still read
  watering (3 times at most).
- Reads never sooner than the interval, even after a restart; 429/5xx pauses
  and refused tokens persisted in /data (a salted fingerprint, never the
  token); a "Check the controller" button.

[Unreleased]: https://github.com/LM1LC3N7/gladys-yardian/commits/main
