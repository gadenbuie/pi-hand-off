# pi-hand-off

Keep working in a fresh [pi](https://github.com/earendil-works/pi) session without having to explain the task again. **pi-hand-off** writes a hand-off prompt from your conversation and lets you choose the model that picks up the work.

Use it when a conversation has grown long, when you want another model to take over, or when you're returning to an old task. You can review each hand-off yourself, or let agents continue through a bounded relay.

| Command | Use it when… |
| --- | --- |
| `/hand-off` | You want a fresh session with a prompt you can review and edit before continuing. |
| `/hand-off-relay` | You want agents to keep handing off work without reviewing every transition. |

## Install

Install into pi:

```sh
pi install npm:@grrrck/pi-hand-off
```

Or try it for one pi run without installing:

```sh
pi -e npm:@grrrck/pi-hand-off
```

## Hand off a conversation

To carry the current work into a fresh session, run:

```text
/hand-off
```

You'll choose who writes the hand-off prompt, then keep your current model and thinking level or pick different ones for the next session. You can also give instructions about what to carry forward or focus on next.

The extension writes the prompt and opens a new session with it in the editor. **Nothing is submitted automatically:** review the prompt, edit it if needed, and send it when you're ready. Cancelling a dialog leaves you in the current session; if prompt generation fails, the extension reports why and stays there too.

For example, after exploring a bug, you might ask the next agent to focus on a fix:

```text
/hand-off Focus on the failing tests and the smallest fix. Leave the refactor for later.
```

Unlike starting an empty session with `/new`, a hand-off carries a written account of the work forward and explicitly preserves or changes your model and thinking level. It doesn't copy the whole conversation into the next session.

### Choose who writes the prompt

The model that writes the prompt doesn't have to be the model that continues the work.

- **This agent — full context and tools:** the current agent writes from its conversation, with tool access. Use this when you want it to draw on the work it has already done.
- **Fresh pass — current model:** a separate call writes from a shortened transcript, without tool access.
- **Fresh pass — another model…:** the same fresh pass, using a model you choose. A cheaper model can write the summary while a different model handles the next task.

A fresh pass is useful when the live agent's context has grown too large, or its model is no longer available and you can use another one. It sees your messages, the assistant's visible text, and brief hints about tool calls, **not tool results or private reasoning**. Long conversations may be trimmed; pi notifies you when this happens. Review the prompt for missing details, especially test results or facts that appeared only in tool output.

For reasoning-capable fresh-pass models, you also choose the writer's thinking level. This is separate from the next session's thinking level.

### Shortcuts

To skip the model-choice dialog and keep your current model and thinking level:

```text
/hand-off --same
```

To skip the writer dialog as well, use `--fresh` or `--live`:

```text
/hand-off --fresh --same Continue with the next unchecked item in PLAN.md.
/hand-off --live Ask the next agent to review the approach before changing code.
```

Put flags before your instructions. `--fresh` and `--live` cannot be combined. If you leave out instructions, an editor opens so you can add them. When picking a model, the list respects your pi model scope; press Tab to switch between scoped and all models.

### What carries forward

The prompt asks the writer to preserve your requirements, preferences, working habits, progress, and next steps. It includes the source session ID so you can trace it back. For fresh passes and stale conversations, it also notes when the conversation was last active.

An editable note reminds the receiving agent that your stated requirements matter, but the previous agent's plan and guesses are starting points to verify, not new constraints. A hand-off is still a model-written summary: check it before relying on it.

On the live-agent path, avoid queueing another message while the prompt is being written; that can cause the wrong response to be captured.

## Let agents continue in a relay

A **relay** starts a fresh session whenever an agent hands off its part of the work. Use one for a task that can be split into steps, with progress recorded somewhere each new agent can find it.

For example, to work through a plan with a hand-off limit and a spending limit:

```text
/hand-off-relay --max-steps 8 --max-cost 5 Do the next unchecked item in PLAN.md, run the tests, tick it off, and commit.
```

This allows up to **8 hand-offs**, or 9 agents including the current one, with a $5 cost limit. Sessions use the model and thinking level you started with; to change it for the next agent, see [Switching models between hops](#switching-models-between-hops). Each new agent receives the previous agent's hand-off, not the full conversation, so name the plan file or other place where progress is tracked.

If you omit the task, the relay waits for your next message. Relays are off unless you explicitly start one.

**Agents keep your full tool access and continue without your review at each hand-off.** Use a repository you can recover, give clear task boundaries, and set a cost limit. A spending limit is not a sandbox or a guarantee that the task will succeed.

### Check, pause, and stop

Use these commands while a relay is armed:

```text
/hand-off-relay status
/hand-off-relay resume [--max-steps N] [--max-cost USD]
/hand-off-relay model [provider/model[:level]]
/hand-off-relay off
```

`status` shows the current state, step, spending, sessions, outstanding background tasks when known, and which model the next hop will use. `resume` continues an idle, paused, stopped, or interrupted relay, or retries a failed hand-off. `off` stops an active relay but preserves a recovery snapshot; using `off` on that stopped snapshot discards it. The agent is told that the old protocol is no longer active until the relay is resumed or replaced.

### Relay states and background work

A relay does not treat every idle agent as finished:

- **Waiting for background work:** with `pi-subagents`, the relay tracks outstanding agents and waits until each result is delivered in a notification or read with the result tool/RPC. An unrelated turn cannot discard a pending result. If delivery is lost, `resume` releases a completed-result wait; it does not skip agents that are still running. Other notification systems use the generic no-signal behavior below.
- **Idle without a signal:** if the agent ends without a hand-off tag and no precise background-result guard is active, the relay stays armed. Any later notification or reply lets it continue; use `resume` to ask for a signal immediately.
- **Waiting for you:** an explicit pause waits for your reply or `resume`. Unrelated notifications do not advance the relay.
- **Needs attention:** after repeated malformed tags, or when session replacement fails, the relay preserves its state. Reply with guidance or use `resume`; a failed hand-off is retried from its saved prompt.
- **Advancing:** a valid hand-off is starting the next session. Use `off` to cancel it; the pending prompt remains recoverable with `resume`.
- **Stopped:** autonomy is off, but the snapshot remains. Use `resume` in the session where it stopped to reconsider a model's `done` or `stop`, recover from an error, or continue after cancellation. Use `off` to discard the snapshot instead.

Agents are told not to use pause, stop, or done merely because they are waiting for a subagent. Without a background-work integration, the relay cannot prove that work is outstanding, so this instruction matters: the generic fallback handles a turn with **no** signal, not an explicit terminal one.

The [relay lifecycle diagram](docs/relay-lifecycle.md) maps every state to its transitions and recovery actions.

### Switching models between hops

`/hand-off-relay model` stages a model change for the **next** hand-off: run it in the session the relay is waiting on, with either a spec or no argument to pick from a list.

```text
/hand-off-relay model anthropic/claude-opus-4:high
/hand-off-relay model
```

The current agent keeps its own model and prompt cache — nothing changes mid-task. When it hands off, the next session starts on the staged model instead; an omitted `:level` keeps the settling session's thinking level. `status` shows what the next hop will use, and a staged switch survives an interruption and `resume`.

A staged model that has lost its auth or is no longer available is dropped with a warning at hop time, and the relay falls back to the model it was running.

The relay stops when the work is complete, an agent reports it cannot continue, a limit is reached, or a run is aborted or fails to finish cleanly. Missing or malformed hand-off tags no longer stop it: a missing tag stays idle, while a malformed tag gets one correction request before the relay asks for your attention. If an agent needs your answer, the relay pauses in that session; reply there or use `/hand-off-relay resume` to continue.

You get a notification when the relay stops, including the reason and total reported cost. Stop and `off` also leave a model-visible message so the agent knows the old relay protocol is no longer active. **A stopped relay is recoverable:** open its last session with pi's `/resume` if necessary, then use `/hand-off-relay resume` to reconsider the stop and continue. A step- or cost-limit stop requires a higher limit, for example `resume --max-steps 12` or `resume --max-cost 10`. Using `/hand-off-relay off` on the stopped snapshot discards it instead.

### Spending limits

With `--max-cost`, agents are nudged after tool turns as reported spending crosses 80% of the budget (prepare to wrap up), 95% (finish remaining tasks), and 98% (write a final summary). The relay won't start another session at or above 95%; at 100%, it aborts the run.

**The limit can be exceeded:** costs are reported after model calls, so one expensive call can overshoot. Models that don't report cost cannot be limited this way. Without `--max-cost`, there is no spending limit.

### Resume stopped or interrupted relays

Relay progress and stopped snapshots are saved locally. When you next start pi in the same working directory, it tells you if a relay was stopped or interrupted. To continue it, run:

```text
/hand-off-relay resume
```

If recovery involves a pending hand-off, the next session starts from the saved prompt. Otherwise, first open the relay's last session with `/resume`, then run `/hand-off-relay resume`. If pi reports that an earlier prompt send may still be in preflight, wait for it to finish; if it is stuck, restart pi before resuming so the prompt cannot be submitted twice. Background-task tracking from the old process is not restored; the agent is told to inspect unfinished work instead of assuming its result. Use `/hand-off-relay off` to discard the stopped or interrupted snapshot instead.

Only one active relay can run per working directory. If another pi process owns one, `status` identifies that process and you can't resume, discard, or replace it until that process stops. A stopped snapshot has no active process owner and does not block a new relay.

Saved relay files live in `<agent-dir>/pi-hand-off/relays/`. They remain after a stop for recovery and are removed when discarded or replaced by another relay. They include hand-off text, which may contain details from your task.

## Optional configuration

You don't need a config file. To set preferences for fresh-pass writing, create `~/.pi/agent/pi-hand-off.json` (or `pi-hand-off.json` in your custom `$PI_CODING_AGENT_DIR`):

```json
{
  "handoff": {
    "summarizerModel": "anthropic/claude-haiku-4-5",
    "askSummarizerModel": true,
    "summarizerThinkingLevel": "low",
    "maxSourceChars": 200000
  }
}
```

Choose a `summarizerModel` you have configured in pi. These settings affect the **writer**, not the model that takes over:

| Setting | Effect |
| --- | --- |
| `summarizerModel` | Preferred fresh-pass model; offered in the writer menu and preselected in the writer-model picker. |
| `askSummarizerModel` | Set to `false` with a `summarizerModel` to skip the fresh-pass model picker and use that model. It does not skip the live-or-fresh writer menu. |
| `summarizerThinkingLevel` | Preselected writer thinking level. Use `default` (or `off`) for the provider default, or `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. The picker remains available for reasoning-capable models. |
| `maxSourceChars` | Fresh-pass transcript budget in characters. Defaults to `200000`; `0` disables trimming. |

Settings are read at the start of each session. Invalid configuration is reported as a warning and ignored. To override the writer model or transcript budget for a pi run:

```sh
pi --hand-off-summarizer=anthropic/claude-haiku-4-5 --hand-off-max-source-chars=400000
```

Launch flags override the config file. Setting `--hand-off-summarizer` also skips the fresh-pass model picker. If your preferred writer model isn't available, pi warns you and asks you to choose another. `/hand-off` itself has no model-ID flag; use the pickers or configuration.

## Moving from pi-clear

This extension was split out of [`@grrrck/pi-clear`](https://github.com/gadenbuie/pi-clear), which provides `/clear`: a fresh session that keeps your model without carrying a hand-off prompt.

- Install `pi-hand-off` for `/hand-off` and `/hand-off-relay`. Keep `pi-clear` installed if you also want `/clear`.
- Rename `<agent-dir>/pi-clear.json` to `<agent-dir>/pi-hand-off.json` when convenient. The old file is still read if the new one doesn't exist.
- If you used the unreleased `/hand-off-chain` command, use `/hand-off-relay` instead.

## Contributing

Load a local checkout with `pi -e ./index.ts`. Run the offline tests with:

```sh
for f in scripts/*.test.mjs; do node "$f"; done
```

The separate `scripts/rpc-handoff-smoke-test.py` uses your live pi configuration and makes real, billed model requests. Run it only when you intend to test against those models.

Bug reports and pull requests are welcome on [GitHub](https://github.com/gadenbuie/pi-hand-off/issues).

## License

[MIT](LICENSE)
