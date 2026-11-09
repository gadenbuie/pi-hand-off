// Offline tests for the autonomous hand-off relay helpers.
// Run with Node 24+: node --test scripts/relay.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildRelayNudge,
	buildRelayPrompt,
	buildRelayProtocol,
	decideBudgetAction,
	decideRelayAction,
	isProcessAlive,
	isRelayOwnerAlive,
	processStartTime,
	loadPersistedRelay,
	parseModelSpec,
	parsePersistedRelay,
	parseRelayArgs,
	parseRelaySignal,
	readRelay,
	relayOwnedByOtherProcess,
	relayStatePath,
	setRelayPersistence,
	writeRelay,
	sumUsage,
} from "../index.ts";

test("parseRelayArgs", () => {
	assert.deepEqual(parseRelayArgs("--max-steps 10 do PLAN.md"), { kind: "start", maxSteps: 10, maxCost: undefined, task: "do PLAN.md" });
	assert.deepEqual(parseRelayArgs("--max-steps=3"), { kind: "start", maxSteps: 3, maxCost: undefined, task: "" });
	assert.deepEqual(parseRelayArgs("off"), { kind: "off" });
	assert.deepEqual(parseRelayArgs("status"), { kind: "status" });
	assert.deepEqual(parseRelayArgs(""), { kind: "status" });
	assert.deepEqual(parseRelayArgs("model"), { kind: "model", spec: "" });
	assert.deepEqual(parseRelayArgs("model anthropic/claude-x:high"), { kind: "model", spec: "anthropic/claude-x:high" });
	// "model" is only a subcommand as the first token; with flags first it is task text.
	assert.deepEqual(parseRelayArgs("--max-steps 5 model the data"), { kind: "start", maxSteps: 5, maxCost: undefined, task: "model the data" });
	assert.deepEqual(parseRelayArgs("--max-steps 5 --max-cost 2.5 go"), { kind: "start", maxSteps: 5, maxCost: 2.5, task: "go" });
	assert.deepEqual(parseRelayArgs("--max-cost=$3 --max-steps=5"), { kind: "start", maxSteps: 5, maxCost: 3, task: "" });
	// Flags only count before the task.
	assert.deepEqual(parseRelayArgs("--max-steps 5 go --max-cost 2"), { kind: "start", maxSteps: 5, maxCost: undefined, task: "go --max-cost 2" });
	assert.deepEqual(parseRelayArgs("--max-steps 5 go --max-steps 9"), { kind: "start", maxSteps: 5, maxCost: undefined, task: "go --max-steps 9" });
	// --max-steps is required; a bare number is no longer accepted.
	for (const bad of ["5", "5 go", "go", "--max-cost 2 go", "--max-steps", "--max-steps 0", "--max-steps x", "--max-steps -2", "--max-steps 1.5", "--max-steps 5 --max-cost", "--max-steps 5 --max-cost 0", "--max-steps 5 --max-cost abc", "--max-steps 5 --max-cost=-1"]) {
		assert.equal(parseRelayArgs(bad).kind, "error", bad);
	}
});

test("parseRelaySignal accepts only a tag wrapping the whole message", () => {
	assert.deepEqual(parseRelaySignal("\n<hand-off>\nDid step 1.\n</hand-off>\n"), { kind: "hand-off", body: "Did step 1." });
	assert.deepEqual(parseRelaySignal("<hand-off done/>"), { kind: "done" });
	assert.deepEqual(parseRelaySignal("<hand-off done />"), { kind: "done" });
	assert.deepEqual(parseRelaySignal("All finished, nothing more."), { kind: "none" });
	assert.equal(parseRelaySignal("<hand-off>  </hand-off>").kind, "invalid");
	assert.equal(parseRelaySignal("Done!\n<hand-off>x</hand-off>").kind, "invalid");
	// A literal tag inside the body is text, not a nested hand-off.
	assert.deepEqual(parseRelaySignal("<hand-off>a <hand-off>b</hand-off></hand-off>"), {
		kind: "hand-off",
		body: "a <hand-off>b</hand-off>",
	});
	const explains = "<hand-off>\nEnd with a `<hand-off>` block, not a fenced one.\n</hand-off>";
	assert.equal(parseRelaySignal(explains).kind, "hand-off");
});

