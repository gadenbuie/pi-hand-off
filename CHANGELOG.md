# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First release as its own package. `/hand-off` and the relay were split out of [`@grrrck/pi-clear`](https://github.com/gadenbuie/pi-clear) (versions up to 0.5.0), which now only provides `/clear`.

### Added

- `/hand-off-relay --max-steps N [--max-cost USD] [task]`: opt-in autonomous relay of agents. Each agent ends with `<hand-off>…</hand-off>`, `<hand-off done/>`, `<hand-off stop>reason</hand-off>`, or `<hand-off pause>question</hand-off>` (waits for your reply, then resumes), and the extension starts the next session on its own. It has a step cap, an optional cost limit with escalating warnings (80/95/98%) and a hard stop at 100%, one reminder for a missing tag, a watchdog, provenance headers, and per-hop usage and stop entries. `--max-steps` counts hand-offs: the agent you arm it in is step 0 and isn't counted, so up to N+1 agents run. It's required. See the README.
- Relay progress is saved to `<agent-dir>/pi-hand-off/relays/` (one file per working directory) and deleted when the relay stops. After a crash or quit, pi reports the interrupted relay at startup; `/hand-off-relay resume` continues it and `/hand-off-relay off` discards it. The file records its owning pid and start time (so a reused pid isn't mistaken for it), so a second pi in the same directory neither warns about a relay that is still running nor can resume, discard, or replace it; only one relay runs per directory.

### Changed

- Settings are read from `<agent-dir>/pi-hand-off.json`; the old `<agent-dir>/pi-clear.json` is still read when the new file does not exist.
- The hand-off request message type is now `pi-hand-off:hand-off-request` (was `pi-clear:hand-off-request`). Session transcripts written by earlier versions are unaffected.
- Relay session entries are `pi-hand-off:relay-hop` and `pi-hand-off:relay-stop`.

### Removed

- `/clear` (still in `@grrrck/pi-clear`).
