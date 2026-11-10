// Offline relay lifecycle tests through the mocked ExtensionAPI. No pi process,
// user configuration, network access, or model requests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-hand-off-relay-flow-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const { default: extension, readRelay, readStoppedRelay, relayPhase, relayStatePath, setRelayPersistence, writeRelay } = await import("../index.ts");

async function createRelayHarness({ subagentRecords = {} } = {}) {
	globalThis[Symbol.for("pi-subagents:manager")] = {
		getRecord: (id) => subagentRecords[id],
	};
	const commands = new Map();
	const handlers = new Map();
	const bus = new Map();
	const sentUserMessages = [];
	const sentCustomMessages = [];
	const notifications = [];
	let assistantText = "";
	let replacementResult = { cancelled: true };

	const pi = {
		registerCommand: (name, command) => commands.set(name, command),
		registerFlag: () => {},
		getFlag: () => undefined,
		on: (event, handler) => handlers.set(event, handler),
		events: {
			on: (channel, handler) => {
				const listeners = bus.get(channel) ?? new Set();
				listeners.add(handler);
				bus.set(channel, listeners);
				return () => listeners.delete(handler);
			},
		},
		sendUserMessage: async (message) => {
			sentUserMessages.push(message);
			// Pi emits input for extension submissions too; these must not count as
			// human answers or reset the relay's correction budget.
			await handlers.get("input")?.({ text: message, source: "extension" }, ctx);
		},
		sendMessage: (message) => sentCustomMessages.push(message),
		appendEntry: () => {},
		setModel: async () => true,
		setThinkingLevel: async () => {},
		getSessionName: () => "relay flow test",
	};

	const model = { provider: "test", id: "model", reasoning: false };
	const ctx = {
		mode: "rpc",
		cwd: "/tmp/pi-hand-off-relay-flow-repo",
		hasUI: false,
		model,
		thinkingLevel: "medium",
		isIdle: () => true,
		waitForIdle: async () => {},
		abort: () => {},
		modelRegistry: {
			find: () => model,
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => "session-0",
			buildSessionProjection: () => ({
				messages: assistantText
					? [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: assistantText }] }]
					: [],
			}),
		},
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setEditorText: () => {},
		},
		newSession: async () => replacementResult,
	};

	extension(pi);
	await handlers.get("session_start")({ reason: "startup" }, ctx);

	return {
		ctx,
		commands,
		handlers,
		notifications,
		sentUserMessages,
		sentCustomMessages,
		arm: () => commands.get("hand-off-relay").handler("--max-steps 2", ctx),
		resume: (args = "resume") => commands.get("hand-off-relay").handler(args, ctx),
		off: () => commands.get("hand-off-relay").handler("off", ctx),
		advance: () => commands.get("pi-hand-off-relay-advance").handler("", ctx),
		emit: (channel, data) => {
			for (const listener of bus.get(channel) ?? []) listener(data);
		},
		turn: () => handlers.get("turn_start")({}, ctx),
		input: (source = "interactive") => handlers.get("input")({ text: "reply", source }, ctx),
		messageStart: (details) => handlers.get("message_start")({
			message: { role: "custom", customType: "subagent-notification", details },
		}, ctx),
		acceptPrompt: async (text, next = ctx) => {
			await handlers.get("session_start")({ reason: "new" }, next);
			await handlers.get("message_start")({ message: { role: "user", content: text } }, next);
		},
		toolResult: (text, isError = false) => handlers.get("tool_execution_end")({
			toolName: "get_subagent_result",
			result: { content: [{ type: "text", text }] },
			isError,
		}, ctx),
		settle: async (text, stopReason = "stop", cost = 0) => {
			assistantText = text;
			ctx.sessionManager.buildSessionProjection = () => ({
				messages: [{ role: "assistant", stopReason, content: [{ type: "text", text }], usage: { cost: { total: cost } } }],
			});
			await handlers.get("agent_settled")({ aborted: false }, ctx);
		},
	};
}

test.beforeEach(() => {
	delete globalThis[Symbol.for("pi-subagents:manager")];
	delete globalThis.__pi_hand_off_relay_delivery__;
	writeRelay(undefined);
	setRelayPersistence(undefined);
});

test.afterEach(() => {
	delete globalThis[Symbol.for("pi-subagents:manager")];
	delete globalThis.__pi_hand_off_relay_delivery__;
	writeRelay(undefined);
	setRelayPersistence(undefined);
});