test("parseRelaySignal ignores tags quoted in code fences", () => {
	const quoted = "Use this syntax:\n```\n<hand-off>body</hand-off>\n```\nthat's all.";
	assert.deepEqual(parseRelaySignal(quoted), { kind: "none" });
	const inside = "<hand-off>\nTo hand off write:\n```\n<hand-off>x</hand-off>\n```\n</hand-off>";
	assert.equal(parseRelaySignal(inside).kind, "hand-off");
});

test("sumUsage totals assistant usage and tolerates gaps", () => {
	const totals = sumUsage([
		{ role: "user" },
		{ role: "assistant", usage: { input: 10, output: 5, totalTokens: 20, cost: { total: 0.5 } } },
		{ role: "assistant", usage: { input: 1, output: 2 } },
		{ role: "assistant" },
	]);
	assert.deepEqual(totals, { input: 11, output: 7, total: 23, cost: 0.5 });
});

test("relay prompt carries provenance and the protocol", () => {
	const prompt = buildRelayPrompt("Next: step 3.", { step: 3, maxSteps: 10, fromSessionId: "abc" });
	assert.match(prompt, /^<!-- pi-hand-off relay: step 3 of 10 · handed off from pi session abc -->/);
	assert.match(prompt, /Next: step 3\./);
	assert.match(prompt, /step 3 of 10/);
	assert.match(buildRelayProtocol(10, 10), /last step/);
	assert.doesNotMatch(buildRelayProtocol(2, 10), /last step/);
	assert.match(buildRelayProtocol(0, 3), /step 0 of 3/);
	assert.doesNotMatch(buildRelayProtocol(0, 3), /last step/);
});

test("parseRelaySignal handles stop with a reason", () => {
	assert.deepEqual(parseRelaySignal("<hand-off stop>tests fail: X</hand-off>"), { kind: "stop", reason: "tests fail: X" });
	assert.equal(parseRelaySignal("<hand-off stop> </hand-off>").kind, "invalid");
	assert.equal(parseRelaySignal("Blocked.\n<hand-off stop>x</hand-off>").kind, "invalid");
});

test("protocol offers done and stop, and no hand-off on the last step", () => {
	const mid = buildRelayProtocol(2, 10);
	assert.match(mid, /<hand-off>/);
	assert.match(mid, /<hand-off done\/>/);
	assert.match(mid, /<hand-off stop>/);
	assert.match(buildRelayProtocol(10, 10), /will be refused/);
	assert.match(buildRelayNudge(2, 10, "it has no tag"), /it has no tag/);
});

