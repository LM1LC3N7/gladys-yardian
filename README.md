# gladys-yardian

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for the **Yardian** smart sprinkler controllers, over their local
HTTP API (no cloud). Not affiliated with Aeon Matrix or Yardian.

- The controller: watering now, the zones watering now, the rain delay left,
  the standby, a "Stop all watering" button.
- Each enabled zone: watering now, "Start watering" and "Stop watering"
  buttons (never a switch).
- **Starting a zone is off by default** (it opens a valve); the watering
  length is capped at 60 minutes; stopping is never refused.

Never tested with a real device: built from
[pyyardian](https://pypi.org/project/pyyardian/) 1.4.2 (MIT, Aeon Matrix), the
library of the Home Assistant integration. Reports welcome.

Guides: [français](docs/fr.md) · [English](docs/en.md)

## Development

```bash
npm install
npm run format:check && npm run lint && npm test && npm run audit
npx --yes github:GladysAssistant/integration-store .   # store admission checks
npm run cover                                          # regenerates cover.png
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, and
[TODO.md](TODO.md) for what remains to confirm on a real controller.

## License

Apache-2.0. Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