test("a no-signal settle stays armed and any later turn can hand off", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("I am waiting for a background result.");

	assert.equal(relayPhase(readRelay()), "unsignalled");
	assert.equal(readRelay().pending, undefined);
	assert.equal(flow.sentUserMessages.length, 0);
	await flow.commands.get("hand-off-relay").handler("status", flow.ctx);
	assert.match(flow.notifications.at(-1).message, /idle without a relay signal/);
	assert.match(flow.notifications.at(-1).message, /`resume` asks for a relay signal now/);

	await flow.turn();
	await flow.settle("Summary for the user.\n<hand-off>Continue from the saved plan.</hand-off>");

	assert.equal(relayPhase(readRelay()), "advancing");
	assert.match(readRelay().pending.prompt, /Continue from the saved plan/);
	assert.equal(flow.sentUserMessages.at(-1), "/pi-hand-off-relay-advance");
});

test("known background work defers a stop until its notification turn", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "inspect lifecycle" });

	await flow.settle("<hand-off stop>I am waiting for exploration</hand-off>");
	assert.equal(relayPhase(readRelay()), "background");
	assert.equal(readRelay().pending, undefined);
	await flow.commands.get("hand-off-relay").handler("status", flow.ctx);
	assert.match(flow.notifications.at(-1).message, /waiting for background work/);
	assert.match(flow.notifications.at(-1).message, /inspect lifecycle/);

	flow.emit("subagents:completed", { id: "explore-1" });
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-1"]);
	assert.equal(relayPhase(readRelay()), "background");

	flow.messageStart({ id: "explore-1" });
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(readRelay(), undefined);
	assert.match(flow.sentCustomMessages.at(-1).content, /relay is stopped/);
	assert.match(flow.sentCustomMessages.at(-1).content, /resumes this relay or explicitly arms another one/);
});

test("a user pause survives notification turns and clears for human input", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off pause>Which database should I use?</hand-off>");

	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(relayPhase(readRelay()), "user");

	await flow.input("extension");
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(relayPhase(readRelay()), "user");

	await flow.input();
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(readRelay(), undefined);
});

test("repeated malformed signals preserve the relay and resume re-prompts it", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off></hand-off>");
	assert.match(flow.sentUserMessages.at(-1), /can't advance the relay/);
	assert.equal(readRelay().nudged, true, "extension input must not reset the correction budget");

	await flow.turn();
	await flow.settle("<hand-off></hand-off>");
	assert.equal(relayPhase(readRelay()), "attention");
	assert.equal(readRelay().pending, undefined);

	await flow.resume();
	assert.equal(relayPhase(readRelay()), "running");
	assert.match(flow.sentUserMessages.at(-1), /The user resumed the relay/);
});

test("a cancelled advance preserves its prompt and resume retries it", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Next agent prompt</hand-off>");
	await flow.advance();

	assert.equal(relayPhase(readRelay()), "attention");
	assert.match(readRelay().pending.prompt, /Next agent prompt/);

	await flow.resume();
	assert.equal(relayPhase(readRelay()), "advancing");
	assert.match(readRelay().pending.prompt, /Next agent prompt/);
	assert.equal(flow.sentUserMessages.at(-1), "/pi-hand-off-relay-advance");
});

test("a foreground subagent result is inline and needs no notification guard", async () => {
	const flow = await createRelayHarness({
		subagentRecords: { "explore-1": { blocking: true, isBackground: false } },
	});
	await flow.arm();
	flow.emit("subagents:started", { id: "explore-1", type: "explore", description: "inline work" });
	flow.emit("subagents:completed", { id: "explore-1" });
	assert.equal(readRelay().backgroundNotifications, undefined);
	await flow.settle("<hand-off>Continue with the inline result</hand-off>");
	assert.equal(relayPhase(readRelay()), "advancing");
});

test("a consumed background result releases the relay without a notification", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "inspect lifecycle" });
	await flow.settle("<hand-off>Wait for the result</hand-off>");
	flow.emit("subagents:completed", { id: "explore-1" });
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-1"]);

	// pi-subagents cancels the outbox when this tool returns the completed result.
	await flow.toolResult("Agent: explore-1\nType: explore | Status: completed\n\nResult body");
	assert.equal(readRelay().backgroundNotifications, undefined);
	assert.equal(relayPhase(readRelay()), "running");
	await flow.settle("<hand-off>Continue with the consumed result</hand-off>");
	assert.equal(relayPhase(readRelay()), "advancing");
});