test("parseModelSpec", () => {
	assert.deepEqual(parseModelSpec("anthropic/claude-x"), { model: { provider: "anthropic", modelId: "claude-x", thinkingLevel: undefined } });
	assert.deepEqual(parseModelSpec("  openai/gpt-5:high  "), { model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" } });
	// The first slash splits provider from model, as in the writer-model setting.
	assert.deepEqual(parseModelSpec("openrouter/a/b"), { model: { provider: "openrouter", modelId: "a/b", thinkingLevel: undefined } });
	for (const level of ["off", "max"]) {
		assert.deepEqual(parseModelSpec(`p/m:${level}`), { model: { provider: "p", modelId: "m", thinkingLevel: level } }, level);
	}
	for (const bad of ["", "nomodel", "/m", "p/", "p/m:high:extra", "p/m:turbo", "p/m:"]) {
		assert.ok(parseModelSpec(bad).error, JSON.stringify(bad));
	}
});

test("a staged next-hop model survives persistence, and bad ones are rejected", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-hand-off-staged-"));
	const cwd = "/tmp/staged/repo";
	const path = relayStatePath(cwd, agentDir);
	setRelayPersistence({ cwd, agentDir, model: { provider: "q", modelId: "m2" } });
	writeRelay({
		maxSteps: 3,
		spent: 0,
		sessionIds: ["a"],
		nextModel: { provider: "q", modelId: "m2", thinkingLevel: "low" },
	});
	const saved = loadPersistedRelay(path);
	assert.deepEqual(saved.record.relay.nextModel, { provider: "q", modelId: "m2", thinkingLevel: "low" });
	writeRelay(undefined);
	setRelayPersistence(undefined);
	assert.equal(existsSync(path), false);

	const base = { version: 1, pid: 123, relay: { maxSteps: 3, sessionIds: ["a"], spent: 0, nextModel: { provider: "p", modelId: "m" } } };
	assert.ok(parsePersistedRelay(JSON.stringify(base)).record.relay.nextModel);
	assert.ok(parsePersistedRelay(JSON.stringify({ ...base, relay: { ...base.relay, nextModel: { provider: 1 } } })).error);
	// An unknown thinking level is tolerated (kept undefined), as for `model`.
	const lenient = parsePersistedRelay(JSON.stringify({ ...base, relay: { ...base.relay, nextModel: { provider: "p", modelId: "m", thinkingLevel: "turbo" } } }));
	assert.equal(lenient.record.relay.nextModel.thinkingLevel, undefined);
});

const relay = (over = {}) => ({ maxSteps: 5, sessionIds: ["a", "b"], spent: 0, ...over });
const decide = (over = {}, relayOver = {}) =>
	decideRelayAction({
		relay: relay(relayOver),
		sessionId: "b",
		aborted: false,
		last: { stopReason: "stop", text: "<hand-off>next</hand-off>" },
		sessionCost: 0.5,
		...over,
	});

test("decideRelayAction hops with the new step and cumulative cost", () => {
	assert.deepEqual(decide({}, { spent: 1 }), { kind: "hop", body: "next", step: 1, spent: 1.5 });
});

test("decideRelayAction ignores unrelated sessions and pending hops", () => {
	assert.equal(decide({ sessionId: "zzz" }).kind, "ignore");
	assert.equal(decide({ sessionId: "a" }).kind, "ignore");
	assert.equal(decide({}, { pending: { prompt: "p" } }).kind, "ignore");
});

test("decideRelayAction stops on abort, bad stop reason, or missing message", () => {
	assert.equal(decide({ aborted: true }).kind, "stop");
	assert.equal(decide({ last: undefined }).kind, "stop");
	const length = decide({ last: { stopReason: "length", text: "<hand-off>x</hand-off>" } });
	assert.equal(length.kind, "stop");
	assert.equal(length.level, "error");
});

test("decideRelayAction stops on done and on an agent stop reason", () => {
	const done = decide({ last: { stopReason: "stop", text: "<hand-off done/>" } });
	assert.deepEqual([done.kind, done.level], ["stop", "info"]);
	const stop = decide({ last: { stopReason: "stop", text: "<hand-off stop>need a key</hand-off>" } });
	assert.equal(stop.kind, "stop");
	assert.match(stop.reason, /need a key/);
});

test("decideRelayAction nudges once on a missing or bad tag, then stops", () => {
	for (const text of ["All finished.", "<hand-off></hand-off>"]) {
		const last = { stopReason: "stop", text };
		assert.equal(decide({ last }).kind, "nudge", text);
		assert.equal(decide({ last }, { nudged: true }).kind, "stop", text);
	}
});

test("decideRelayAction counts hand-offs, not the first agent, against the limit", () => {
	// maxSteps 5: the first agent is step 0, so the sixth session (step 5) is the last.
	const fifth = { sessionIds: ["a", "b", "c", "d", "e"] };
	assert.deepEqual(decide({ sessionId: "e" }, fifth), { kind: "hop", body: "next", step: 4, spent: 0.5 });
	assert.equal(decide({ sessionId: "a" }, { sessionIds: ["a"], maxSteps: 1 }).kind, "hop");
});

test("decideRelayAction enforces the hand-off limit but still allows done/stop at it", () => {
	const atLimit = { sessionIds: ["a", "b", "c", "d", "e", "f"] };
	const refused = decide({ sessionId: "f" }, atLimit);
	assert.equal(refused.kind, "stop");
	assert.match(refused.reason, /limit of 5 hand-offs/);
	assert.equal(decide({ sessionId: "f", last: { stopReason: "stop", text: "<hand-off done/>" } }, atLimit).level, "info");
});

test("decideRelayAction enforces --max-cost across sessions, before hop and nudge", () => {
	assert.equal(decide({}, { maxCost: 2, spent: 1 }).kind, "hop");
	// 95% or more of the limit left in the tank is too little to start another session.
	const over = decide({}, { maxCost: 2, spent: 1.4 });
	assert.equal(over.kind, "stop");
	assert.match(over.reason, /\$2\.00 limit/);
	assert.equal(decide({ last: { stopReason: "stop", text: "no tag" } }, { maxCost: 1, spent: 1 }).kind, "stop");
	assert.equal(decide({}, {}).kind, "hop");
});

test("decideBudgetAction ramps up and fires each level once", () => {
	const act = (spent, warned = 0, maxCost = 10) => decideBudgetAction({ maxCost, spent: 0, warned }, spent);
	assert.equal(act(7.9).kind, "none");
	assert.equal(decideBudgetAction({ spent: 5 }, 100).kind, "none"); // no limit
	const heads = act(8);
	assert.deepEqual([heads.kind, heads.level], ["warn", 1]);
	assert.match(heads.message, /heads-up/);
	assert.equal(act(8.5, 1).kind, "none");
	const stop = act(9.5, 1);
	assert.deepEqual([stop.kind, stop.level], ["warn", 2]);
	assert.match(stop.message, /Stop now/);
	const last = act(9.8, 2);
	assert.deepEqual([last.kind, last.level], ["warn", 3]);
	assert.match(last.message, /<hand-off stop>/);
	assert.equal(act(9.9, 3).kind, "none");
	assert.equal(act(10, 3).kind, "abort");
	assert.equal(act(12, 0).kind, "abort");
});

test("decideBudgetAction sends one message, the highest level, when a step jumps levels", () => {
	const jump = decideBudgetAction({ maxCost: 10, spent: 1, warned: 0 }, 8.9);
	assert.deepEqual([jump.kind, jump.level], ["warn", 3]);
	// spent already counts earlier sessions
	assert.equal(decideBudgetAction({ maxCost: 10, spent: 9.9, warned: 0 }, 0.1).kind, "abort");
});

test("pause is its own signal, distinct from stop and done", () => {
	assert.deepEqual(parseRelaySignal("<hand-off pause>Which database?</hand-off>"), { kind: "pause", reason: "Which database?" });
	assert.equal(parseRelaySignal("<hand-off pause> </hand-off>").kind, "invalid");
	assert.equal(parseRelaySignal("Question below.\n<hand-off pause>x</hand-off>").kind, "invalid");
	assert.match(buildRelayProtocol(1, 3), /<hand-off pause>/);
});

test("decideRelayAction pauses without ending the relay, then resumes on the next settle", () => {
	const last = { stopReason: "stop", text: "<hand-off pause>Which database?</hand-off>" };
	assert.deepEqual(decide({ last }, { nudged: true }), { kind: "pause", reason: "Which database?" });
	// After the user replies the agent settles again; the relay evaluates it as usual.
	assert.equal(decide({}, { paused: true }).kind, "hop");
	assert.equal(decide({ last: { stopReason: "stop", text: "<hand-off done/>" } }, { paused: true }).kind, "stop");
	// A pause is allowed even on the last hand-off.
	const atLimit = { sessionIds: ["a", "b", "c", "d", "e", "f"] };
	assert.equal(decide({ sessionId: "f", last }, atLimit).kind, "pause");
});

test("parseRelayArgs resume", () => {
	assert.deepEqual(parseRelayArgs("resume"), { kind: "resume" });
});

test("relay state persists to disk and clears on stop", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-hand-off-persist-"));
	const cwd = "/tmp/some/repo";
	const model = { provider: "p", modelId: "m", thinkingLevel: "high" };
	setRelayPersistence({ cwd, agentDir, model });
	const path = relayStatePath(cwd, agentDir);
	assert.notEqual(path, relayStatePath("/tmp/other", agentDir));

	writeRelay({ maxSteps: 4, maxCost: 2, spent: 0.5, sessionIds: ["a", "b"], warned: 1, pending: { prompt: "next", started: true } });
	const saved = loadPersistedRelay(path);
	assert.deepEqual(saved.record.relay, {
		maxSteps: 4,
		sessionIds: ["a", "b"],
		maxCost: 2,
		spent: 0.5,
		paused: undefined,
		pending: { prompt: "next" },
		nextModel: undefined,
	});
	assert.deepEqual(saved.record.model, model);

	writeRelay(undefined);
	assert.equal(existsSync(path), false);
	assert.equal(readRelay(), undefined);
	assert.equal(loadPersistedRelay(path), undefined);
	setRelayPersistence(undefined);
});

