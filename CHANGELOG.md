# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-10

### Added

- An explicit relay lifecycle diagram and state/recovery guide in `docs/relay-lifecycle.md`.
- Optional background-agent tracking through `pi-subagents` lifecycle events. Known outstanding work or an undelivered/unread result prevents premature hand-offs and terminal signals. Actual notification delivery, `get_subagent_result`, and RPC consumption release the result guard; unrelated turns do not.
- `/hand-off-relay status` now reports the current lifecycle state, known background tasks, and the next useful action.
- Stopped relays retain a recovery snapshot. `/hand-off-relay resume` can reconsider a model's `done` or `stop`, recover from errors or cancellation, and replay a pending hand-off. Step- and cost-limit recovery accept `resume --max-steps N` and `resume --max-cost USD` respectively.

### Changed

- A main agent that settles without a hand-off signal now leaves the relay armed in an idle state. Any later notification or user reply lets it continue, providing an extension-agnostic fallback for background-task systems; `/hand-off-relay resume` requests a signal immediately.
- Relay signals may have prose around them. Fenced examples still do not count, and everything the next agent needs must remain inside a hand-off block.
- `/hand-off-relay resume` now resumes an idle or paused relay in the current session and retries a failed pending advance, in addition to recovering after process exit.
- Explicit user pauses survive unrelated notification-driven turns; only interactive human input or `resume` clears them. Extension/RPC submissions also cannot reset the malformed-signal correction budget.
- `/hand-off-relay off` now stops an active relay while preserving a recovery snapshot; running `off` on the stopped or interrupted snapshot explicitly discards it. Stopped snapshots do not count as active relays owned by another process.

### Fixed

- A second malformed hand-off signal now enters a recoverable needs-attention state instead of deleting the relay and making `resume` impossible.
- Session-replacement cancellation/errors and advance-dispatch timeouts preserve the pending hand-off for `resume` instead of stopping and discarding it.
- Relay stop and `off` now append a model-visible deactivation message so the agent does not keep following stale instructions and emitting ignored hand-off tags; resuming supersedes that message.
- Replacement prompts remain pending until their exact user message starts, after model/auth validation. A rejected or swallowed send, delivery timeout, or process exit before then preserves the prompt for same-session or previous-session recovery without adding a step. Single-flight claims prevent overlapping resume attempts; a stuck preflight requires a restart before retrying. Blank replacement sessions no longer make recovery unreachable, duplicate advances are ignored, pending resumes enforce the 95% new-session cost guard, and `off` during replacement cannot resurrect the stopped relay.

## [0.2.0] - 2026-11-09

### Added

- `/hand-off-relay model [provider/model[:level]]` stages the model of the relay's next hand-off; with no argument it opens the model picker. The current agent keeps its model (and its prompt cache); the staged model replaces the carried-over one when the agent hands off, and an omitted `:level` keeps the settling session's thinking level. A staged model that loses availability or auth before the hop is dropped with a warning and the relay keeps its current model. The staged model survives an interruption and `resume`.
- `/hand-off-relay status` now shows which model the next hop will use.

## [0.1.1] - 2026-11-09

### Changed

- Rewrote README for clarity. No other changes.

## [0.1.0] - 2026-11-09

First release as its own package. `/hand-off` and the relay were split out of [`@grrrck/pi-clear`](https://github.com/gadenbuie/pi-clear) (versions up to 0.5.0), which now only provides `/clear`.

### Added

- `/hand-off-relay --max-steps N [--max-cost USD] [task]`: opt-in autonomous relay of agents. Each agent ends with `<hand-off>…</hand-off>`, `<hand-off done/>`, `<hand-off stop>reason</hand-off>`, or `<hand-off pause>question</hand-off>` (waits for your reply, then resumes), and the extension starts the next session on its own. It has a step cap, an optional cost limit with escalating warnings (80/95/98%) and a hard stop at 100%, one reminder for a missing tag, a watchdog, provenance headers, and per-hop usage and stop entries. `--max-steps` counts hand-offs: the agent you arm it in is step 0 and isn't counted, so up to N+1 agents run. It's required. See the README.
- Relay progress is saved to `<agent-dir>/pi-hand-off/relays/` (one file per working directory) and deleted when the relay stops. After a crash or quit, pi reports the interrupted relay at startup; `/hand-off-relay resume` continues it and `/hand-off-relay off` discards it. The file records its owning pid and start time (so a reused pid isn't mistaken for it), so a second pi in the same directory neither warns about a relay that is still running nor can resume, discard, or replace it; only one relay runs per directory.

### Changed

- `/hand-off` writers (live and fresh) are now asked to carry over how you have been working with the agent, to separate what you required from their own inferences, to name git and test state only if they saw it, and to keep finished work brief. The fresh pass describes the conversation in the past tense, as a record rather than the project's current state.
- Every `/hand-off` prompt ends with an editable authority note: the previous agent's plan is a starting point, your stated requirements bind, and the new agent should verify state and ask only when blocked. The provenance comment gains a "last active" time for the fresh pass and for conversations idle an hour or more.
- Settings are read from `<agent-dir>/pi-hand-off.json`; the old `<agent-dir>/pi-clear.json` is still read when the new file does not exist.
- The hand-off request message type is now `pi-hand-off:hand-off-request` (was `pi-clear:hand-off-request`). Session transcripts written by earlier versions are unaffected.
- Relay session entries are `pi-hand-off:relay-hop` and `pi-hand-off:relay-stop`.

### Removed

- `/clear` (still in `@grrrck/pi-clear`).