test("an unrelated turn cannot release a pending background notification", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "inspect lifecycle" });
	await flow.settle("<hand-off>Wait for the result</hand-off>");
	flow.emit("subagents:completed", { id: "explore-1" });

	await flow.input("rpc");
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(relayPhase(readRelay()), "background");
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-1"]);
	assert.equal(readRelay().pending, undefined);

	flow.messageStart({ id: "explore-1" });
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(readRelay(), undefined);
});

test("resume can recover a lost result while other background work keeps running", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "finished" });
	flow.emit("subagents:created", { id: "explore-2", type: "explore", description: "still running" });
	await flow.settle("<hand-off>Wait for both results</hand-off>");
	flow.emit("subagents:completed", { id: "explore-1" });

	await flow.resume();
	assert.equal(readRelay().backgroundNotifications, undefined);
	assert.deepEqual(readRelay().backgroundTasks.map((task) => task.id), ["explore-2"]);
	assert.equal(relayPhase(readRelay()), "running");
	assert.match(flow.sentUserMessages.at(-1), /The user resumed the relay/);

	await flow.settle("<hand-off done/>");
	assert.equal(relayPhase(readRelay()), "background", "the remaining task is still protected");
});

test("a grouped notification releases every result it contains", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "one" });
	flow.emit("subagents:created", { id: "explore-2", type: "explore", description: "two" });
	flow.emit("subagents:completed", { id: "explore-1" });
	flow.emit("subagents:completed", { id: "explore-2" });
	flow.messageStart({ id: "explore-1", others: [{ id: "explore-2" }] });
	assert.equal(readRelay().backgroundNotifications, undefined);
});

test("started-only detached agents keep their result guard until RPC consumption", async () => {
	const flow = await createRelayHarness({
		// RPC/scheduler spawns can be detached with isBackground false and never
		// emit subagents:created. `blocking` is the reliable inline-result signal.
		subagentRecords: { "explore-rpc": { blocking: false, isBackground: false } },
	});
	await flow.arm();
	flow.emit("subagents:started", { id: "explore-rpc", type: "explore", description: "RPC work" });
	await flow.settle("<hand-off>Wait for RPC work</hand-off>");
	flow.emit("subagents:completed", { id: "explore-rpc" });
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-rpc"]);

	await flow.input("rpc");
	await flow.turn();
	await flow.settle("<hand-off done/>");
	assert.equal(relayPhase(readRelay()), "background");
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-rpc"]);

	flow.emit("subagents:rpc:consume", { agentId: "explore-rpc" });
	assert.equal(relayPhase(readRelay()), "running");
	await flow.settle("<hand-off done/>");
	assert.equal(readRelay(), undefined);
});

test("RPC result consumption releases only the matching pending result", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	flow.emit("subagents:created", { id: "explore-1", type: "explore", description: "one" });
	flow.emit("subagents:created", { id: "explore-2", type: "explore", description: "two" });
	await flow.settle("<hand-off>Wait for both results</hand-off>");
	flow.emit("subagents:completed", { id: "explore-1" });
	flow.emit("subagents:completed", { id: "explore-2" });

	flow.emit("subagents:rpc:consume", { agentId: "explore-1" });
	assert.deepEqual(readRelay().backgroundNotifications, ["explore-2"]);
	flow.messageStart({ id: "explore-2" });
	assert.equal(readRelay().backgroundNotifications, undefined);
});

test("a model-done stop remains stopped but resumable in the same session", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off done/>");
	assert.equal(readRelay(), undefined);
	assert.match(readStoppedRelay(flow.ctx.cwd).record.stopped.reason, /work is done/);

	await flow.commands.get("hand-off-relay").handler("status", flow.ctx);
	assert.match(flow.notifications.at(-1).message, /stopped at step 0 of 2/);
	assert.match(flow.notifications.at(-1).message, /resume.*reopens it/);

	await flow.resume();
	assert.equal(relayPhase(readRelay()), "running");
	assert.equal(readStoppedRelay(flow.ctx.cwd), undefined);
	assert.match(flow.sentUserMessages.at(-1), /resumed the relay after it stopped/);
	assert.match(flow.sentUserMessages.at(-1), /Reconsider that decision/);

	await flow.settle("<hand-off>The work was not actually finished</hand-off>");
	assert.equal(relayPhase(readRelay()), "advancing");
});