test("parsePersistedRelay rejects bad data", () => {
	assert.match(parsePersistedRelay("{").error, /malformed/);
	assert.ok(parsePersistedRelay(JSON.stringify({ version: 2 })).error);
	const base = { version: 1, pid: 123, relay: { maxSteps: 3, sessionIds: ["a"], spent: 0 } };
	assert.ok(parsePersistedRelay(JSON.stringify(base)).record);
	for (const bad of [
		{ ...base.relay, maxSteps: 0 },
		{ ...base.relay, sessionIds: [] },
		{ ...base.relay, spent: -1 },
		{ ...base.relay, maxCost: 0 },
		{ ...base.relay, pending: { prompt: 5 } },
	]) {
		assert.ok(parsePersistedRelay(JSON.stringify({ ...base, relay: bad })).error, JSON.stringify(bad));
	}
	assert.ok(parsePersistedRelay(JSON.stringify({ ...base, model: { provider: 1 } })).error);
	assert.ok(parsePersistedRelay(JSON.stringify({ ...base, pid: 0 })).error);
	assert.ok(parsePersistedRelay(JSON.stringify({ ...base, pid: undefined })).error);
});

test("loadPersistedRelay reports unreadable files", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hand-off-bad-"));
	const path = join(dir, "x.json");
	writeFileSync(path, "not json");
	assert.ok(loadPersistedRelay(path).error);
});

test("a relay owned by another live process is left alone; a dead owner's is interrupted", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-hand-off-owner-"));
	const cwd = "/tmp/owner/repo";
	const path = relayStatePath(cwd, agentDir);
	mkdirSync(join(agentDir, "pi-hand-off", "relays"), { recursive: true });
	const save = (pid, startedAt) =>
		writeFileSync(path, JSON.stringify({ version: 1, pid, startedAt, cwd, relay: { maxSteps: 3, sessionIds: ["a"], spent: 0 } }));

	assert.equal(relayOwnedByOtherProcess(cwd, agentDir), undefined); // no file

	save(process.ppid); // our parent: alive, and not us
	assert.equal(isProcessAlive(process.ppid), true);
	assert.equal(relayOwnedByOtherProcess(cwd, agentDir).record.pid, process.ppid);

	save(process.pid); // our own file is never "another process"
	assert.equal(relayOwnedByOtherProcess(cwd, agentDir), undefined);

	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
	const deadPid = Number(child.stdout.toString());
	assert.equal(isProcessAlive(deadPid), false);
	save(deadPid);
	assert.equal(relayOwnedByOtherProcess(cwd, agentDir), undefined);
});

test("a reused pid is told apart by its start time", (t) => {
	const started = processStartTime(process.ppid);
	if (!started) return t.skip("ps cannot report a start time here");
	assert.equal(isRelayOwnerAlive(process.ppid, started), true);
	assert.equal(isRelayOwnerAlive(process.ppid, "Mon Jan  1 00:00:00 2001"), false);
	assert.equal(isRelayOwnerAlive(process.ppid, undefined), true); // no saved start time: pid decides

	const agentDir = mkdtempSync(join(tmpdir(), "pi-hand-off-reuse-"));
	const cwd = "/tmp/reuse/repo";
	mkdirSync(join(agentDir, "pi-hand-off", "relays"), { recursive: true });
	const path = relayStatePath(cwd, agentDir);
	const relay = { maxSteps: 3, sessionIds: ["a"], spent: 0 };
	writeFileSync(path, JSON.stringify({ version: 1, pid: process.ppid, startedAt: started, cwd, relay }));
	assert.ok(relayOwnedByOtherProcess(cwd, agentDir));
	writeFileSync(path, JSON.stringify({ version: 1, pid: process.ppid, startedAt: "Mon Jan  1 00:00:00 2001", cwd, relay }));
	assert.equal(relayOwnedByOtherProcess(cwd, agentDir), undefined);
});

test("a written relay records the owner's pid and start time", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-hand-off-owner2-"));
	setRelayPersistence({ cwd: "/tmp/own/repo", agentDir });
	writeRelay({ maxSteps: 2, spent: 0, sessionIds: ["a"] });
	const saved = loadPersistedRelay(relayStatePath("/tmp/own/repo", agentDir));
	assert.equal(saved.record.pid, process.pid);
	assert.equal(saved.record.startedAt, processStartTime(process.pid));
	writeRelay(undefined);
	setRelayPersistence(undefined);
});