test("an explicit model stop and an error stop can both be reconsidered", async () => {
	for (const [text, stopReason, reason] of [
		["<hand-off stop>The model gave up too early</hand-off>", "stop", /gave up too early/],
		["<hand-off>Partial provider output</hand-off>", "error", /ended with "error"/],
	]) {
		const flow = await createRelayHarness();
		await flow.arm();
		await flow.settle(text, stopReason);
		assert.match(readStoppedRelay(flow.ctx.cwd).record.stopped.reason, reason);
		await flow.resume();
		assert.match(flow.sentUserMessages.at(-1), /Reconsider that decision/);
		await flow.settle("<hand-off>Recovered with user guidance</hand-off>");
		assert.equal(relayPhase(readRelay()), "advancing");
		await flow.off();
		await flow.off();
	}
});

test("off preserves one recovery snapshot and a second off discards it", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.off();
	assert.equal(readRelay(), undefined);
	assert.match(readStoppedRelay(flow.ctx.cwd).record.stopped.reason, /disarmed/);

	await flow.resume();
	assert.equal(relayPhase(readRelay()), "running");
	await flow.off();
	assert.ok(readStoppedRelay(flow.ctx.cwd));
	await flow.off();
	assert.equal(readStoppedRelay(flow.ctx.cwd), undefined);
	assert.match(flow.notifications.at(-1).message, /snapshot discarded/);

	await flow.resume();
	assert.match(flow.notifications.at(-1).message, /No stopped or interrupted/);
});

test("a step-limit stop requires and accepts a higher resume limit", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	writeRelay({ ...readRelay(), sessionIds: ["earlier-1", "earlier-2", flow.ctx.sessionManager.getSessionId()] });
	await flow.settle("<hand-off>One more step</hand-off>");
	assert.equal(readStoppedRelay(flow.ctx.cwd).record.stopped.limit, "steps");

	await flow.resume();
	assert.match(flow.notifications.at(-1).message, /--max-steps greater than 2/);
	assert.ok(readStoppedRelay(flow.ctx.cwd));

	await flow.resume("resume --max-steps 4");
	assert.equal(readRelay().maxSteps, 4);
	assert.equal(relayPhase(readRelay()), "running");
	await flow.settle("<hand-off>Continue with the raised limit</hand-off>");
	assert.equal(relayPhase(readRelay()), "advancing");
});

test("a cost-limit stop requires a higher cap and does not double-count the current session", async () => {
	const flow = await createRelayHarness();
	await flow.commands.get("hand-off-relay").handler("--max-steps 3 --max-cost 1", flow.ctx);
	await flow.settle("<hand-off>Next step</hand-off>", "stop", 1);
	const stopped = readStoppedRelay(flow.ctx.cwd);
	assert.equal(stopped.record.stopped.limit, "cost");
	assert.equal(stopped.record.relay.spent, 0, "current-session spend stays in the transcript");

	await flow.resume();
	assert.match(flow.notifications.at(-1).message, /--max-cost greater than/);
	await flow.resume("resume --max-cost 1.02");
	assert.match(flow.notifications.at(-1).message, /95% guard/);
	assert.ok(readStoppedRelay(flow.ctx.cwd));
	await flow.resume("resume --max-cost 2");
	assert.equal(readRelay().spent, 0);
	assert.equal(readRelay().maxCost, 2);
	await flow.settle("<hand-off>Continue within the raised cap</hand-off>", "stop", 1);
	assert.equal(readRelay().pending.prompt.includes("Continue within the raised cap"), true);
	assert.equal(readRelay().spent, 1, "the same transcript cost is counted exactly once");
});

test("pending-hop resume cannot bypass the 95 percent new-session cost guard", async () => {
	const flow = await createRelayHarness();
	await flow.commands.get("hand-off-relay").handler("--max-steps 3 --max-cost 2", flow.ctx);
	await flow.settle("<hand-off>Needs cost headroom</hand-off>", "stop", 1);
	await flow.off();
	await flow.resume("resume --max-cost 1.01");
	assert.match(flow.notifications.at(-1).message, /95% new-session guard/);
	assert.ok(readStoppedRelay(flow.ctx.cwd));
	await flow.resume("resume --max-cost 1.1");
	assert.equal(relayPhase(readRelay()), "advancing");
});

test("cancelling an advance preserves its pending prompt for stopped resume", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Prompt worth recovering</hand-off>");
	await flow.off();
	assert.equal(readRelay(), undefined);
	assert.match(readStoppedRelay(flow.ctx.cwd).record.relay.pending.prompt, /Prompt worth recovering/);

	await flow.resume();
	assert.equal(relayPhase(readRelay()), "advancing");
	assert.match(readRelay().pending.prompt, /Prompt worth recovering/);
	assert.equal(flow.sentUserMessages.at(-1), "/pi-hand-off-relay-advance");
});

test("accepted replacement prompts clear delivery state without adding a step", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Accepted prompt</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: async (message) => {
				await flow.handlers.get("input")({ text: message, source: "extension" }, next);
				await flow.acceptPrompt(message, next);
			},
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(readRelay().pending, undefined);
	assert.deepEqual(readRelay().sessionIds, ["session-0", "session-1"]);
	assert.equal(relayPhase(readRelay()), "running");
});

test("a crash before replacement prompt acceptance resumes in that same session", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Survive a crash before input</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			// The process disappears before pi emits input or settles this promise.
			sendUserMessage: () => new Promise(() => {}),
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	assert.equal(readRelay().pending.deliverHere, true);
	assert.deepEqual(readRelay().sessionIds, ["session-0"]);

	// Simulate process-local state disappearing while the persisted record stays.
	delete globalThis.__pi_hand_off_relay__;
	delete globalThis.__pi_hand_off_relay_delivery__;
	await flow.handlers.get("session_start")({ reason: "startup" }, next);
	await flow.commands.get("hand-off-relay").handler("resume", next);
	await flow.acceptPrompt(readRelay().pending.prompt, next);
	assert.equal(readRelay().pending, undefined);
	assert.deepEqual(readRelay().sessionIds, ["session-0", "session-1"]);
	assert.match(flow.sentUserMessages.at(-1), /Survive a crash before input/);
});

test("off during session replacement cannot resurrect the relay", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Do not deliver after off</hand-off>");
	let delivered = false;
	flow.ctx.newSession = async ({ withSession }) => {
		await flow.off();
		const next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: async () => { delivered = true; },
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	assert.equal(readRelay(), undefined);
	assert.equal(delivered, false);
	assert.match(readStoppedRelay(flow.ctx.cwd).record.relay.pending.prompt, /Do not deliver after off/);
});

test("status and the second off use an in-memory stopped snapshot if disk is unavailable", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off done/>");
	rmSync(relayStatePath(flow.ctx.cwd), { force: true });
	await flow.commands.get("hand-off-relay").handler("status", flow.ctx);
	assert.match(flow.notifications.at(-1).message, /Hand-off relay stopped/);
	await flow.off();
	assert.equal(readStoppedRelay(flow.ctx.cwd), undefined);
	assert.match(flow.notifications.at(-1).message, /snapshot discarded/);
});

test("manual resume limit overrides cannot be below work already accumulated", async () => {
	const flow = await createRelayHarness();
	await flow.commands.get("hand-off-relay").handler("--max-steps 4 --max-cost 2", flow.ctx);
	await flow.settle("<hand-off done/>", "stop", 1);
	await flow.resume("resume --max-cost 0.5");
	assert.match(flow.notifications.at(-1).message, /greater than the \$1.00 already reported/);
	assert.ok(readStoppedRelay(flow.ctx.cwd));

	const capped = await createRelayHarness();
	await capped.commands.get("hand-off-relay").handler("--max-steps 3 --max-cost 1", capped.ctx);
	await capped.settle("<hand-off done/>", "stop", 1);
	await capped.resume();
	assert.match(capped.notifications.at(-1).message, /at or above its \$1.00 cap/);
	assert.ok(readStoppedRelay(capped.ctx.cwd));
});

test("input followed by model or auth rejection preserves the undelivered prompt", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Do not lose this on auth failure</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: async (message) => {
				await flow.handlers.get("input")({ text: message, source: "extension" }, next);
				throw new Error("No API key");
			},
		};
		await flow.handlers.get("session_start")({ reason: "new" }, next);
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	assert.equal(relayPhase(readRelay()), "attention");
	assert.equal(readRelay().pending.deliverHere, true);
	assert.deepEqual(readRelay().sessionIds, ["session-0"]);

	await flow.commands.get("hand-off-relay").handler("resume", next);
	await flow.acceptPrompt(readRelay().pending.prompt, next);
	assert.equal(readRelay().pending, undefined);
	assert.deepEqual(readRelay().sessionIds, ["session-0", "session-1"]);
});

test("a swallowed replacement send becomes attention at the delivery watchdog", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Watch until delivery starts</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: (message) => {
				// The runtime emits input, then neither starts nor settles the send.
				void flow.handlers.get("input")({ text: message, source: "extension" }, next);
				return new Promise(() => {});
			},
		};
		await flow.handlers.get("session_start")({ reason: "new" }, next);
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	t.mock.timers.tick(10_000);
	await Promise.resolve();
	assert.equal(relayPhase(readRelay()), "attention");
	assert.match(readRelay().waiting.reason, /prompt was not accepted/);

	const sentBeforeRetry = flow.sentUserMessages.length;
	await flow.commands.get("hand-off-relay").handler("resume", next);
	assert.equal(flow.sentUserMessages.length, sentBeforeRetry);
	assert.match(flow.notifications.at(-1).message, /No duplicate prompt was sent/);
	assert.equal(relayPhase(readRelay()), "attention");
	assert.equal(readRelay().pending.deliverHere, true);
});

test("repeated resume cannot overlap direct delivery preflight", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Only one direct retry</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: async () => { throw new Error("preflight failed once"); },
		};
		await flow.handlers.get("session_start")({ reason: "new" }, next);
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	await flow.commands.get("hand-off-relay").handler("resume", next);
	const sent = flow.sentUserMessages.length;
	assert.match(flow.sentUserMessages.at(-1), /Only one direct retry/);

	await flow.commands.get("hand-off-relay").handler("resume", next);
	assert.equal(flow.sentUserMessages.length, sent);
	assert.match(flow.notifications.at(-1).message, /No duplicate prompt was sent/);
	t.mock.timers.tick(10_000);
	await Promise.resolve();
	await flow.commands.get("hand-off-relay").handler("resume", next);
	assert.equal(flow.sentUserMessages.length, sent);
	assert.equal(relayPhase(readRelay()), "attention");
});

test("an unreachable blank replacement replays from the previous session without adding a step", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Replay after blank session disappears</hand-off>");
	flow.ctx.newSession = async ({ withSession }) => {
		const next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: () => new Promise(() => {}),
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	assert.equal(readRelay().pending.targetSessionId, "session-1");
	assert.deepEqual(readRelay().sessionIds, ["session-0"]);

	delete globalThis.__pi_hand_off_relay__;
	delete globalThis.__pi_hand_off_relay_delivery__;
	await flow.resume();
	assert.equal(relayPhase(readRelay()), "advancing");
	assert.equal(readRelay().pending.deliverHere, undefined);
	assert.deepEqual(readRelay().sessionIds, ["session-0"]);
	assert.equal(flow.sentUserMessages.at(-1), "/pi-hand-off-relay-advance");
});

test("duplicate advances cannot create another session while delivery is pending", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Advance only once</hand-off>");
	let replacements = 0;
	flow.ctx.newSession = async ({ withSession }) => {
		replacements += 1;
		const next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: () => new Promise(() => {}),
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();
	await flow.advance();
	assert.equal(replacements, 1);
	assert.equal(readRelay().pending.deliverHere, true);
});

test("a failed first prompt in the replacement session resumes in that session", async () => {
	const flow = await createRelayHarness();
	await flow.arm();
	await flow.settle("<hand-off>Deliver this prompt exactly once</hand-off>");
	let next;
	flow.ctx.newSession = async ({ withSession }) => {
		next = {
			...flow.ctx,
			sessionManager: { ...flow.ctx.sessionManager, getSessionId: () => "session-1" },
			sendUserMessage: async () => { throw new Error("simulated prompt rejection"); },
		};
		await withSession(next);
		return { cancelled: false };
	};
	await flow.advance();

	assert.equal(relayPhase(readRelay()), "attention");
	assert.equal(readRelay().pending.deliverHere, true);
	assert.deepEqual(readRelay().sessionIds, ["session-0"]);
	await flow.commands.get("hand-off-relay").handler("resume", next);
	await flow.acceptPrompt(readRelay().pending.prompt, next);
	assert.equal(relayPhase(readRelay()), "running");
	assert.equal(readRelay().pending, undefined);
	assert.deepEqual(readRelay().sessionIds, ["session-0", "session-1"]);
	assert.match(flow.sentUserMessages.at(-1), /Deliver this prompt exactly once/);
	assert.notEqual(flow.sentUserMessages.at(-1), "/pi-hand-off-relay-advance");
});
