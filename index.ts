/**
 * pi-hand-off — `/hand-off` and `/hand-off-relay` for pi.
 *
 * The built-in `/new` command starts a new session, but the new runtime
 * resolves its model from the defaults chain (CLI args → scoped models →
 * saved default in settings → first available model with auth), so a model
 * switched to mid-session is lost. Both commands here replace the session and
 * then restore the chosen model and thinking level.
 *
 * `/hand-off`: hand the conversation to another model (or back to the same
 * one, with `--same`).
 *
 * 1. The user runs `/hand-off`, optionally with `--fresh` or `--live` and
 *    steering text after them.
 * 2. A dialog flow asks who writes the hand-off prompt, then asks whether the
 *    next session keeps the current model and thinking level (first option,
 *    so Enter keeps them) or opens the destination pickers — `--same` skips
 *    that dialog and re-uses the current values. Then steering instructions:
 *    text typed inline after `/hand-off` is used as-is, and an editor opens
 *    only when no inline steering was passed.
 * 3. The hand-off prompt is written by one of two writers:
 *    - the **live agent** (default, first in the picker): the extension sends
 *      the current agent a custom message asking it to write its next message
 *      as the hand-off prompt, and `agent_end` captures the final assistant
 *      message. It sees the whole transcript and keeps tool access.
 *    - the **fresh pass**: a single out-of-band `modelRegistry.complete()`
 *      call over a *minimal reconstruction* of the conversation (no tool
 *      output, no thinking, head+tail budget), so long or stale sessions can
 *      still be handed off, and a cheap model can do the writing. It has no
 *      tool access on purpose (it describes a past conversation in the past
 *      tense; the receiver checks current state), and its thinking level is chosen separately (provider
 *      default preselected).
 * 4. The extension prepends a provenance comment naming the source session
 *    (both writers; for the fresh pass, or a conversation idle an hour or more,
 *    it also says when the conversation was last active) and appends an
 *    editable authority note (the previous plan is advisory, the user's stated
 *    requirements bind, verify state), replaces the session, applies the chosen model and
 *    thinking level, and inserts the prompt into the editor.
 * 5. The user reviews, edits, and submits the prompt themselves.
 *
 * `/hand-off-relay --max-steps N [--max-cost USD] [task]`: opt-in autonomous relay. Arms a run of up to
 * N hand-offs: the current agent is step 0 and not counted, so up to N+1 sessions. Each agent ends its work with one
 * `<hand-off>…</hand-off>` block (a user-facing summary may surround it); on
 * `agent_settled` the extension extracts it and replaces the session through
 * an internal command (event contexts cannot), keeping the same model and
 * thinking level, and submits the block plus a provenance header and the
 * relay protocol as the next agent's first message. The relay state lives on
 * `globalThis` for the whole run. An agent may instead end with
 * `<hand-off done/>`, `<hand-off stop>reason</hand-off>`, or
 * `<hand-off pause>question</hand-off>`. Explicit user pauses clear only for
 * human input or `resume`, not for unrelated notification-driven turns.
 *
 * A clean settle without a signal becomes an armed `unsignalled` wait: any
 * later turn retries it, which supports arbitrary background-notification
 * systems. An optional pi-subagents adapter adds exact outstanding-task
 * tracking and defers every clean signal until results are delivered or read.
 * A malformed tag gets one correction, then a recoverable `attention` wait.
 * Replacement failure preserves the pending hand-off for `resume`. Delivery is
 * acknowledged by the exact user message starting, not by `input`; until then
 * the replacement is not a committed step and a watchdog keeps failure
 * recoverable. `resume` also re-prompts any idle unfinished relay.
 *
 * Terminal stops (done, explicit stop, abort, non-clean finish, step/cost
 * limits) deactivate the relay but retain a stopped snapshot for `resume`.
 * Limit stops require a higher `--max-steps` or `--max-cost` on resume. Cost
 * handling uses escalating steering warnings
 * at 80/95/98%, a hard abort at 100%, and no new session at 95%+. Stop and
 * `off` append a model-visible deactivation message so stale protocol
 * instructions do not provoke more tags. The decision logic is the pure
 * `decideRelayAction`; docs/relay-lifecycle.md has the complete state diagram.
 * Arming refuses while a relay runs in this session and replaces one waiting
 * on another session. Tags in code fences never count. Each hop appends a
 * `pi-hand-off:relay-hop` session entry (step, model, tokens, cost), and every
 * stop appends a `pi-hand-off:relay-stop` entry (step, reason, spent).
 * `/hand-off-relay off` disarms an active relay recoverably and discards an
 * already stopped/interrupted snapshot. Bare or `status` reports the state and
 * its next action; `resume` handles idle, paused, failed-advance, stopped, and
 * interrupted states.
 * `/hand-off-relay model [provider/model[:level]]` stages the model of the
 * *next* hop (with no argument it opens the destination picker): the current
 * session keeps its own model, so its prompt cache survives, and the settle
 * handler swaps the staged model into the hop and the handoff. A staged model
 * that has become unavailable or lost its auth is dropped with a warning at
 * hop time. Every `writeRelay`
 * also mirrors the state to `<agent-dir>/pi-hand-off/relays/<cwd-hash>.json`
 * (best effort; marked stopped or deleted when discarded), so a relay stopped
 * unexpectedly or interrupted by a
 * crash or quit can be continued with `/hand-off-relay resume`: a pending
 * hand-off is replayed into a new session, otherwise the relay re-arms on the
 * session it was interrupted in (which must be the open one). An undelivered
 * replacement can replay from the previous session if its blank session is
 * unavailable. `session_start`
 * reports a saved relay when none is running in this process. The file
 * records the writing pid and its `ps` start time (a reused pid has a different
 * one; with no start time the pid alone decides): a live other pid means the relay is running in
 * another pi process (no warning; `resume`, `off`, and arming are refused), a
 * dead one means it was interrupted. One relay per directory.
 *
 * Settings live in `<agent-dir>/pi-hand-off.json` (falling back to the legacy
 * `pi-clear.json`; read once per
 * `session_start`); CLI flags `--hand-off-max-source-chars` and
 * `--hand-off-summarizer` override the file. Without a configured writer
 * model, `/hand-off` just asks: there is no command-arg model flag.
 *
 * Mechanism:
 *   Both commands capture state as plain data into a `globalThis` property.
 *   Session replacement (`ctx.newSession()`) tears down the current runtime
 *   and recreates extension instances, but stays within the same process, so
 *   a `globalThis` property safely crosses that boundary while remaining
 *   invisible to other pi processes and dying with crashes.
 *
 *   The new instance's `session_start` handler (reason: "new") consumes the
 *   handoff and applies the model and thinking level via `pi.setModel()` /
 *   `pi.setThinkingLevel()`, which record them in the new session so they
 *   also survive `/resume`. If the handoff carries a prompt, it is inserted
 *   into the editor with `ctx.ui.setEditorText()`.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

// Model and thinking-level types, derived from the API surface because the
// package root does not re-export them directly.
type AnyModel = Parameters<ExtensionAPI["setModel"]>[0];
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

/** State carried across session replacement via `globalThis`. */
interface SessionHandoff {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	/** When present, inserted into the new session's editor (`/hand-off`). */
	prompt?: string;
}

const HANDOFF_KEY = "__pi_hand_off_handoff__";

function writeHandoff(handoff: SessionHandoff): void {
	(globalThis as Record<string, unknown>)[HANDOFF_KEY] = handoff;
}

/** Consume the handoff: read it and remove it so it can only apply once. */
function takeHandoff(): SessionHandoff | undefined {
	const store = globalThis as Record<string, unknown>;
	const handoff = store[HANDOFF_KEY];
	delete store[HANDOFF_KEY];
	return handoff as SessionHandoff | undefined;
}

const THINKING_LEVELS: ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const HANDOFF_CUSTOM_TYPE = "pi-hand-off:hand-off-request";

/**
 * Reasoning levels offered for the fresh pass. "off" is not offered: it means
 * the same thing as the provider default here, because the option is omitted
 * either way.
 */
const WRITER_REASONING_LEVELS: ThinkingLevel[] = THINKING_LEVELS.filter((level) => level !== "off");
const WRITER_DEFAULT_REASONING_LABEL = "provider default";

function sameModel(a: AnyModel | undefined, b: AnyModel | undefined): boolean {
	return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function modelLabel(model: AnyModel, current: AnyModel | undefined): string {
	return `${model.provider}/${model.id}${sameModel(model, current) ? "  (current)" : ""}`;
}

/** Match a dialog result against option labels, tolerating "  (current)"-style decorations. */
function labelIndex(chosen: string, labels: string[]): number {
	const exact = labels.indexOf(chosen);
	if (exact !== -1) return exact;
	const bare = chosen.split("  (")[0];
	return labels.findIndex((label) => label === bare || label.startsWith(`${bare}  (`));
}

function orderCurrentFirst<T>(
	items: T[],
	current: AnyModel | undefined,
	getModel: (item: T) => AnyModel,
): T[] {
	if (!current) return items;
	const first = items.filter((item) => sameModel(getModel(item), current));
	const rest = items.filter((item) => !sameModel(getModel(item), current));
	return [...first, ...rest];
}

/** A hand-off destination: the model plus an optional scope-pinned thinking level. */
interface PickedModel {
	model: AnyModel;
	thinkingLevel?: ThinkingLevel;
}

/** How the model pickers label themselves and which model they treat as current. */
interface ModelPickerOptions {
	/** Preselected model; defaults to the session's model. */
	current?: AnyModel;
	title?: string;
	providerTitle?: string;
}

async function selectModel(
	ctx: ExtensionContext,
	models: AnyModel[],
	title: string,
	current: AnyModel | undefined,
): Promise<AnyModel | undefined> {
	if (models.length === 1) return models[0];
	const ordered = orderCurrentFirst(models, current, (m) => m);
	const labels = ordered.map((m) => modelLabel(m, current));
	const chosen = await ctx.ui.select(title, labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : ordered[index];
}

/**
 * Same-or-pick picker between the writer and destination dialogs. The first
 * option re-uses the current session's model and thinking level in one Enter
 * press; the second opens the destination pickers. Without a current model
 * there is nothing to re-use, so the destination pickers open directly.
 */
async function chooseSameOrPick(ctx: ExtensionContext): Promise<"same" | "pick" | undefined> {
	if (!ctx.model) return "pick";
	const labels = [
		`${SAME_SETTINGS_LABEL}  (${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : ""})`,
		PICK_SETTINGS_LABEL,
	];
	const chosen = await ctx.ui.select("Model for the next session", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === 0 ? "same" : index === 1 ? "pick" : undefined;
}

/**
 * Thinking level picker with the active level preselected, so Enter accepts
 * the current setting.
 */
async function selectThinkingLevel(ctx: ExtensionContext): Promise<ThinkingLevel | undefined> {
	const current = ctx.thinkingLevel;
	const ordered = current
		? [current, ...THINKING_LEVELS.filter((level) => level !== current)]
		: [...THINKING_LEVELS];
	const labels = ordered.map((level) => `${level}${level === current ? "  (current)" : ""}`);
	const chosen = await ctx.ui.select("Thinking level", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : ordered[index];
}

/**
 * Thinking level for the fresh pass writer. The provider default comes first and
 * is preselected unless the config file pins a level, so pressing Enter keeps
 * today's behavior and the dialog is a no-op for most runs.
 */
async function selectWriterReasoningLevel(
	ctx: ExtensionContext,
	preselected: ThinkingLevel | undefined,
): Promise<{ reasoning?: ThinkingLevel } | undefined> {
	const ordered = preselected
		? [preselected, ...WRITER_REASONING_LEVELS.filter((level) => level !== preselected)]
		: [...WRITER_REASONING_LEVELS];
	const options: Array<{ reasoning?: ThinkingLevel; label: string }> = ordered.map((level) => ({
		reasoning: level,
		label: `${level}${level === preselected ? "  (current)" : ""}`,
	}));
	if (preselected) {
		options.push({ label: WRITER_DEFAULT_REASONING_LABEL });
	} else {
		options.unshift({ label: `${WRITER_DEFAULT_REASONING_LABEL}  (current)` });
	}

	const labels = options.map((option) => option.label);
	const chosen = await ctx.ui.select("Thinking level for the hand-off writer", labels);
	if (chosen === undefined) return undefined;
	const index = labelIndex(chosen, labels);
	return index === -1 ? undefined : { reasoning: options[index].reasoning };
}

/**
 * Non-interactive fallback (RPC mode has no custom components): scoped
 * models in one dialog when scoping is configured, otherwise a two-level
 * provider → model pick over the auth-configured catalogue.
 */
async function pickTargetModelFallback(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	const current = options.current ?? ctx.model;
	const title = options.title ?? "Hand off to model";
	const providerTitle = options.providerTitle ?? "Hand off to provider";
	const scoped = ctx.scopedModels.map((scoped) => scoped.model);

	if (scoped.length > 0) {
		// Keep the current model selectable and preselected even when scoping
		// excludes it.
		const models = current && !scoped.some((m) => sameModel(m, current)) ? [current, ...scoped] : scoped;
		const model = await selectModel(ctx, models, title, current);
		return model ? { model } : undefined;
	}

	const available = ctx.modelRegistry.getAvailable();
	const usable = available.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m));
	const models = usable.length > 0 ? usable : available;
	if (models.length === 0) {
		ctx.ui.notify("No models available to hand off to", "error");
		return undefined;
	}

	const byProvider = new Map<string, AnyModel[]>();
	for (const model of models) {
		const list = byProvider.get(model.provider) ?? [];
		list.push(model);
		byProvider.set(model.provider, list);
	}
	const providers = [...byProvider.keys()].sort();
	if (current && byProvider.has(current.provider)) {
		providers.splice(providers.indexOf(current.provider), 1);
		providers.unshift(current.provider);
	}

	const providerLabels = providers.map((p) => `${p}  (${byProvider.get(p)!.length} models)`);
	const providerChoice =
		providers.length === 1 ? providerLabels[0] : await ctx.ui.select(providerTitle, providerLabels);
	if (providerChoice === undefined) return undefined;
	const providerIndex = labelIndex(providerChoice, providerLabels);
	if (providerIndex === -1) return undefined;
	const providerName = providers[providerIndex];

	const model = await selectModel(ctx, byProvider.get(providerName) ?? [], title, current);
	return model ? { model } : undefined;
}

/**
 * `/model`-style model picker (TUI mode only): a searchable list with Tab to
 * toggle between the session's scoped models and the full catalogue.
 */
async function pickTargetModelTui(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	const current = options.current ?? ctx.model;
	const title = options.title ?? "Hand off to model";
	const allEntries: PickedModel[] = ctx.modelRegistry.getAvailable().map((model) => ({ model }));
	if (allEntries.length === 0) {
		ctx.ui.notify("No models available to hand off to", "error");
		return undefined;
	}

	// Scoped entries may pin a thinking level (`provider/model:high`); dedupe
	// by provider/id, keeping the first entry's pinned level.
	const scopedByKey = new Map<string, PickedModel>();
	for (const scoped of ctx.scopedModels) {
		const key = `${scoped.model.provider}/${scoped.model.id}`;
		if (!scopedByKey.has(key)) {
			scopedByKey.set(key, { model: scoped.model, thinkingLevel: scoped.thinkingLevel });
		}
	}
	const scopedEntries = [...scopedByKey.values()];

	if (allEntries.length === 1) return allEntries[0];

	const result = await ctx.ui.custom<PickedModel | null>((tui, theme, kb, done) => {
		const MAX_VISIBLE = 12;
		let scope: "scoped" | "all" = scopedEntries.length > 0 ? "scoped" : "all";
		let selectList: SelectList;

		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};

		const entriesForScope = () => (scope === "scoped" ? scopedEntries : allEntries);

		const makeList = (query = "") => {
			const ordered = orderCurrentFirst(entriesForScope(), current, (entry) => entry.model);
			// SelectList.setFilter() only prefix-matches item values, not labels.
			const entries = fuzzyFilter(ordered, query, ({ model }) => `${model.provider} ${model.id} ${model.name}`);
			const items: SelectItem[] = entries.map((entry, index) => ({
				value: String(index),
				label: modelLabel(entry.model, current),
				description: entry.model.name,
			}));
			const list = new SelectList(items, MAX_VISIBLE, listTheme);
			list.onSelect = (item) => done(entries[Number(item.value)] ?? null);
			list.onCancel = () => done(null);
			return list;
		};

		const container = new Container();
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
		const header = new Text("");
		container.addChild(header);
		const searchInput = new Input({ placeholder: "Type to filter" });
		container.addChild(searchInput);
		const listContainer = new Container();
		selectList = makeList();
		listContainer.addChild(selectList);
		container.addChild(listContainer);
		const updateList = () => {
			selectList = makeList(searchInput.getValue());
			listContainer.clear();
			listContainer.addChild(selectList);
		};
		const hint = new Text("");
		container.addChild(hint);
		container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));

		const updateChrome = () => {
			header.setText(
				theme.fg(
					"accent",
					theme.bold(
						`${title} — ${scope === "scoped" ? `scoped (${scopedEntries.length})` : `all (${allEntries.length})`}`,
					),
				),
			);
			const parts = ["type to filter", "enter select", "esc cancel"];
			if (scopedEntries.length > 0) {
				parts.unshift(`tab → ${scope === "scoped" ? "all models" : "scoped"}`);
			}
			hint.setText(theme.fg("dim", parts.join(" • ")));
		};
		updateChrome();

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (scopedEntries.length > 0 && kb.matches(data, "tui.input.tab")) {
					scope = scope === "scoped" ? "all" : "scoped";
					updateList();
					updateChrome();
					tui.requestRender();
					return;
				}
				if (
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.confirm") ||
					kb.matches(data, "tui.select.cancel")
				) {
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				searchInput.handleInput(data);
				updateList();
				tui.requestRender();
			},
		};
	});

	return result ?? undefined;
}

/**
 * Pick the hand-off destination model without flooding the screen.
 *
 * TUI mode gets a `/model`-style searchable picker with Tab to toggle
 * between scoped and all models; other modes fall back to plain dialogs.
 * The same picker also chooses the fresh pass's writer model, with the
 * title and preselected model supplied by the caller.
 */
async function pickTargetModel(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<PickedModel | undefined> {
	if (ctx.mode === "tui") {
		return pickTargetModelTui(ctx, options);
	}
	return pickTargetModelFallback(ctx, options);
}

/** Extract the text content of an agent message, ignoring thinking blocks and tool calls. */
function messageText(message: { role: string; content: string | Array<{ type: string; text?: string }> }): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Guidance both writers get. It is deliberately a few sentences, not a
 * template: writers already pick a shape that fits the task, and a section list
 * would get every section filled in.
 */
const WRITER_GUIDANCE = [
	"- Tell the next agent how the user has been working with you in this conversation: standing preferences and corrections they stated, and habits such as delegation, review, commit, and communication. Use only what the user said or the conversation showed; if a later instruction contradicts an earlier one, use the latest and say so.",
	"- Attribute constraints. Mark what the user said or the project's instructions require as binding, and present your own plans, hypotheses, and inferences as suggestions the next agent may overrule. Only decisions the user made are settled.",
	"- Name a branch, commit, test result, or file state only if you saw it in this conversation, and say it was observed then so the next agent verifies it.",
	"- Be as short as the task allows and follow any length guidance from the user. Finished work needs a line, not a section.",
];

export function buildHandoffRequest(steering: string): string {
	const lines = [
		"The user is handing this conversation off to a different model. Your next assistant message will be copied verbatim and submitted as the first user message of a brand-new session that has no memory of this conversation.",
		"",
		"Write that hand-off message now. It must:",
		"- Be written as instructions to the next agent (\"you\"), not a report about this conversation.",
		"- Assume the next agent has zero prior context: carry forward the current task and goal, what has been done so far (with concrete file paths, commands, and key decisions), and exactly what to do next.",
		...WRITER_GUIDANCE,
	];
	if (steering.trim()) {
		lines.push(
			"",
			"Additional guidance from the user for what the hand-off must cover:",
			"",
			steering.trim(),
		);
	}
	lines.push(
		"",
		"Output rules: reply with ONLY the hand-off message itself. No preamble, no postamble, no surrounding markdown fences, no explanations, no questions.",
	);
	return lines.join("\n");
}

// ============================================================================
// Fresh pass: one out-of-band model call over a minimal reconstruction
// ============================================================================

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. You will receive a minimal reconstruction of a long conversation between a user and an AI agent, and you must write the hand-off message that starts the next session.

Do not continue the conversation. Do not answer questions in it.

The reconstruction is lossy: tool output, thinking, and file contents are omitted, and a middle section may be elided. Do not assert file contents or the state of the working tree from memory — when something cannot be verified from the transcript, tell the next agent to verify it.

The conversation is a record of the past, likely from some time ago, and you cannot see the project as it is now. Describe the repository, branches, tasks, and results as they were when last seen in the conversation, in the past tense, never as the current state. Keep what the conversation established (the user's goals, decisions, and stated preferences, which may still hold) apart from what it merely observed (branch, commit, test results, file contents, which may have changed).`;

const DEFAULT_COVERAGE =
	"Cover the conversation thoroughly: the current task and goal, what has been done so far (with concrete file paths, commands, and decisions), and exactly what to do next.";

/** Characters of conversation sent to the fresh pass (~50k tokens at 200k). */
const DEFAULT_MAX_SOURCE_CHARS = 200_000;
/** Share of the budget kept from the newest end of the conversation. */
const TAIL_SOURCE_SHARE = 0.6;
/** Share of the budget kept contiguously after the opening message. */
const HEAD_SOURCE_SHARE = 0.4;
const USER_MESSAGE_MAX_CHARS = 8_000;
const ASSISTANT_MESSAGE_MAX_CHARS = 4_000;
const SUMMARY_MAX_CHARS = 8_000;
const NOTE_MAX_CHARS = 2_000;
const HINT_MAX_CHARS = 200;

/** A projected session message, viewed loosely: only fields the serializer reads. */
interface TranscriptSource {
	role?: string;
	content?: unknown;
	customType?: string;
	summary?: string;
	command?: string;
	/** `!!` bash executions: never sent to a model, so never sent to the writer. */
	excludeFromContext?: boolean;
}

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

/** One rendered unit of the minimal transcript; the budget never splits a block. */
interface TranscriptBlock {
	text: string;
	/** Marks the opening user message, which the budget always keeps. */
	anchor?: boolean;
}

interface TranscriptResult {
	text: string;
	/** Blocks dropped from the middle of the conversation, 0 when nothing was dropped. */
	omittedTurns: number;
	/** Characters those blocks would have contributed. */
	droppedChars: number;
}

function contentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null) blocks.push(block as ContentBlock);
	}
	return blocks;
}

/** Visible text only: thinking, tool calls, and images are dropped. */
function visibleText(content: unknown): string {
	return contentBlocks(content)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter((text) => text.length > 0)
		.join("\n");
}

function toolCallsOf(content: unknown): ContentBlock[] {
	return contentBlocks(content).filter(
		(block) => block.type === "toolCall" && typeof block.name === "string",
	);
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstStringArg(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/** Keep both ends of an over-long text, and say how much was cut. */
function truncateMiddle(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const headChars = Math.floor(maxChars * TAIL_SOURCE_SHARE);
	const tailChars = maxChars - headChars;
	const removed = text.length - maxChars;
	return `${text.slice(0, headChars)}\n[... ${removed} chars truncated ...]\n${text.slice(text.length - tailChars)}`;
}

/** One line naming a tool call and its target — never its result. */
export function formatToolHint(name: string, args: unknown): string {
	const path = stringArg(args, "path");
	switch (name) {
		case "read":
		case "edit":
		case "write":
			return path ? `${name} ${path}` : name;
		case "bash": {
			const command = stringArg(args, "command")?.split("\n")[0].trim() ?? "";
			return command ? `bash: ${command.slice(0, HINT_MAX_CHARS)}` : "bash";
		}
		case "grep": {
			const pattern = stringArg(args, "pattern");
			if (!pattern) return "grep";
			return path ? `grep: /${pattern}/ in ${path}` : `grep: /${pattern}/`;
		}
		case "ls":
			return path ? `ls: ${path}` : "ls";
		case "find": {
			const pattern = stringArg(args, "pattern");
			if (pattern && path) return `find: ${pattern} in ${path}`;
			if (path) return `find: ${path}`;
			return pattern ? `find: ${pattern}` : "find";
		}
		default: {
			const detail = path ?? firstStringArg(args);
			return detail ? `tool: ${name} ${detail.slice(0, HINT_MAX_CHARS)}` : `tool: ${name}`;
		}
	}
}

interface FileLists {
	readFiles: string[];
	modifiedFiles: string[];
}

/** Same rules pi uses for compaction: read-only files, then written/edited ones. */
function fileListsFromMessages(messages: readonly TranscriptSource[]): FileLists {
	const read = new Set<string>();
	const written = new Set<string>();
	const edited = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of toolCallsOf(message.content)) {
			const path = stringArg(call.arguments, "path");
			if (!path) continue;
			if (call.name === "read") read.add(path);
			else if (call.name === "write") written.add(path);
			else if (call.name === "edit") edited.add(path);
		}
	}
	const modified = new Set([...edited, ...written]);
	return {
		readFiles: [...read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function formatFileLists(lists: FileLists): string {
	const sections: string[] = [];
	if (lists.readFiles.length > 0) sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	if (lists.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.join("\n\n");
}

/**
 * Render the conversation as labelled blocks: visible text, tool-call hints,
 * summaries, and notes. Tool results, thinking, and stale hand-off requests
 * are dropped outright.
 */
export function renderTranscriptBlocks(messages: readonly TranscriptSource[]): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	let sawUserMessage = false;

	for (const message of messages) {
		switch (message.role) {
			case "user": {
				const text = visibleText(message.content);
				if (!text) break;
				blocks.push({
					text: `[User]: ${truncateMiddle(text, USER_MESSAGE_MAX_CHARS)}`,
					anchor: !sawUserMessage,
				});
				sawUserMessage = true;
				break;
			}
			case "assistant": {
				const text = visibleText(message.content);
				if (text) {
					blocks.push({ text: `[Assistant]: ${truncateMiddle(text, ASSISTANT_MESSAGE_MAX_CHARS)}` });
				}
				const hints = toolCallsOf(message.content).map((call) => formatToolHint(call.name!, call.arguments));
				if (hints.length > 0) blocks.push({ text: `[tools]:\n${hints.join("\n")}` });
				break;
			}
			case "toolResult":
				// Tool output never shapes the hand-off: it is the bulk of a transcript
				// and the writer is told to have the next agent verify state itself.
				break;
			case "custom": {
				if (message.customType === HANDOFF_CUSTOM_TYPE) break;
				const text = visibleText(message.content);
				if (text) blocks.push({ text: `[Note]: ${truncateMiddle(text, NOTE_MAX_CHARS)}` });
				break;
			}
			case "compactionSummary":
			case "branchSummary": {
				const summary = typeof message.summary === "string" ? message.summary.trim() : "";
				if (summary) {
					blocks.push({
						text: `[Summary of earlier conversation]: ${truncateMiddle(summary, SUMMARY_MAX_CHARS)}`,
					});
				}
				break;
			}
			case "bashExecution": {
				if (message.excludeFromContext) break;
				const command = typeof message.command === "string" ? message.command.trim() : "";
				if (command) blocks.push({ text: `[User ran]: ${truncateMiddle(command, NOTE_MAX_CHARS)}` });
				break;
			}
			default:
				break;
		}
	}

	return blocks;
}

/**
 * Keep the head and the tail of the conversation within `maxChars`, dropping
 * the middle and leaving an elision marker in its place. `maxChars <= 0`
 * disables the budget.
 */
export function applyTranscriptBudget(blocks: readonly TranscriptBlock[], maxChars: number): TranscriptResult {
	const parts = blocks.map((block) => block.text);
	const joinBlocks = (items: string[]) => items.join("\n\n");
	const full = joinBlocks(parts);
	if (maxChars <= 0 || full.length <= maxChars) {
		return { text: full, omittedTurns: 0, droppedChars: 0 };
	}

	// Head: everything up to and including the opening user message, always kept.
	const anchor = blocks.findIndex((block) => block.anchor);
	const anchorIndex = anchor === -1 ? 0 : anchor;
	let headChars = parts.slice(0, anchorIndex + 1).reduce((sum, part) => sum + part.length + 2, 0);

	// Tail: newest first, up to 60% of the budget.
	const tailBudget = Math.floor(maxChars * TAIL_SOURCE_SHARE);
	let tailStart = parts.length;
	let tailChars = 0;
	for (let i = parts.length - 1; i > anchorIndex; i--) {
		const cost = parts[i].length + 2;
		if (tailChars + cost > tailBudget) break;
		tailChars += cost;
		tailStart = i;
	}
	// Never drop the newest block: it is the most valuable one, and message-level
	// caps normally keep it well inside the tail budget.
	if (tailStart === parts.length && parts.length > anchorIndex + 1) tailStart = parts.length - 1;

	// Gap: oldest first, contiguous from just after the head, while the head
	// budget lasts.
	const headBudget = Math.floor(maxChars * HEAD_SOURCE_SHARE);
	let gapEnd = anchorIndex;
	while (gapEnd + 1 < tailStart && headChars + parts[gapEnd + 1].length + 2 <= headBudget) {
		headChars += parts[gapEnd + 1].length + 2;
		gapEnd += 1;
	}

	const omitted = parts.slice(gapEnd + 1, tailStart);
	const droppedChars = omitted.reduce((sum, part) => sum + part.length + 2, 0);
	const kept = [...parts.slice(0, gapEnd + 1)];
	if (omitted.length > 0) kept.push(`[... ${omitted.length} turns omitted — ${droppedChars} chars ...]`);
	kept.push(...parts.slice(tailStart));

	return { text: joinBlocks(kept), omittedTurns: omitted.length, droppedChars };
}

/** Minimal reconstruction of the conversation plus the file-operation footer. */
export function buildMinimalTranscript(
	messages: readonly TranscriptSource[],
	maxChars: number = DEFAULT_MAX_SOURCE_CHARS,
): TranscriptResult {
	const budget = applyTranscriptBudget(renderTranscriptBlocks(messages), maxChars);
	const fileLists = formatFileLists(fileListsFromMessages(messages));
	if (!fileLists) return budget;
	return { ...budget, text: budget.text ? `${budget.text}\n\n${fileLists}` : fileLists };
}

/** The single user message of the fresh pass. */
export function buildFreshPassUserMessage(transcript: string, steering: string, asOf?: string): string {
	return [
		"## Conversation (minimal reconstruction)",
		transcript,
		"",
		...(asOf ? [`The conversation was last active ${asOf}.`, ""] : []),
		"## What the hand-off must cover",
		steering.trim() || DEFAULT_COVERAGE,
		"",
		"Requirements for your output:",
		'- Written as instructions to the next agent ("you"), not a report about the past.',
		"- Assume zero prior context: current task and goal, what was done so far with concrete file paths, commands, and decisions, and exactly what to do next.",
		"- Name the files worth opening first.",
		...WRITER_GUIDANCE,
		"- Reply with ONLY the hand-off message: no preamble, no postamble, no fences.",
	].join("\n");
}

// ============================================================================
// Session provenance (both writers)
// ============================================================================

/**
 * HTML comment naming the session a hand-off came from, so the next agent can
 * look it up when the prompt is not enough. It is a comment, not prose, so it
 * does not read as part of the task, and it stays visible in the editor.
 */
export function buildProvenanceComment(sessionId: string | undefined, lastActive?: string): string {
	const id = sessionId?.trim();
	if (!id) return "";
	return lastActive
		? `<!-- Handed off from pi session ${id}; the conversation was last active ${lastActive} -->`
		: `<!-- Handed off from pi session ${id} -->`;
}

/** A hand-off from a conversation idle this long reads as stale (the prompt cache is long gone). */
export const STALE_GAP_MS = 60 * 60 * 1000;

/**
 * "2026-11-05 21:27 UTC (3 days before this hand-off)". UTC so the text is the
 * same wherever it is read. Returns undefined when there is no usable time.
 */
export function describeLastActive(lastActiveMs: number | undefined, nowMs: number): string | undefined {
	if (lastActiveMs === undefined || !Number.isFinite(lastActiveMs) || lastActiveMs > nowMs) return undefined;
	const minutes = Math.round((nowMs - lastActiveMs) / 60_000);
	const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
	const gap =
		minutes < 60
			? plural(minutes, "minute")
			: minutes < 48 * 60
				? plural(Math.round(minutes / 60), "hour")
				: plural(Math.round(minutes / (24 * 60)), "day");
	const when = new Date(lastActiveMs).toISOString().slice(0, 16).replace("T", " ");
	return `${when} UTC (${gap} before this hand-off)`;
}

const STANCE_NOTE =
	"The previous agent's plan, hypotheses, and suggested next steps above are a starting point, not instructions: form your own view of the problem from the code and the task. What the user stated as requirements or preferences does bind. If what you find contradicts this hand-off, trust what you can verify and say so. Ask the user only when you are blocked or when something conflicts with what they told you.";

const STALE_STANCE_NOTE =
	"This hand-off was written from a record of an earlier conversation, not from a live look at the project. The repository and its tasks may have changed since; establish the current state yourself before acting on anything described as it was.";

/** The authority note appended to a `/hand-off` prompt (never to relay hops). */
export function buildStanceNote(stale: boolean): string {
	return `**Note on authority.** ${STANCE_NOTE}${stale ? ` ${STALE_STANCE_NOTE}` : ""}`;
}

/** Time of the newest message in the session, or undefined when there is none. */
function lastMessageTime(ctx: ExtensionContext): number | undefined {
	try {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].type !== "message") continue;
			const ms = Date.parse(entries[i].timestamp);
			if (Number.isFinite(ms)) return ms;
		}
	} catch {
		// A replaced session's context cannot be read; there is simply no as-of line.
	}
	return undefined;
}

/**
 * Adds the provenance comment and the authority note around the written
 * prompt, right before `writeHandoff()`. The time line appears for the fresh
 * pass (a signal the conversation is stale) and when the live conversation had
 * been idle for `STALE_GAP_MS`.
 */
function withSessionProvenance(
	prompt: string,
	ctx: ExtensionContext,
	frame: { fresh: boolean; lastActiveMs: number | undefined },
): string {
	const lastActive = describeLastActive(frame.lastActiveMs, Date.now());
	const stale =
		lastActive !== undefined &&
		(frame.fresh || Date.now() - (frame.lastActiveMs as number) >= STALE_GAP_MS);
	const comment = buildProvenanceComment(ctx.sessionManager.getSessionId(), stale ? lastActive : undefined);
	const head = comment ? `${comment}\n\n${prompt}` : prompt;
	return `${head}\n\n---\n\n${buildStanceNote(frame.fresh || stale)}`;
}

// ============================================================================
// Fresh pass generation
// ============================================================================

/** Options for the one-shot writer call; `reasoning` is only set when supported. */
interface WriterRequestOptions {
	signal?: AbortSignal;
	cacheRetention: "none";
	sessionId: string;
	reasoning?: ThinkingLevel;
}

interface WriterOutcome {
	prompt?: string;
	error?: string;
	cancelled?: boolean;
}

/** Strip a fence that wraps the whole reply, leaving inner code blocks alone. */
function stripSurroundingFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
	const withoutOpen = trimmed.replace(/^```[^\n]*\n?/, "");
	return withoutOpen.slice(0, withoutOpen.lastIndexOf("```")).trim();
}

function checkWrittenPrompt(response: { stopReason?: string; errorMessage?: string; content?: unknown }): WriterOutcome {
	if (response.stopReason === "aborted") return { cancelled: true };
	if (response.stopReason !== "stop") {
		const detail = response.errorMessage ? `: ${response.errorMessage}` : "";
		return { error: `stopped with reason "${response.stopReason}"${detail}` };
	}
	const text = stripSurroundingFence(visibleText(response.content));
	if (!text) return { error: "returned an empty prompt" };
	return { prompt: text };
}

function reportWriterOutcome(ctx: ExtensionContext, outcome: WriterOutcome, label: string): string | undefined {
	if (outcome.prompt) return outcome.prompt;
	if (outcome.cancelled) {
		ctx.ui.notify("Hand-off cancelled", "info");
		return undefined;
	}
	ctx.ui.notify(
		`Hand-off writer (${label}) ${outcome.error ?? "failed"}; staying in this session`,
		"error",
	);
	return undefined;
}

/**
 * Run the fresh pass: one `complete()` call over the minimal transcript.
 * TUI mode gets a cancellable loader; other modes get a notification.
 */
async function generateFreshPassPrompt(
	ctx: ExtensionContext,
	model: AnyModel,
	transcript: string,
	steering: string,
	reasoning: ThinkingLevel | undefined,
	asOf?: string,
): Promise<string | undefined> {
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text: buildFreshPassUserMessage(transcript, steering, asOf) }],
		timestamp: Date.now(),
	};

	const attempt = async (signal?: AbortSignal): Promise<WriterOutcome> => {
		const options: WriterRequestOptions = { signal, cacheRetention: "none", sessionId: randomUUID() };
		// Providers default when the option is absent, and models without
		// reasoning controls would reject it; pi's own summarization does the
		// same check before setting the level.
		if (reasoning && model.reasoning) options.reasoning = reasoning;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
				options,
			);
			return checkWrittenPrompt(response);
		} catch (err) {
			return { error: `failed: ${err instanceof Error ? err.message : String(err)}` };
		}
	};

	const label = `${model.provider}/${model.id}`;

	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Writing the hand-off prompt with ${label}…`, "info");
		return reportWriterOutcome(ctx, await attempt(), label);
	}

	let aborted = false;
	let outcome: WriterOutcome | undefined;
	const prompt = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		// Abort and completion can race; `done` must only be called once.
		let finished = false;
		const finish = (value: string | null) => {
			if (finished) return;
			finished = true;
			done(value);
		};
		const loader = new BorderedLoader(tui, theme, `Writing the hand-off prompt with ${label}…`);
		loader.onAbort = () => {
			aborted = true;
			finish(null);
		};
		void attempt(loader.signal).then((result) => {
			outcome = result;
			finish(result.prompt ?? null);
		});
		return loader;
	});

	if (prompt) return prompt;
	if (aborted) {
		ctx.ui.notify("Hand-off cancelled", "info");
		return undefined;
	}
	return reportWriterOutcome(ctx, outcome ?? { error: "returned no prompt" }, label);
}

// ============================================================================
// Command arguments, writer choice, and settings
// ============================================================================

interface ParsedHandoffArgs {
	writer?: "live" | "fresh";
	/** `--same`: skip the destination pickers and reuse the current session's model and thinking level. */
	same?: boolean;
	/** Everything after the leading flags: the steering-editor prefill. */
	steering: string;
	error?: string;
}

/** Parse leading `/hand-off` flags; the first unrecognized token starts the steering text. */
export function parseHandoffArgs(args: string): ParsedHandoffArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const parsed: ParsedHandoffArgs = { steering: "" };
	let index = 0;

	for (; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--fresh" || token === "--live") {
			const writer = token === "--fresh" ? "fresh" : "live";
			if (parsed.writer && parsed.writer !== writer) {
				return { ...parsed, error: "--fresh and --live cannot be combined; nothing was sent" };
			}
			parsed.writer = writer;
			continue;
		}
		if (token === "--same") {
			parsed.same = true;
			continue;
		}
		break;
	}

	parsed.steering = tokens.slice(index).join(" ");
	return parsed;
}

export interface HandoffSettings {
	summarizerModel?: string;
	askSummarizerModel?: boolean;
	/** Thinking level for the fresh pass; absent means the provider default. */
	summarizerThinkingLevel?: ThinkingLevel;
	maxSourceChars?: number;
}

const SETTINGS_FILE_NAME = "pi-hand-off.json";
/** Settings file of the package this one was split from; read when the new file does not exist. */
const LEGACY_SETTINGS_FILE_NAME = "pi-clear.json";
const FLAG_MAX_SOURCE_CHARS = "hand-off-max-source-chars";
const FLAG_SUMMARIZER = "hand-off-summarizer";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `<agent-dir>/pi-hand-off.json`, falling back to the legacy
 * `pi-clear.json` when it does not exist. With an explicit `path` no fallback
 * applies. A malformed file is a warning, not a failure.
 */
export function loadHandoffSettings(path?: string): {
	settings: HandoffSettings;
	warning?: string;
} {
	if (path !== undefined) return readHandoffSettingsFile(path);
	const dir = getAgentDir();
	const primary = join(dir, SETTINGS_FILE_NAME);
	if (existsSync(primary)) return readHandoffSettingsFile(primary);
	const legacy = join(dir, LEGACY_SETTINGS_FILE_NAME);
	return existsSync(legacy) ? readHandoffSettingsFile(legacy) : { settings: {} };
}

function readHandoffSettingsFile(path: string): {
	settings: HandoffSettings;
	warning?: string;
} {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return { settings: {} };
		return { settings: {}, warning: `pi-hand-off: could not read ${path}: ${messageOf(err)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { settings: {}, warning: `pi-hand-off: ignoring malformed ${path}: ${messageOf(err)}` };
	}

	if (!isRecord(parsed) || !isRecord(parsed.handoff)) {
		return { settings: {}, warning: `pi-hand-off: ignoring ${path}: expected a "handoff" object` };
	}

	const handoff = parsed.handoff;
	const settings: HandoffSettings = {};
	const problems: string[] = [];

	if (handoff.summarizerModel !== undefined) {
		if (typeof handoff.summarizerModel === "string" && handoff.summarizerModel.includes("/")) {
			settings.summarizerModel = handoff.summarizerModel.trim();
		} else {
			problems.push('"summarizerModel" must be a "provider/model" string');
		}
	}
	if (handoff.summarizerThinkingLevel !== undefined) {
		const value = handoff.summarizerThinkingLevel;
		// "default" (and "off") mean "leave the choice to the provider", the same
		// as omitting the key.
		if (value === "default" || value === "off") {
			// Nothing to record.
		} else if (typeof value === "string" && WRITER_REASONING_LEVELS.includes(value as ThinkingLevel)) {
			settings.summarizerThinkingLevel = value as ThinkingLevel;
		} else {
			problems.push(
				`"summarizerThinkingLevel" must be "default" or one of ${WRITER_REASONING_LEVELS.join(", ")}`,
			);
		}
	}
	if (handoff.askSummarizerModel !== undefined) {
		if (typeof handoff.askSummarizerModel === "boolean") settings.askSummarizerModel = handoff.askSummarizerModel;
		else problems.push('"askSummarizerModel" must be true or false');
	}
	if (handoff.maxSourceChars !== undefined) {
		if (typeof handoff.maxSourceChars === "number" && Number.isFinite(handoff.maxSourceChars) && handoff.maxSourceChars >= 0) {
			settings.maxSourceChars = Math.floor(handoff.maxSourceChars);
		} else {
			problems.push('"maxSourceChars" must be a number >= 0');
		}
	}

	return problems.length > 0
		? { settings, warning: `pi-hand-off: ignoring ${path} ${problems.join(", ")}` }
		: { settings };
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Command arg > pi CLI flag > config file > built-in default. */
export function resolveMaxSourceChars(flagValue: unknown, settings: HandoffSettings): number {
	if (typeof flagValue === "string" && flagValue.trim()) {
		const fromFlag = Number(flagValue);
		if (Number.isFinite(fromFlag) && fromFlag >= 0) return Math.floor(fromFlag);
	}
	if (settings.maxSourceChars !== undefined) return settings.maxSourceChars;
	return DEFAULT_MAX_SOURCE_CHARS;
}

/** `118234` → `118k`, for the trimming notice. */
function formatChars(chars: number): string {
	if (chars < 1000) return String(chars);
	if (chars < 1_000_000) return `${Math.round(chars / 1000)}k`;
	return `${(chars / 1_000_000).toFixed(1)}M`;
}

type WriterChoice = { kind: "live" } | { kind: "fresh"; model: AnyModel };

interface WriterOptions {
	/** From `--fresh` / `--live`; skips the writer picker. */
	writer?: "live" | "fresh";
	/** Model pinned by command arg, pi flag, or config. */
	pinnedModel?: AnyModel;
	/** Whether the summarizer model picker still needs to open. */
	askSummarizer: boolean;
}

const WRITER_LIVE_LABEL = "This agent — full context and tools";
const WRITER_FRESH_OTHER_LABEL = "Fresh pass — another model…";
const SAME_SETTINGS_LABEL = "Same model and thinking level";
const PICK_SETTINGS_LABEL = "Pick a model and thinking level…";

/** Pick the hand-off writer: the live agent, or a fresh pass with a chosen model. */
async function chooseWriter(ctx: ExtensionContext, options: WriterOptions): Promise<WriterChoice | undefined> {
	const withCurrentModel = (): WriterChoice | undefined => {
		const model = options.pinnedModel ?? ctx.model;
		if (!model) {
			ctx.ui.notify("No current model to write the hand-off; pick another model", "error");
			return undefined;
		}
		return { kind: "fresh", model };
	};

	const askForModel = async (): Promise<WriterChoice | undefined> => {
		if (!options.askSummarizer) return withCurrentModel();
		const picked = await pickTargetModel(ctx, {
			current: options.pinnedModel ?? ctx.model,
			title: "Hand-off writer model",
			providerTitle: "Hand-off writer provider",
		});
		if (!picked) return undefined;
		if (!ctx.modelRegistry.hasConfiguredAuth(picked.model)) {
			ctx.ui.notify(
				`No auth configured for ${picked.model.provider}/${picked.model.id}; staying in this session`,
				"error",
			);
			return undefined;
		}
		return { kind: "fresh", model: picked.model };
	};

	if (options.writer === "live") return { kind: "live" };
	if (options.writer === "fresh") return askForModel();

	const labels = [
		WRITER_LIVE_LABEL,
		options.pinnedModel
			? `Fresh pass — ${options.pinnedModel.provider}/${options.pinnedModel.id}`
			: "Fresh pass — current model",
		WRITER_FRESH_OTHER_LABEL,
	];
	const chosen = await ctx.ui.select("Who writes the hand-off prompt?", labels);
	if (chosen === undefined) return undefined;

	switch (labelIndex(chosen, labels)) {
		case 0:
			return { kind: "live" };
		case 1:
			return withCurrentModel();
		case 2:
			return askForModel();
		default:
			return undefined;
	}
}

// ============================================================================
// Autonomous relay (`/hand-off-relay --max-steps N`)
// ============================================================================

/**
 * Relay state, kept on `globalThis` for the whole run (unlike `SessionHandoff`
 * it is not consumed) so the depth counter survives session replacement.
 */
export interface RelayBackgroundTask {
	id: string;
	type: string;
	description: string;
	/** Adapter that reported this task, e.g. `pi-subagents`. */
	source: string;
	/** Whether completion is expected to arrive in a later notification. */
	background?: boolean;
}

export type RelayWaiting =
	| { kind: "user"; reason: string }
	| { kind: "attention"; reason: string }
	| { kind: "background" }
	| { kind: "unsignalled"; reason: string };

interface RelayState {
	/** Maximum number of hand-offs; the agent that armed the relay is step 0 and not counted. */
	maxSteps: number;
	/**
	 * Session IDs in the order they ran, latest last. The last one is the
	 * session the relay is waiting on (other sessions never advance it), and
	 * the length minus one is the current step.
	 */
	sessionIds: string[];
	/** Stop before the next hand-off once spent cost reaches this many dollars. */
	maxCost?: number;
	/** Cost of the sessions already left; the current session's cost is added on top. */
	spent: number;
	/**
	 * Why an idle relay must not evaluate the latest assistant message as a
	 * final relay signal. User waits clear only for interactive human input or
	 * `resume`. Unsignalled and attention waits also clear when another turn
	 * starts. Background waits additionally require result delivery/consumption.
	 */
	waiting?: RelayWaiting;
	/** Background work reported by an optional integration such as pi-subagents. */
	backgroundTasks?: RelayBackgroundTask[];
	/** Completed background result IDs not yet delivered to or read by the main agent. */
	backgroundNotifications?: string[];
	/** Highest budget warning level already sent in the current session (0 = none). */
	warned?: number;
	/** The current session was already asked once to fix a missing/malformed final message. */
	nudged?: boolean;
	/**
	 * Model staged with `/hand-off-relay model` for the next hop. Consumed by
	 * the next settle (which writes it into the hop and the handoff); the
	 * current session keeps running on its own model, so its prompt cache
	 * survives.
	 */
	nextModel?: PersistedRelayModel;
	/**
	 * A hand-off extracted from the settled agent, waiting for the step command.
	 * `started` flips once that command runs, so a watchdog can tell "never ran".
	 */
	pending?: { prompt: string; started?: boolean; deliverHere?: boolean; targetSessionId?: string };
}

const RELAY_KEY = "__pi_hand_off_relay__";
const RELAY_STOPPED_KEY = "__pi_hand_off_relay_stopped__";
const RELAY_DELIVERY_KEY = "__pi_hand_off_relay_delivery__";

interface RelayDeliveryAttempt {
	cwd: string;
	targetSessionId: string;
	prompt: string;
	state: "preflight" | "failed";
}

function readDeliveryAttempt(): RelayDeliveryAttempt | undefined {
	return (globalThis as Record<string, unknown>)[RELAY_DELIVERY_KEY] as RelayDeliveryAttempt | undefined;
}

/** Prevent two resumes from entering pi's non-cancellable input/model/auth preflight. */
function claimDelivery(cwd: string, targetSessionId: string, prompt: string): { attempt?: RelayDeliveryAttempt; error?: string } {
	const existing = readDeliveryAttempt();
	if (existing?.state === "preflight" && existing.cwd === cwd && existing.prompt === prompt) {
		return {
			error: "An earlier hand-off send may still be in pi's input/model/auth preflight. Wait for it to finish; if it is stuck, restart pi and resume the saved relay. No duplicate prompt was sent.",
		};
	}
	const attempt: RelayDeliveryAttempt = { cwd, targetSessionId, prompt, state: "preflight" };
	(globalThis as Record<string, unknown>)[RELAY_DELIVERY_KEY] = attempt;
	return { attempt };
}

function finishDelivery(attempt: RelayDeliveryAttempt, failed: boolean): void {
	if (readDeliveryAttempt() !== attempt) return;
	if (failed) attempt.state = "failed";
	else delete (globalThis as Record<string, unknown>)[RELAY_DELIVERY_KEY];
}
const RELAY_COMMAND = "pi-hand-off-relay-advance";
/** How long the internal advance command has to start before the relay gives up. */
const ADVANCE_WATCHDOG_MS = 10_000;
const RELAY_PROTOCOL_TYPE = "pi-hand-off:relay-protocol";
const RELAY_STATE_TYPE = "pi-hand-off:relay-state";
const RELAY_HOP_ENTRY_TYPE = "pi-hand-off:relay-hop";
const RELAY_STOP_ENTRY_TYPE = "pi-hand-off:relay-stop";

export function readRelay(): RelayState | undefined {
	return (globalThis as Record<string, unknown>)[RELAY_KEY] as RelayState | undefined;
}

export function relayPhase(relay: RelayState): "advancing" | RelayWaiting["kind"] | "running" {
	if (relay.waiting?.kind === "attention") return "attention";
	if (relay.pending) return "advancing";
	return relay.waiting?.kind ?? "running";
}

function relayPhaseLabel(relay: RelayState): string {
	const labels = {
		running: "running",
		background: "waiting for background work",
		unsignalled: "idle without a relay signal",
		user: "waiting for your reply",
		attention: "needs attention",
		advancing: "advancing",
	} as const;
	return labels[relayPhase(relay)];
}

function awaitingBackgroundNotification(relay: RelayState | undefined): boolean {
	return (relay?.backgroundNotifications?.length ?? 0) > 0;
}

function clearBackgroundNotifications(relay: RelayState, ids?: readonly string[]): void {
	const pending = ids
		? (relay.backgroundNotifications ?? []).filter((id) => !ids.includes(id))
		: [];
	relay.backgroundNotifications = pending.length > 0 ? pending : undefined;
	if (pending.length === 0 && (relay.backgroundTasks?.length ?? 0) === 0 && relay.waiting?.kind === "background") {
		relay.waiting = undefined;
	}
}

/** Add or refresh a background task reported by an integration adapter. */
export function trackRelayBackgroundTask(relay: RelayState, task: RelayBackgroundTask): RelayState {
	const existing = relay.backgroundTasks?.find((candidate) => candidate.id === task.id && candidate.source === task.source);
	const merged = { ...task, background: existing?.background || task.background || undefined };
	const others = relay.backgroundTasks?.filter((candidate) => candidate !== existing) ?? [];
	return { ...relay, backgroundTasks: [...others, merged] };
}

/** Mark a task complete and guard its result until delivery or consumption. */
export function completeRelayBackgroundTask(relay: RelayState, source: string, id: string): RelayState {
	const task = relay.backgroundTasks?.find((candidate) => candidate.id === id && candidate.source === source);
	if (!task) return relay;
	const remaining = relay.backgroundTasks?.filter((candidate) => candidate !== task) ?? [];
	const backgroundNotifications = relay.backgroundNotifications ?? [];
	const pending = task.background && !backgroundNotifications.includes(id)
		? [...backgroundNotifications, id]
		: backgroundNotifications;
	return {
		...relay,
		backgroundTasks: remaining.length > 0 ? remaining : undefined,
		backgroundNotifications: pending.length > 0 ? pending : undefined,
	};
}

/** A later turn retries generic waits, but never discards an unread background result. */
export function continueRelayForTurn(relay: RelayState): RelayState {
	if (relay.pending) return relay;
	return {
		...relay,
		waiting: relay.waiting?.kind === "user" ? relay.waiting : undefined,
	};
}

/** Actual human input clears explicit waits, but still cannot discard unread results. */
export function continueRelayForUser(relay: RelayState): RelayState {
	if (relay.pending) return relay;
	return { ...relay, waiting: undefined, nudged: false };
}

/** 0-based position of the current agent: the one that armed the relay is step 0. */
function relayStep(relay: RelayState): number {
	return relay.sessionIds.length - 1;
}

// ---- Persistence --------------------------------------------------------
//
// The in-process `globalThis` state stays the source of truth; every
// `writeRelay` mirrors it to `<agent-dir>/pi-hand-off/relays/<cwd-hash>.json`
// (best effort) so a stopped relay or one interrupted by a crash or quit can
// be resumed with `/hand-off-relay resume`. One file per working directory, so
// relays in different repos never collide. `off` on a stopped/interrupted
// snapshot discards it; starting or resuming a relay replaces it with active state.

/** Model and thinking level to restore when a persisted relay is resumed. */
export interface PersistedRelayModel {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
}

export interface RelayStopped {
	reason: string;
	level: "info" | "warning" | "error";
	at: string;
	/** A limit stop requires a correspondingly higher override on resume. */
	limit?: "steps" | "cost";
}

export interface PersistedRelay {
	version: 1;
	/** Writer identity for active records; stopped snapshots have no active owner. */
	pid: number;
	/** When that process started (`ps` text); tells it apart from an unrelated process that reused the pid. */
	startedAt?: string;
	cwd: string;
	savedAt: string;
	model?: PersistedRelayModel;
	relay: RelayState;
	/** Terminal autonomy is off, but the user can still resume this snapshot. */
	stopped?: RelayStopped;
}

/** Where the relay for `cwd` is persisted. */
export function relayStatePath(cwd: string, agentDir: string = getAgentDir()): string {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(agentDir, "pi-hand-off", "relays", `${hash}.json`);
}

/** Validate one persisted `{provider, modelId, thinkingLevel?}` object. */
function parsePersistedModel(value: unknown, label: string): { model?: PersistedRelayModel; error?: string } {
	if (value === undefined) return {};
	const m = value as { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
	if (!isRecord(m) || typeof m.provider !== "string" || typeof m.modelId !== "string") {
		return { error: `invalid ${label}` };
	}
	return {
		model: {
			provider: m.provider,
			modelId: m.modelId,
			thinkingLevel: THINKING_LEVELS.includes(m.thinkingLevel as ThinkingLevel)
				? (m.thinkingLevel as ThinkingLevel)
				: undefined,
		},
	};
}

/** Validate untrusted JSON from disk; returns an error string instead of throwing. */
export function parsePersistedRelay(raw: string): { record: PersistedRelay } | { error: string } {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		return { error: `malformed JSON: ${messageOf(err)}` };
	}
	if (!isRecord(data) || data.version !== 1) return { error: "unsupported format" };
	const relay = data.relay;
	if (!isRecord(relay)) return { error: "missing relay state" };
	const ids = relay.sessionIds;
	if (!Number.isInteger(relay.maxSteps) || (relay.maxSteps as number) < 1) return { error: "invalid maxSteps" };
	if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id)) {
		return { error: "invalid sessionIds" };
	}
	if (typeof relay.spent !== "number" || !Number.isFinite(relay.spent) || relay.spent < 0) {
		return { error: "invalid spent" };
	}
	if (relay.maxCost !== undefined && !(typeof relay.maxCost === "number" && relay.maxCost > 0)) {
		return { error: "invalid maxCost" };
	}
	const pending = relay.pending;
	if (
		pending !== undefined &&
		!(isRecord(pending) && typeof pending.prompt === "string" &&
			(pending.deliverHere === undefined || typeof pending.deliverHere === "boolean") &&
			(pending.targetSessionId === undefined || (typeof pending.targetSessionId === "string" && pending.targetSessionId)))
	) {
		return { error: "invalid pending hand-off" };
	}
	let waiting: RelayWaiting | undefined;
	if (relay.waiting !== undefined) {
		const candidate = relay.waiting;
		if (!isRecord(candidate) || !["user", "attention", "background", "unsignalled"].includes(candidate.kind as string)) {
			return { error: "invalid waiting state" };
		}
		if (candidate.kind === "background") waiting = { kind: "background" };
		else if (typeof candidate.reason === "string" && candidate.reason.trim()) {
			waiting = { kind: candidate.kind as "user" | "attention" | "unsignalled", reason: candidate.reason };
		} else return { error: "invalid waiting reason" };
	} else if (relay.paused === true) {
		// Version-1 files before the explicit waiting state only stored `paused`.
		waiting = { kind: "user", reason: "the agent asked for your answer" };
	}
	const backgroundTasks: RelayBackgroundTask[] = [];
	if (relay.backgroundTasks !== undefined) {
		if (!Array.isArray(relay.backgroundTasks)) return { error: "invalid background tasks" };
		for (const value of relay.backgroundTasks) {
			if (
				!isRecord(value) ||
				typeof value.id !== "string" || !value.id ||
				typeof value.type !== "string" ||
				typeof value.description !== "string" ||
				typeof value.source !== "string" || !value.source
			) return { error: "invalid background task" };
			backgroundTasks.push({
				id: value.id,
				type: value.type,
				description: value.description,
				source: value.source,
				background: value.background === true ? true : undefined,
			});
		}
	}
	if (
		relay.backgroundNotifications !== undefined &&
		(!Array.isArray(relay.backgroundNotifications) ||
			!relay.backgroundNotifications.every((id) => typeof id === "string" && id))
	) return { error: "invalid background notifications" };
	let model: PersistedRelayModel | undefined;
	const parsedModel = parsePersistedModel(data.model, "model");
	if (parsedModel.error) return { error: parsedModel.error };
	model = parsedModel.model;
	let nextModel: PersistedRelayModel | undefined;
	if (relay.nextModel !== undefined) {
		const parsedNext = parsePersistedModel(relay.nextModel, "nextModel");
		if (parsedNext.error) return { error: parsedNext.error };
		nextModel = parsedNext.model;
	}
	let stopped: RelayStopped | undefined;
	if (data.stopped !== undefined) {
		if (
			!isRecord(data.stopped) ||
			typeof data.stopped.reason !== "string" || !data.stopped.reason ||
			!["info", "warning", "error"].includes(data.stopped.level as string) ||
			typeof data.stopped.at !== "string" || !data.stopped.at ||
			(data.stopped.limit !== undefined && !["steps", "cost"].includes(data.stopped.limit as string))
		) return { error: "invalid stopped state" };
		stopped = {
			reason: data.stopped.reason,
			level: data.stopped.level as RelayStopped["level"],
			at: data.stopped.at,
			limit: data.stopped.limit as RelayStopped["limit"],
		};
	}
	if (!Number.isInteger(data.pid) || (data.pid as number) < 1) return { error: "invalid pid" };
	return {
		record: {
			version: 1,
			pid: data.pid as number,
			startedAt: typeof data.startedAt === "string" && data.startedAt ? data.startedAt : undefined,
			cwd: typeof data.cwd === "string" ? data.cwd : "",
			savedAt: typeof data.savedAt === "string" ? data.savedAt : "",
			model,
			stopped,
			relay: {
				maxSteps: relay.maxSteps as number,
				sessionIds: ids as string[],
				maxCost: relay.maxCost as number | undefined,
				spent: relay.spent,
				waiting,
				backgroundTasks: backgroundTasks.length > 0 ? backgroundTasks : undefined,
				backgroundNotifications: relay.backgroundNotifications as string[] | undefined,
				pending: pending
					? {
						prompt: (pending as { prompt: string }).prompt,
						...((pending as { deliverHere?: unknown }).deliverHere === true ? { deliverHere: true as const } : {}),
						...(typeof (pending as { targetSessionId?: unknown }).targetSessionId === "string"
							? { targetSessionId: (pending as { targetSessionId: string }).targetSessionId }
							: {}),
					}
					: undefined,
				nextModel,
			},
		},
	};
}

/** Read the persisted relay at `path`; undefined when there is none. */
export function loadPersistedRelay(path: string): { record: PersistedRelay } | { error: string } | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return undefined;
		return { error: messageOf(err) };
	}
	return parsePersistedRelay(raw);
}

/**
 * Start time of a process as `ps` prints it, or undefined when it cannot be
 * read (no `ps`, no such process, Windows). `LC_ALL=C` keeps the format
 * identical between the process that writes it and the one that compares it.
 */
export function processStartTime(pid: number): string | undefined {
	try {
		const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
			env: { ...process.env, LC_ALL: "C" },
		});
		const text = result.status === 0 ? result.stdout.trim() : "";
		return text || undefined;
	} catch {
		return undefined;
	}
}

let cachedOwnStartTime: string | undefined | null = null;
function ownStartTime(): string | undefined {
	if (cachedOwnStartTime === null) cachedOwnStartTime = processStartTime(process.pid);
	return cachedOwnStartTime;
}

/**
 * Whether the process that wrote a saved relay is still running. A pid alone
 * can be reused by an unrelated process, so when both sides have a start time
 * they must match; if either could not be read, the pid check decides.
 */
export function isRelayOwnerAlive(pid: number, startedAt: string | undefined): boolean {
	if (!isProcessAlive(pid)) return false;
	if (!startedAt) return true;
	const current = processStartTime(pid);
	return current === undefined || current === startedAt;
}

/** Whether a process with this pid exists. A reused pid can look alive; that errs on the safe side. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as { code?: string }).code === "EPERM";
	}
}

/**
 * The saved relay for `cwd` when another live pi process owns it (so this
 * process must leave it alone), or undefined when there is none or its owner
 * is gone.
 */
export function relayOwnedByOtherProcess(
	cwd: string,
	agentDir?: string,
): { record: PersistedRelay } | undefined {
	const saved = loadPersistedRelay(relayStatePath(cwd, agentDir));
	if (!saved || "error" in saved) return undefined;
	if (saved.record.stopped) return undefined;
	const { pid, startedAt } = saved.record;
	return pid !== process.pid && isRelayOwnerAlive(pid, startedAt) ? saved : undefined;
}

function ownedElsewhereMessage(record: PersistedRelay): string {
	return `A hand-off relay is running in another pi process (pid ${record.pid}) in this directory, at step ${relayStep(record.relay)} of ${record.relay.maxSteps}.`;
}

/** Where, and with which model, the running relay is persisted; set when a relay arms or a session starts. */
let persistence: { cwd: string; agentDir?: string; model?: PersistedRelayModel } | undefined;

export function setRelayPersistence(target: typeof persistence): void {
	persistence = target;
}

function snapshotRelay(relay: RelayState, stopped?: RelayStopped): PersistedRelay | undefined {
	if (!persistence) return undefined;
	return {
		version: 1,
		pid: process.pid,
		startedAt: ownStartTime(),
		cwd: persistence.cwd,
		savedAt: new Date().toISOString(),
		model: persistence.model,
		stopped,
		relay: {
			maxSteps: relay.maxSteps,
			sessionIds: relay.sessionIds,
			maxCost: relay.maxCost,
			spent: relay.spent,
			waiting: relay.waiting,
			backgroundTasks: relay.backgroundTasks,
			backgroundNotifications: relay.backgroundNotifications,
			pending: relay.pending ? {
				prompt: relay.pending.prompt,
				deliverHere: relay.pending.deliverHere,
				targetSessionId: relay.pending.targetSessionId,
			} : undefined,
			nextModel: relay.nextModel,
		},
	};
}

function persistRecord(record: PersistedRelay | undefined): boolean {
	if (!persistence) return false;
	const path = relayStatePath(persistence.cwd, persistence.agentDir);
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		if (!record) {
			rmSync(path, { force: true });
			return true;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, JSON.stringify(record, null, 2));
		renameSync(tmp, path);
		return true;
	} catch {
		// Persistence is a convenience; the relay itself must never fail because of it.
		try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
		return false;
	}
}

export function writeRelay(relay: RelayState | undefined): void {
	const store = globalThis as Record<string, unknown>;
	if (relay) store[RELAY_KEY] = relay;
	else delete store[RELAY_KEY];
	delete store[RELAY_STOPPED_KEY];
	persistRecord(relay ? snapshotRelay(relay) : undefined);
}

function stopRelaySnapshot(relay: RelayState, stopped: RelayStopped): { durable: boolean; recoverable: boolean } {
	const store = globalThis as Record<string, unknown>;
	delete store[RELAY_KEY];
	const record = snapshotRelay(relay, stopped);
	if (record) store[RELAY_STOPPED_KEY] = record;
	else delete store[RELAY_STOPPED_KEY];
	const durable = persistRecord(record);
	if (record && !durable) {
		// Do not leave an older active record claiming that this live process still
		// owns the relay. The in-memory snapshot remains resumable in this process.
		try { rmSync(relayStatePath(record.cwd, persistence?.agentDir), { force: true }); } catch { /* best effort */ }
	}
	return { durable, recoverable: record !== undefined };
}

/** The newest stopped snapshot for this directory, whether in-process or recovered from disk. */
export function readStoppedRelay(cwd: string): { record: PersistedRelay } | undefined {
	const memory = (globalThis as Record<string, unknown>)[RELAY_STOPPED_KEY] as PersistedRelay | undefined;
	const inProcess = memory?.stopped && memory.cwd === cwd ? memory : undefined;
	const saved = loadPersistedRelay(relayStatePath(cwd));
	const disk = saved && "record" in saved ? saved.record : undefined;
	if (inProcess && (!disk || inProcess.savedAt > disk.savedAt)) return { record: inProcess };
	return disk?.stopped ? { record: disk } : undefined;
}

export type RelayArgs =
	| { kind: "start"; maxSteps: number; maxCost?: number; task: string }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "model"; spec: string }
	| { kind: "resume"; maxSteps?: number; maxCost?: number }
	| { kind: "error"; error: string };

const RELAY_USAGE =
	"/hand-off-relay needs `--max-steps N` (the number of hand-offs; the agent you start in is step 0 and not counted), or `off` / `status` / `model` / `resume`";

/** Value of `--name V` or `--name=V` at `tokens[i]`, and how many tokens it used. */
function flagValue(tokens: string[], i: number, name: string): { raw: string | undefined; used: number } | undefined {
	const token = tokens[i];
	if (token === name) return { raw: tokens[i + 1], used: 2 };
	if (token.startsWith(`${name}=`)) return { raw: token.slice(name.length + 1), used: 1 };
	return undefined;
}

/**
 * Parse `--max-steps N [--max-cost USD] [task text]`, or `off` / `status` /
 * `resume` / `model [spec]`; no arguments means `status`. Like `/hand-off`, flags
 * are only recognized before the task, in any order.
 */
export function parseRelayArgs(args: string): RelayArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const first = tokens[0];
	if (first === undefined || first === "status") return { kind: "status" };
	if (first === "off") return { kind: "off" };
	if (first === "model") return { kind: "model", spec: tokens.slice(1).join(" ") };
	if (first === "resume") {
		let maxSteps: number | undefined;
		let maxCost: number | undefined;
		let i = 1;
		while (i < tokens.length) {
			const steps = flagValue(tokens, i, "--max-steps");
			if (steps) {
				if (steps.raw === undefined || !/^\d+$/.test(steps.raw) || Number(steps.raw) < 1) {
					return { kind: "error", error: "--max-steps needs a positive whole number, e.g. --max-steps 8" };
				}
				maxSteps = Number(steps.raw);
				i += steps.used;
				continue;
			}
			const cost = flagValue(tokens, i, "--max-cost");
			if (cost) {
				const amount = cost.raw !== undefined && /^\$?\d+(\.\d+)?$/.test(cost.raw) ? Number(cost.raw.replace("$", "")) : NaN;
				if (!(amount > 0)) return { kind: "error", error: "--max-cost needs a positive dollar amount, e.g. --max-cost 5" };
				maxCost = amount;
				i += cost.used;
				continue;
			}
			return { kind: "error", error: "resume accepts only --max-steps N and --max-cost USD" };
		}
		return {
			kind: "resume",
			...(maxSteps !== undefined ? { maxSteps } : {}),
			...(maxCost !== undefined ? { maxCost } : {}),
		};
	}

	let maxSteps: number | undefined;
	let maxCost: number | undefined;
	let i = 0;
	while (i < tokens.length) {
		const steps = flagValue(tokens, i, "--max-steps");
		if (steps) {
			if (steps.raw === undefined || !/^\d+$/.test(steps.raw) || Number(steps.raw) < 1) {
				return { kind: "error", error: "--max-steps needs a positive whole number, e.g. --max-steps 8" };
			}
			maxSteps = Number(steps.raw);
			i += steps.used;
			continue;
		}
		const cost = flagValue(tokens, i, "--max-cost");
		if (cost) {
			const amount = cost.raw !== undefined && /^\$?\d+(\.\d+)?$/.test(cost.raw) ? Number(cost.raw.replace("$", "")) : NaN;
			if (!(amount > 0)) return { kind: "error", error: "--max-cost needs a positive dollar amount, e.g. --max-cost 5" };
			maxCost = amount;
			i += cost.used;
			continue;
		}
		break;
	}
	if (maxSteps === undefined) return { kind: "error", error: RELAY_USAGE };
	return { kind: "start", maxSteps, maxCost, task: tokens.slice(i).join(" ") };
}

/**
 * Parse `provider/model` or `provider/model:level` for `/hand-off-relay model`.
 * The provider is everything before the first `/` (as in the writer-model
 * setting); an omitted level means "keep the settling session's level".
 */
export function parseModelSpec(spec: string): { model: PersistedRelayModel } | { error: string } {
	const text = spec.trim();
	const slash = text.indexOf("/");
	if (slash <= 0) return { error: `expected "provider/model" or "provider/model:level", got "${text}"` };
	const provider = text.slice(0, slash).trim();
	let modelId = text.slice(slash + 1).trim();
	let thinkingLevel: ThinkingLevel | undefined;
	const colon = modelId.lastIndexOf(":");
	if (colon !== -1) {
		const suffix = modelId.slice(colon + 1).trim();
		if (!THINKING_LEVELS.includes(suffix as ThinkingLevel)) {
			return { error: `":${suffix || modelId.slice(colon + 1)}" is not a thinking level (one of ${THINKING_LEVELS.join(", ")})` };
		}
		thinkingLevel = suffix as ThinkingLevel;
		modelId = modelId.slice(0, colon).trim();
	}
	if (!provider || !modelId) return { error: `expected "provider/model" or "provider/model:level", got "${text}"` };
	return { model: { provider, modelId, thinkingLevel } };
}

export type RelaySignal =
	| { kind: "hand-off"; body: string }
	| { kind: "done" }
	| { kind: "stop"; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "none" }
	| { kind: "invalid"; reason: string };

/** Mask fenced code without moving offsets, so quoted syntax never counts as a tag. */
function maskCodeFences(text: string): string {
	return text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|$)/gm, (fence) => fence.replace(/[^\n]/g, " "));
}

/**
 * Classify a final assistant message. One signal outside code fences counts
 * even with a user-facing summary around it. The signal's body is read from
 * the original text so fenced examples inside a hand-off survive intact.
 */
export function parseRelaySignal(text: string): RelaySignal {
	const masked = maskCodeFences(text.trim());
	const done = /<hand-off\s+done\s*\/>/.exec(masked);
	if (done) {
		const elsewhere = `${masked.slice(0, done.index)} ${masked.slice(done.index + done[0].length)}`;
		if (/<hand-off(\s[^>]*)?\/?>|<\/hand-off>/.test(elsewhere)) {
			return { kind: "invalid", reason: "more than one hand-off signal appears" };
		}
		return { kind: "done" };
	}
	const signal = /<hand-off(?:\s+(stop|pause))?>[\s\S]*<\/hand-off>/.exec(masked);
	if (signal) {
		const word = signal[1] as "stop" | "pause" | undefined;
		const bodyStart = masked.indexOf(">", signal.index) + 1;
		const bodyEnd = signal.index + signal[0].length - "</hand-off>".length;
		const body = text.trim().slice(bodyStart, bodyEnd).trim();
		if (!body) return { kind: "invalid", reason: `the hand-off ${word ? `${word} reason` : "block"} is empty` };
		// A literal tag inside the body (hand-offs often explain the syntax) is just text.
		return word ? { kind: word, reason: body } : { kind: "hand-off", body };
	}
	if (/<hand-off(\s[^>]*)?\/?>|<\/hand-off>/.test(masked)) {
		return { kind: "invalid", reason: "a hand-off tag is incomplete or malformed" };
	}
	return { kind: "none" };
}

interface UsageTotals {
	input: number;
	output: number;
	total: number;
	cost: number;
}

/** Sum token usage and cost over the assistant messages of a transcript. */
export function sumUsage(messages: ReadonlyArray<{ role: string; usage?: unknown }>): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, total: 0, cost: 0 };
	for (const message of messages) {
		if (message.role !== "assistant" || !message.usage || typeof message.usage !== "object") continue;
		const usage = message.usage as {
			input?: number;
			output?: number;
			totalTokens?: number;
			cost?: { total?: number };
		};
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
		totals.cost += usage.cost?.total ?? 0;
	}
	return totals;
}

/** The three ways a relayed agent may end, as shown to it. */
function signalInstructions(step: number, maxSteps: number): string[] {
	const last = step >= maxSteps;
	return [
		"End with exactly one of these relay signals (not in a code fence). A short user-facing summary may precede it:",
		...(last
			? ["- This is the last step the relay allows (no more hand-offs), so a `<hand-off>` will be refused."]
			: ["- `<hand-off>…</hand-off>`: what you did, what is next, and any gotchas."]),
		"- `<hand-off done/>`: the work is complete.",
		"- `<hand-off pause>question</hand-off>`: you need an answer from the user. The relay waits in this session and continues when you next finish, after they reply.",
		"- `<hand-off stop>reason</hand-off>`: you cannot continue (blocked, failing). The relay ends and the user sees your reason.",
		"Do not emit `hand-off`, `done`, `pause`, or `stop` merely because you are waiting for a background subagent. End the turn normally without a relay signal; its completion notification will let you continue.",
		"For a `<hand-off>` block, put everything the next agent needs inside the tags; prose outside them is not carried forward.",
	];
}

/** Instructions appended to every relayed prompt, and sent to the first agent when the relay is armed. */
export function buildRelayProtocol(step: number, maxSteps: number): string {
	return [
		`## Autonomous relay: step ${step} of ${maxSteps}`,
		"",
		"You are one step in a relay of agents; when you finish, a fresh agent continues from your hand-off. Nobody is watching live.",
		"",
		...signalInstructions(step, maxSteps),
	].join("\n");
}

/** Follow-up sent once when a final message has no usable tag. */
export function buildRelayNudge(step: number, maxSteps: number, problem: string): string {
	return [
		`Your last message can't advance the relay: ${problem}.`,
		"",
		...signalInstructions(step, maxSteps),
	].join("\n");
}

/**
 * Escalating budget warnings, as fractions of `--max-cost`. At the last level
 * and beyond (up to 100%) the agent is told to write its final status; at
 * 100% the session is aborted.
 */
const BUDGET_LEVELS = [
	{
		at: 0.8,
		text: (pct: string, spent: string, max: string) =>
			`Budget heads-up: this relay has used ${pct}% of its $${max} cost limit ($${spent}). Plan to wrap up soon.`,
	},
	{
		at: 0.95,
		text: (pct: string, spent: string, max: string) =>
			`Budget warning: ${pct}% of the $${max} cost limit is used ($${spent}). Stop now: finish only your final tasks and leave the work in a consistent state. Do not start anything new.`,
	},
	{
		at: 0.98,
		text: (pct: string, spent: string, max: string) =>
			`Out of budget (${pct}% of $${max}, $${spent}). Your next message must be your last: end with \`<hand-off stop>…</hand-off>\` summarizing the current status (what is done, what is not, where things stand).`,
	},
] as const;

/** At or past this fraction of the limit, the relay does not start another session. */
const NO_NEW_SESSION_AT = BUDGET_LEVELS[1].at;

export type BudgetAction =
	| { kind: "none" }
	| { kind: "warn"; level: number; message: string }
	| { kind: "abort"; reason: string };

/**
 * What to do about cost while the current session runs. Returns only the
 * highest level newly crossed, so each level is sent once and a jump over
 * several levels sends one message. `level` is 1-based, for `RelayState.warned`.
 */
export function decideBudgetAction(
	relay: Pick<RelayState, "maxCost" | "spent" | "warned">,
	sessionCost: number,
): BudgetAction {
	const max = relay.maxCost;
	if (max === undefined) return { kind: "none" };
	const spent = relay.spent + sessionCost;
	if (spent >= max) {
		return { kind: "abort", reason: `cost limit reached mid-step ($${spent.toFixed(2)} of $${max.toFixed(2)})` };
	}
	const crossed = BUDGET_LEVELS.reduce((n, level, i) => (spent >= level.at * max ? i + 1 : n), 0);
	if (crossed <= (relay.warned ?? 0)) return { kind: "none" };
	const pct = Math.floor((spent / max) * 100).toString();
	return { kind: "warn", level: crossed, message: BUDGET_LEVELS[crossed - 1].text(pct, spent.toFixed(2), max.toFixed(2)) };
}

export interface RelayDecisionInput {
	relay: Pick<
		RelayState,
		| "maxSteps"
		| "sessionIds"
		| "maxCost"
		| "spent"
		| "nudged"
		| "pending"
		| "waiting"
		| "backgroundTasks"
		| "backgroundNotifications"
	>;
	/** The session whose agent just settled. */
	sessionId: string;
	aborted: boolean;
	/** The last assistant message, if any. */
	last: { stopReason?: string; text: string } | undefined;
	/** Cost of the settled session alone. */
	sessionCost: number;
}

export type RelayDecision =
	| { kind: "ignore" }
	| { kind: "stop"; reason: string; level: "info" | "warning" | "error"; limit?: RelayStopped["limit"] }
	| { kind: "pause"; reason: string }
	| { kind: "wait" }
	| { kind: "idle"; reason: string }
	| { kind: "nudge"; problem: string }
	| { kind: "attention"; reason: string }
	| { kind: "hop"; body: string; step: number; spent: number };

/** What the relay should do now that an agent settled. Pure: no I/O, no ctx. */
export function decideRelayAction(input: RelayDecisionInput): RelayDecision {
	const { relay, last } = input;
	if (relay.pending) return { kind: "ignore" };
	// Ignore sessions the relay is not waiting on (a manual /new, say).
	if (relay.sessionIds.at(-1) !== input.sessionId) return { kind: "ignore" };
	if (input.aborted) return { kind: "stop", reason: "the run was aborted", level: "warning" };
	if (!last) return { kind: "stop", reason: "no assistant message to read", level: "error" };
	if (last.stopReason !== "stop") {
		return { kind: "stop", reason: `the final message ended with "${last.stopReason ?? "unknown"}"`, level: "error" };
	}
	// A human pause or protocol-attention wait cannot be cleared by an
	// unrelated notification-driven run. Only another turn or `resume` retries it.
	if (relay.waiting?.kind === "user" || relay.waiting?.kind === "attention") return { kind: "ignore" };
	// An idle main agent with outstanding background work has not reached a
	// relay boundary at all. This takes precedence over every model-emitted
	// signal, including `done` and `stop`: those results are still unavailable.
	if (
		(relay.backgroundTasks?.length ?? 0) > 0 ||
		awaitingBackgroundNotification(relay) ||
		relay.waiting?.kind === "background" ||
		relay.waiting?.kind === "unsignalled"
	) return { kind: "wait" };

	const signal = parseRelaySignal(last.text);
	if (signal.kind === "done") return { kind: "stop", reason: "the agent signalled the work is done", level: "info" };
	if (signal.kind === "stop") return { kind: "stop", reason: `the agent stopped it: ${signal.reason}`, level: "warning" };
	if (signal.kind === "pause") return { kind: "pause", reason: signal.reason };

	const step = relay.sessionIds.length - 1;
	const spent = relay.spent + input.sessionCost;
	if (relay.maxCost !== undefined && spent >= relay.maxCost * NO_NEW_SESSION_AT) {
		return {
			kind: "stop",
			reason: `spent $${spent.toFixed(2)} of the $${relay.maxCost.toFixed(2)} limit, too little left to start another session`,
			level: "warning",
			limit: "cost",
		};
	}
	// With no signal, the agent may be waiting on any background-task system,
	// not just one we integrate with. Stay armed and let any later turn retry.
	if (signal.kind === "none") return { kind: "idle", reason: "the final message has no <hand-off> tag" };
	if (signal.kind === "invalid") {
		if (relay.nudged) return { kind: "attention", reason: `${signal.reason} (after one reminder)` };
		return { kind: "nudge", problem: signal.reason };
	}
	if (step >= relay.maxSteps) {
		return {
			kind: "stop",
			reason: `reached the limit of ${relay.maxSteps} hand-offs; the agent asked for another hand-off`,
			level: "warning",
			limit: "steps",
		};
	}
	return { kind: "hop", body: signal.body, step, spent };
}

/** Provenance header, hand-off body, and protocol for the next agent. */
export function buildRelayPrompt(
	body: string,
	opts: { step: number; maxSteps: number; fromSessionId: string | undefined },
): string {
	const from = opts.fromSessionId?.trim();
	const header = `<!-- pi-hand-off relay: step ${opts.step} of ${opts.maxSteps}${from ? ` · handed off from pi session ${from}` : ""} -->`;
	return `${header}\n\n${body}\n\n---\n\n${buildRelayProtocol(opts.step, opts.maxSteps)}`;
}

export default function (pi: ExtensionAPI) {
	// In-session state for the hand-off capture; fresh per extension instance,
	// so it never leaks into a replacement session.
	let awaitingHandoff = false;
	let capturedPrompt: string | undefined;
	let flowInProgress = false;
	let currentSessionId: string | undefined;
	// Config file contents, refreshed on every `session_start` (the file is read
	// once per session, not per hand-off). The pi CLI flag is read per hand-off
	// so it works even if a command somehow runs before `session_start`.
	let handoffSettings: HandoffSettings = {};

	/**
	 * Apply a captured model and thinking level, reporting problems as
	 * warnings. Returns true when the model was applied.
	 */
	async function applyHandoffModel(handoff: SessionHandoff, ctx: ExtensionContext): Promise<boolean> {
		try {
			const model = ctx.modelRegistry.find(handoff.provider, handoff.modelId);
			if (!model) {
				ctx.ui.notify(`pi-hand-off: model ${handoff.provider}/${handoff.modelId} is no longer available`, "warning");
				return false;
			}

			const applied = await pi.setModel(model);
			if (!applied) {
				ctx.ui.notify(`pi-hand-off: no auth configured for ${handoff.provider}/${handoff.modelId}`, "warning");
				return false;
			}

			if (handoff.thinkingLevel) {
				await pi.setThinkingLevel(handoff.thinkingLevel);
			}
			return true;
		} catch (err) {
			ctx.ui.notify(
				`pi-hand-off: could not restore model ${handoff.provider}/${handoff.modelId}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
			return false;
		}
	}

	/** Ask the live agent to write its next message as the hand-off prompt. */
	async function captureFromLiveAgent(
		ctx: ExtensionCommandContext,
		steering: string,
	): Promise<string | undefined> {
		awaitingHandoff = true;
		capturedPrompt = undefined;
		try {
			await pi.sendMessage(
				{
					customType: HANDOFF_CUSTOM_TYPE,
					content: buildHandoffRequest(steering),
					display: true,
				},
				{ triggerTurn: true },
			);
			await ctx.waitForIdle();
		} finally {
			awaitingHandoff = false;
		}

		if (!capturedPrompt) {
			ctx.ui.notify("The agent did not produce a hand-off prompt; staying in this session", "error");
			return undefined;
		}
		return capturedPrompt;
	}

	/** One fresh pass over the minimal transcript; notifies when it trims. */
	async function captureFromFreshPass(
		ctx: ExtensionContext,
		writer: WriterChoice & { kind: "fresh" },
		reasoning: ThinkingLevel | undefined,
		steering: string,
		lastActiveMs: number | undefined,
	): Promise<string | undefined> {
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const maxSourceChars = resolveMaxSourceChars(pi.getFlag(FLAG_MAX_SOURCE_CHARS), handoffSettings);
		const source = buildMinimalTranscript(messages, maxSourceChars);
		if (!source.text.trim()) {
			ctx.ui.notify("No conversation to hand off", "error");
			return undefined;
		}
		if (source.omittedTurns > 0) {
			ctx.ui.notify(
				`Hand-off source trimmed: ${source.omittedTurns} earlier turns omitted (~${formatChars(source.droppedChars)} chars dropped)`,
				"info",
			);
		}
		return generateFreshPassPrompt(
			ctx,
			writer.model,
			source.text,
			steering,
			reasoning,
			describeLastActive(lastActiveMs, Date.now()),
		);
	}

	/** Cost of the current session, 0 if it cannot be read (a replaced session's context). */
	function sessionCost(ctx: ExtensionContext): number {
		try {
			return sumUsage(ctx.sessionManager.buildSessionProjection().messages).cost;
		} catch {
			return 0;
		}
	}

	/** Make lifecycle changes visible to both the user and the current agent. */
	function announceRelayState(ctx: ExtensionContext, content: string): void {
		try {
			pi.sendMessage({ customType: RELAY_STATE_TYPE, content, display: true }, { triggerTurn: false });
		} catch {
			// Same-session replacement can make this context stale synchronously.
		}
	}

	/** Ends the relay and tells the user why, with the total spent. */
	function stopRelay(
		ctx: ExtensionContext,
		reason: string,
		level: "info" | "warning" | "error",
		limit?: RelayStopped["limit"],
	): void {
		takeHandoff();
		const relay = readRelay();
		const recovery = relay
			? stopRelaySnapshot(relay, { reason, level, at: new Date().toISOString(), limit })
			: undefined;
		let where = "";
		if (relay) {
			// While a hand-off is pending, `spent` already includes this session.
			const spent = relay.pending ? relay.spent : relay.spent + sessionCost(ctx);
			where = ` (step ${relayStep(relay)} of ${relay.maxSteps}, $${spent.toFixed(2)} spent)`;
		}
		if (relay) {
			// Leave a record in the transcript; the notification alone is not persisted.
			try {
				pi.appendEntry(RELAY_STOP_ENTRY_TYPE, {
					step: relayStep(relay),
					maxSteps: relay.maxSteps,
					reason,
					level,
					spent: relay.pending ? relay.spent : relay.spent + sessionCost(ctx),
					at: new Date().toISOString(),
				});
			} catch {
				// The session may already be replaced; the notification still goes out.
			}
		}
		const recoveryAction = recovery?.durable
			? " `/hand-off-relay resume` reopens it; `off` discards the stopped snapshot."
			: recovery?.recoverable
				? " The recovery file could not be saved, so `resume` works only in this pi process; `off` discards the in-memory snapshot."
				: relay ? " No recovery snapshot could be saved; start a new relay if more work is needed." : "";
		ctx.ui.notify(
			`Hand-off relay stopped${where}: ${reason}${recoveryAction}`,
			recovery && !recovery.durable ? "warning" : level,
		);
		announceRelayState(
			ctx,
			`The hand-off relay is stopped (${reason}). Its protocol is no longer active; further <hand-off> signals have no effect unless the user resumes this relay or explicitly arms another one.`,
		);
	}

	/** Keep a failed advance recoverable: its prompt remains pending for `resume`. */
	function failAdvance(ctx: ExtensionContext, reason: string): void {
		const relay = readRelay();
		if (!relay?.pending) return stopRelay(ctx, reason, "error");
		writeRelay({
			...relay,
			pending: {
				prompt: relay.pending.prompt,
				deliverHere: relay.pending.deliverHere,
				targetSessionId: relay.pending.targetSessionId,
			},
			waiting: { kind: "attention", reason },
		});
		ctx.ui.notify(
			`Hand-off relay could not advance: ${reason}. \`/hand-off-relay resume\` retries the saved hand-off; \`off\` stops it, and another \`off\` discards the stopped snapshot.`,
			"error",
		);
		announceRelayState(ctx, `The relay could not advance: ${reason}. Its hand-off is still saved. The user can resume to retry or stop the relay.`);
	}

	/** Pauses the relay if the internal advance command never started. */
	function watchAdvance(ctx: ExtensionContext, pending: object): void {
		setTimeout(() => {
			const relay = readRelay();
			if (relay?.pending !== pending || relay.pending.started) return;
			failAdvance(ctx, "the hand-off did not start (the internal advance command never ran)");
		}, ADVANCE_WATCHDOG_MS).unref?.();
	}

	/** A swallowed send error or handled input must not strand a blank session. */
	function watchDelivery(ctx: ExtensionContext, pending: object): void {
		setTimeout(() => {
			const relay = readRelay();
			if (relay?.pending !== pending) return;
			failAdvance(ctx, "the hand-off prompt was not accepted (check the model, auth, or another input handler)");
		}, ADVANCE_WATCHDOG_MS).unref?.();
	}

	// Optional adapter: pi-subagents supplies precise outstanding-task state.
	// Correctness does not depend on it: unsignalled idle and any later turn are
	// the generic fallback for other background-task and notification systems.
	const SUBAGENTS_SOURCE = "pi-subagents";
	const busSubscriptions: Array<() => void> = [];
	const onBus = (channel: string, handler: (data: unknown) => void): void => {
		busSubscriptions.push(pi.events.on(channel, handler));
	};
	pi.on("session_shutdown", () => {
		for (const unsubscribe of busSubscriptions.splice(0)) unsubscribe();
	});
	const asSubagent = (data: unknown, fallbackBackground: boolean): RelayBackgroundTask | undefined => {
		if (!isRecord(data) || typeof data.id !== "string" || !data.id) return undefined;
		// RPC, scheduler, and direct-mention spawns emit `started` without
		// `created`; `started` alone cannot distinguish them from foreground Agent
		// calls. The documented manager registry can: blocking calls have an inline
		// result, while every non-blocking top-level spawn needs its notification.
		let background = fallbackBackground;
		try {
			const manager = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")];
			if (isRecord(manager) && typeof manager.getRecord === "function") {
				const record = (manager.getRecord as (id: string) => unknown)(data.id);
				if (isRecord(record)) background = record.blocking !== true;
			}
		} catch {
			// The lifecycle-event fallback remains usable if an integration changes.
		}
		return {
			id: data.id,
			type: typeof data.type === "string" ? data.type : "agent",
			description: typeof data.description === "string" && data.description ? data.description : data.id,
			source: SUBAGENTS_SOURCE,
			background,
		};
	};
	const updateBackgroundTask = (task: RelayBackgroundTask | undefined): void => {
		if (!task) return;
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== currentSessionId) return;
		writeRelay(trackRelayBackgroundTask(relay, task));
	};
	onBus("subagents:created", (data) => updateBackgroundTask(asSubagent(data, true)));
	onBus("subagents:started", (data) => updateBackgroundTask(asSubagent(data, false)));
	const finishSubagent = (data: unknown): void => {
		if (!isRecord(data) || typeof data.id !== "string") return;
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== currentSessionId) return;
		writeRelay(completeRelayBackgroundTask(relay, SUBAGENTS_SOURCE, data.id));
	};
	onBus("subagents:completed", finishSubagent);
	onBus("subagents:failed", finishSubagent);

	// A result is released only when the main agent actually receives it. The
	// outbox may suppress a notification after get_subagent_result or RPC consume.
	// This event is also the first reliable delivery acknowledgment: `input`
	// fires before model/auth validation and before all input handlers finish.
	pi.on("message_start", (event) => {
		if (event.message.role === "user") {
			const attempt = readDeliveryAttempt();
			if (
				attempt && attempt.targetSessionId === currentSessionId &&
				messageText(event.message) === attempt.prompt
			) finishDelivery(attempt, false);
			const relay = readRelay();
			const pending = relay?.pending;
			if (
				relay && pending?.deliverHere && typeof currentSessionId === "string" &&
				pending.targetSessionId === currentSessionId && messageText(event.message) === pending.prompt
			) {
				writeRelay({
					...relay,
					sessionIds: relay.sessionIds.at(-1) === currentSessionId
						? relay.sessionIds
						: [...relay.sessionIds, currentSessionId],
					pending: undefined,
					waiting: undefined,
					nudged: false,
					warned: undefined,
				});
			}
			return;
		}
		const message = event.message as { role?: string; customType?: string; details?: unknown };
		if (message.role !== "custom" || message.customType !== "subagent-notification") return;
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== currentSessionId) return;
		const details = message.details;
		if (!isRecord(details)) return;
		const ids = [details.id, ...(Array.isArray(details.others) ? details.others.map((other) => isRecord(other) ? other.id : undefined) : [])]
			.filter((id): id is string => typeof id === "string" && id !== "");
		if (ids.length === 0) return;
		clearBackgroundNotifications(relay, ids);
		writeRelay(relay);
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== "get_subagent_result" || event.isError) return;
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== currentSessionId || !awaitingBackgroundNotification(relay)) return;
		const content = (event.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
		const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
		const id = /^Agent:\s*(\S+)\s*$/m.exec(text)?.[1];
		if (!id || !relay.backgroundNotifications?.includes(id)) return;
		clearBackgroundNotifications(relay, [id]);
		writeRelay(relay);
	});
	onBus("subagents:rpc:consume", (data) => {
		if (!isRecord(data) || typeof data.agentId !== "string") return;
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== currentSessionId || !relay.backgroundNotifications?.includes(data.agentId)) return;
		clearBackgroundNotifications(relay, [data.agentId]);
		writeRelay(relay);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const relay = readRelay();
		if (!relay) return;

		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const lastMessage = [...messages].reverse().find((m) => m.role === "assistant") as
			| { role: string; stopReason?: string; content: string | Array<{ type: string; text?: string }> }
			| undefined;
		const totals = sumUsage(messages);
		const decision = decideRelayAction({
			relay,
			sessionId: ctx.sessionManager.getSessionId(),
			aborted: Boolean(event.aborted),
			last: lastMessage && { stopReason: lastMessage.stopReason, text: messageText(lastMessage) },
			sessionCost: totals.cost,
		});

		if (decision.kind === "ignore") return;
		if (decision.kind === "stop") return stopRelay(ctx, decision.reason, decision.level, decision.limit);
		if (decision.kind === "wait") {
			const alreadyWaiting = relay.waiting?.kind === "background";
			writeRelay({ ...relay, waiting: { kind: "background" } });
			if (!alreadyWaiting) {
				const count = relay.backgroundTasks?.length ?? 0;
				const detail = count > 0
					? `${count} background task${count === 1 ? " is" : "s are"} still running`
					: "a background completion notification is still pending";
				ctx.ui.notify(
					`Hand-off relay waiting at step ${relayStep(relay)} of ${relay.maxSteps}: ${detail}. A notification continues it automatically; \`/hand-off-relay status\` inspects it and \`off\` stops it.`,
					"info",
				);
				announceRelayState(ctx, `The relay is waiting for background work (${detail}). Do not emit a hand-off, pause, stop, or done signal until the results arrive.`);
			}
			return;
		}
		if (decision.kind === "idle") {
			writeRelay({ ...relay, waiting: { kind: "unsignalled", reason: decision.reason } });
			ctx.ui.notify(
				`Hand-off relay is idle at step ${relayStep(relay)} of ${relay.maxSteps}: ${decision.reason}. It may be waiting for background work; any notification or reply lets it continue. \`/hand-off-relay resume\` asks for a signal now; \`off\` stops it.`,
				"info",
			);
			announceRelayState(
				ctx,
				"The relay is still armed but idle because your last message had no relay signal. If you are waiting for background work, continue when its notification arrives. Otherwise wait for the user; they can reply or resume the relay.",
			);
			return;
		}
		if (decision.kind === "pause") {
			writeRelay({ ...relay, waiting: { kind: "user", reason: decision.reason }, nudged: false });
			ctx.ui.notify(
				`Hand-off relay paused at step ${relayStep(relay)} of ${relay.maxSteps}: ${decision.reason}\nReply in this session or run \`/hand-off-relay resume\`; unrelated notifications will not advance the relay. \`off\` cancels it.`,
				"warning",
			);
			announceRelayState(ctx, `The relay is paused for a user answer: ${decision.reason}. Do not advance it until the user replies or resumes it.`);
			return;
		}
		if (decision.kind === "attention") {
			writeRelay({ ...relay, waiting: { kind: "attention", reason: decision.reason } });
			ctx.ui.notify(
				`Hand-off relay needs attention at step ${relayStep(relay)} of ${relay.maxSteps}: ${decision.reason}. Reply with guidance or run \`/hand-off-relay resume\`; \`off\` stops it.`,
				"warning",
			);
			announceRelayState(
				ctx,
				`The relay needs user intervention: ${decision.reason}. Do not keep autonomously repeating hand-off tags. A user reply, a later notification-driven turn, or /hand-off-relay resume will let you continue.`,
			);
			return;
		}
		if (decision.kind === "nudge") {
			writeRelay({ ...relay, waiting: undefined, nudged: true });
			const step = relayStep(relay);
			void pi.sendUserMessage(buildRelayNudge(step, relay.maxSteps, decision.problem));
			return;
		}

		const model = ctx.model;
		if (!model) return stopRelay(ctx, "no model to carry over", "error");

		// A model staged with `/hand-off-relay model` replaces the carried-over
		// model for this hop only. A staged model that has become unavailable or
		// lost its auth is dropped with a warning rather than poisoning the hop.
		let carried: PersistedRelayModel = {
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: ctx.thinkingLevel,
		};
		const staged = relay.nextModel;
		if (staged) {
			const found = ctx.modelRegistry.find(staged.provider, staged.modelId);
			if (found && ctx.modelRegistry.hasConfiguredAuth(found)) {
				carried = { provider: found.provider, modelId: found.id, thinkingLevel: staged.thinkingLevel ?? ctx.thinkingLevel };
			} else {
				ctx.ui.notify(
					`pi-hand-off relay: staged model ${staged.provider}/${staged.modelId} is ${found ? "missing auth" : "no longer available"}; keeping ${model.provider}/${model.id}`,
					"warning",
				);
			}
		}

		const { step, spent } = decision;
		const fromSessionId = ctx.sessionManager.getSessionId();
		pi.appendEntry(RELAY_HOP_ENTRY_TYPE, {
			step,
			maxSteps: relay.maxSteps,
			provider: carried.provider,
			modelId: carried.modelId,
			thinkingLevel: carried.thinkingLevel,
			tokens: { input: totals.input, output: totals.output, total: totals.total },
			cost: totals.cost,
			at: new Date().toISOString(),
		});

		const pending = {
			prompt: buildRelayPrompt(decision.body, { step: step + 1, maxSteps: relay.maxSteps, fromSessionId }),
		};
		setRelayPersistence({ cwd: ctx.cwd, model: carried });
		writeRelay({
			...relay,
			spent,
			nudged: false,
			waiting: undefined,
			backgroundTasks: undefined,
			backgroundNotifications: undefined,
			nextModel: undefined,
			pending,
		});
		writeHandoff({ provider: carried.provider, modelId: carried.modelId, thinkingLevel: carried.thinkingLevel });
		// Event contexts cannot replace the session; a command context can, so
		// hand the work to the internal command (processed after settled handlers).
		pi.sendUserMessage(`/${RELAY_COMMAND}`, { expandPromptTemplates: true });
		watchAdvance(ctx, pending);
	});

	// Any later turn is enough to retry an unsignalled/attention wait, whatever
	// extension supplied the notification. Explicit user pauses are different:
	// only actual human input (or the resume command) may clear those.
	pi.on("turn_start", (_event, ctx) => {
		const relay = readRelay();
		if (!relay || relay.sessionIds.at(-1) !== ctx.sessionManager.getSessionId()) return;
		if (awaitingBackgroundNotification(relay) || !relay.waiting || relay.waiting.kind === "user") return;
		writeRelay(continueRelayForTurn(relay));
	});
	pi.on("input", (event, ctx) => {
		const relay = readRelay();
		// sendUserMessage() and RPC submissions also emit `input`; they are not
		// evidence that the human answered a pause or approved another correction.
		if (event.source !== "interactive") return;
		if (!relay || relay.sessionIds.at(-1) !== ctx.sessionManager.getSessionId()) return;
		if (!relay.waiting && !relay.nudged && !awaitingBackgroundNotification(relay)) return;
		writeRelay(continueRelayForUser(relay));
	});

	// Cost guard while a step runs: escalating steering messages, then a hard abort.
	pi.on("turn_end", async (event, ctx) => {
		const relay = readRelay();
		if (!relay || relay.maxCost === undefined || relay.pending) return;
		if (relay.sessionIds.at(-1) !== ctx.sessionManager.getSessionId()) return;

		const action = decideBudgetAction(relay, sessionCost(ctx));
		if (action.kind === "abort") {
			stopRelay(ctx, `${action.reason}; aborted session ${ctx.sessionManager.getSessionId()}`, "warning", "cost");
			ctx.abort();
			return;
		}
		// With no tool results the agent is about to finish; a steer would only buy an extra request.
		if (action.kind === "warn" && event.toolResults.length > 0) {
			writeRelay({ ...relay, warned: action.level });
			pi.sendUserMessage(action.message, { deliverAs: "steer" });
		}
	});

	pi.registerCommand(RELAY_COMMAND, {
		description: "Internal: advance an autonomous hand-off relay (not for manual use)",
		handler: async (_args, ctx) => {
			const relay = readRelay();
			const pending = relay?.pending;
			if (!relay || !pending) {
				ctx.ui.notify("No autonomous hand-off relay is waiting to advance", "warning");
				return;
			}
			if (pending.started || pending.deliverHere) return;
			pending.started = true;
			try {
				const result = await ctx.newSession({
					withSession: async (next) => {
						// `off` may have run while session replacement was in flight. Never
						// resurrect a stopped relay or overwrite a different relay.
						if (readRelay()?.pending !== pending) return;
						// Do not commit the replacement as a relay step until its prompt
						// actually starts. An unwritten blank session is then recoverable
						// from the previous session after a restart.
						const nextId = next.sessionManager.getSessionId();
						if (relay.sessionIds.includes(nextId)) {
							stopRelay(next, `session ${nextId} is already in the relay`, "error");
							return;
						}
						const claim = claimDelivery(next.cwd, nextId, pending.prompt);
						if (!claim.attempt) return failAdvance(next, claim.error!);
						const delivery = { prompt: pending.prompt, deliverHere: true as const, targetSessionId: nextId };
						writeRelay({ ...relay, pending: delivery, waiting: undefined, nudged: false, warned: undefined });
						watchDelivery(next, delivery);
						// Do not await: the call may resolve only when the whole run ends.
						next.sendUserMessage(pending.prompt).then(
							() => {
								if (readDeliveryAttempt() === claim.attempt) finishDelivery(claim.attempt!, true);
								if (readRelay()?.pending === delivery) {
									failAdvance(next, "the hand-off send finished without starting its prompt (another input handler may have handled it)");
								}
							},
							(err: unknown) => {
								finishDelivery(claim.attempt!, true);
								if (readRelay()?.pending === delivery) {
									failAdvance(next, `could not send the hand-off prompt in the new session: ${messageOf(err)}`);
								}
							},
						);
					},
				});
				takeHandoff();
				if (result.cancelled) failAdvance(ctx, "session replacement was cancelled");
			} catch (err) {
				takeHandoff();
				if (readRelay()?.pending) failAdvance(ctx, `hand-off failed: ${messageOf(err)}`);
			}
		},
	});

	/** Resume an active wait, an interrupted relay, or a stopped snapshot. */
	async function resumeRelay(
		ctx: ExtensionCommandContext,
		active: RelayState | undefined,
		options: { maxSteps?: number; maxCost?: number },
	): Promise<void> {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!active) {
			const other = relayOwnedByOtherProcess(ctx.cwd);
			if (other) return ctx.ui.notify(`${ownedElsewhereMessage(other.record)} Nothing to resume.`, "warning");
		}
		const saved = active ? undefined : (readStoppedRelay(ctx.cwd) ?? loadPersistedRelay(relayStatePath(ctx.cwd)));
		if (!active && !saved) {
			return ctx.ui.notify("No stopped or interrupted hand-off relay to resume in this directory", "info");
		}
		if (saved && "error" in saved) {
			return ctx.ui.notify(`Could not read the saved relay (${saved.error}). \`/hand-off-relay off\` discards it.`, "error");
		}
		const source = active ?? saved!.record.relay;
		const stopped = saved && "record" in saved ? saved.record.stopped : undefined;
		const model = active ? persistence?.model : saved!.record.model;
		if (!active) setRelayPersistence({ cwd: ctx.cwd, model });
		const relay: RelayState = {
			...source,
			maxSteps: options.maxSteps ?? source.maxSteps,
			maxCost: options.maxCost ?? source.maxCost,
		};
		// A delivery that never started has not committed its replacement step.
		// After a restart its blank session may not even exist on disk, so allow
		// the previous session (or any other session) to replay a normal advance.
		const recoveringUndelivered = relay.pending?.deliverHere === true &&
			relay.pending.targetSessionId !== sessionId &&
			(!active || active.waiting?.kind === "attention");
		if (recoveringUndelivered && relay.pending) {
			if (relay.pending.targetSessionId === undefined && relay.sessionIds.length > 1) {
				// Compatibility with snapshots written before targetSessionId existed.
				relay.sessionIds = relay.sessionIds.slice(0, -1);
			}
			relay.pending = { prompt: relay.pending.prompt };
		}
		if (relay.maxSteps < relayStep(relay)) {
			return ctx.ui.notify(
				`--max-steps ${relay.maxSteps} is below the current step ${relayStep(relay)}; choose a larger limit to resume.`,
				"warning",
			);
		}
		const last = relay.sessionIds.at(-1);
		const deliveringHere = relay.pending?.deliverHere === true && relay.pending.targetSessionId === sessionId;
		if (!recoveringUndelivered && !deliveringHere && last !== sessionId) {
			const description = active ? "is waiting on" : stopped ? "stopped in" : "was working in";
			return ctx.ui.notify(
				`The relay ${description} session ${last}, not this one. Open that session with /resume, then run /hand-off-relay resume there.`,
				"warning",
			);
		}
		const currentSpend = source.pending ? source.spent : source.spent + sessionCost(ctx);
		if (options.maxSteps !== undefined && options.maxSteps <= relayStep(relay)) {
			return ctx.ui.notify(
				`--max-steps must be greater than the current step ${relayStep(relay)} to allow another hand-off.`,
				"warning",
			);
		}
		if (options.maxCost !== undefined && options.maxCost <= currentSpend) {
			return ctx.ui.notify(
				`--max-cost must be greater than the $${currentSpend.toFixed(2)} already reported across the relay.`,
				"warning",
			);
		}
		if (relay.maxCost !== undefined && relay.maxCost <= currentSpend) {
			return ctx.ui.notify(
				`This relay has already reported $${currentSpend.toFixed(2)}, at or above its $${relay.maxCost.toFixed(2)} cap. Resume with --max-cost greater than the reported spend.`,
				"warning",
			);
		}
		if (stopped?.limit === "steps" && relay.maxSteps <= relayStep(relay)) {
			return ctx.ui.notify(
				`This relay stopped at its step limit. Resume with --max-steps greater than ${relayStep(relay)} to allow another hand-off.`,
				"warning",
			);
		}
		if (relay.pending && relay.maxCost !== undefined && relay.maxCost * NO_NEW_SESSION_AT <= currentSpend) {
			const minimumForHop = currentSpend / NO_NEW_SESSION_AT;
			return ctx.ui.notify(
				`Starting the saved hand-off would cross the 95% new-session guard at $${currentSpend.toFixed(2)} spent. Resume with --max-cost greater than $${minimumForHop.toFixed(2)}.`,
				"warning",
			);
		}
		if (stopped?.limit === "cost") {
			const minimumForHop = currentSpend / NO_NEW_SESSION_AT;
			if (relay.maxCost === undefined || relay.maxCost * NO_NEW_SESSION_AT <= currentSpend) {
				return ctx.ui.notify(
					`This relay stopped after reporting $${currentSpend.toFixed(2)} in spend. Resume with --max-cost greater than $${minimumForHop.toFixed(2)} so the next hand-off stays below the 95% guard.`,
					"warning",
				);
			}
		}
		if (relay.pending?.deliverHere) {
			if (!ctx.isIdle()) {
				return ctx.ui.notify("Wait for the current turn to finish before retrying the saved hand-off prompt", "info");
			}
			const claim = claimDelivery(ctx.cwd, sessionId, relay.pending.prompt);
			if (!claim.attempt) return ctx.ui.notify(claim.error!, "warning");
			const delivery = { prompt: relay.pending.prompt, deliverHere: true as const, targetSessionId: sessionId };
			writeRelay({ ...relay, pending: delivery, waiting: undefined, nextModel: undefined, nudged: false, warned: undefined });
			watchDelivery(ctx, delivery);
			ctx.ui.notify("Retrying the saved hand-off prompt in this session", "info");
			try {
				await pi.sendUserMessage(delivery.prompt);
			} catch (err) {
				finishDelivery(claim.attempt, true);
				if (readRelay()?.pending === delivery) {
					failAdvance(ctx, `could not send the hand-off prompt: ${messageOf(err)}`);
				}
			}
			return;
		}
		if (active?.pending && active.waiting?.kind !== "attention") {
			return ctx.ui.notify("The relay is already advancing to its next session", "info");
		}
		if (relay.pending) {
			if (!model) return ctx.ui.notify("The saved hand-off has no model to carry over. `/hand-off-relay off` stops it; another `off` discards the snapshot.", "error");
			const pending = { prompt: relay.pending.prompt };
			// The handoff already carries the saved model; a staged switch must not
			// fire a second time on the hop after next.
			writeRelay({ ...relay, pending, waiting: undefined, nextModel: undefined });
			writeHandoff({ provider: model.provider, modelId: model.modelId, thinkingLevel: model.thinkingLevel });
			ctx.ui.notify(`${stopped ? "Resuming stopped" : "Retrying"} hand-off into step ${relayStep(relay) + 1} of ${relay.maxSteps}`, "info");
			void pi.sendUserMessage(`/${RELAY_COMMAND}`, { expandPromptTemplates: true });
			watchAdvance(ctx, pending);
			return;
		}
		const outstanding = relay.backgroundTasks?.length ?? 0;
		if (
			active && outstanding > 0 && relay.waiting?.kind === "background" &&
			!awaitingBackgroundNotification(relay) && options.maxSteps === undefined && options.maxCost === undefined
		) {
			return ctx.ui.notify(
				`The relay is still waiting for ${outstanding} background task${outstanding === 1 ? "" : "s"}; no resume is needed. \`/hand-off-relay status\` lists them and \`off\` stops the relay.`,
				"info",
			);
		}
		if (active && !ctx.isIdle()) return ctx.ui.notify("The relay is already running in this session", "info");
		if (!active && !ctx.isIdle()) await ctx.waitForIdle();
		writeRelay({
			...relay,
			waiting: undefined,
			backgroundTasks: active ? relay.backgroundTasks : undefined,
			backgroundNotifications: undefined,
			nudged: false,
			warned: undefined,
		});
		ctx.ui.notify(
			`Hand-off relay resumed at step ${relayStep(relay)} of ${relay.maxSteps}, $${relay.spent.toFixed(2)} spent before this session. \`/hand-off-relay off\` stops it.`,
			"info",
		);
		const reason = stopped
			? `The user resumed the relay after it stopped (${stopped.reason}). Reconsider that decision and continue from the current state, checking any unfinished background work rather than assuming its result.`
			: active
				? "The user resumed the relay. Continue where you left off, checking any unfinished background work rather than assuming its result."
				: "The relay was interrupted (the process exited). Continue where you left off, checking any unfinished background work rather than assuming its result.";
		await pi.sendUserMessage(`${reason}\n\n---\n\n${buildRelayProtocol(relayStep(relay), relay.maxSteps)}`);
	}

	/** Handles `/hand-off-relay model [provider/model[:level]]`: stage the next hop's model. */
	async function handleRelayModel(ctx: ExtensionCommandContext, relay: RelayState | undefined, spec: string): Promise<void> {
		if (!relay) {
			const other = relayOwnedByOtherProcess(ctx.cwd);
			if (other) {
				return ctx.ui.notify(`${ownedElsewhereMessage(other.record)} Its model can only be changed in that process.`, "warning");
			}
			return ctx.ui.notify("No hand-off relay is active. Start one with /hand-off-relay --max-steps N.", "info");
		}
		if (relay.pending) {
			return ctx.ui.notify("The next hand-off is already starting; too late to switch its model.", "warning");
		}
		if (relay.sessionIds.at(-1) !== ctx.sessionManager.getSessionId()) {
			return ctx.ui.notify(
				`The relay is waiting on session ${relay.sessionIds.at(-1)}, not this one. Run /hand-off-relay model there, or /hand-off-relay off to clear the relay.`,
				"warning",
			);
		}

		const stage = (staged: PersistedRelayModel): void => {
			setRelayPersistence({ cwd: ctx.cwd, model: staged });
			writeRelay({ ...relay, nextModel: staged });
			ctx.ui.notify(
				`Next hand-off hop will use ${staged.provider}/${staged.modelId}${staged.thinkingLevel ? `:${staged.thinkingLevel}` : ""}. This session keeps its model; the switch takes effect when the agent hands off.`,
				"info",
			);
		};

		if (!spec.trim()) {
			const picked = await pickTargetModel(ctx, {
				title: "Model for the next hand-off hop",
				providerTitle: "Provider for the next hand-off hop",
			});
			if (!picked) return;
			if (!ctx.modelRegistry.hasConfiguredAuth(picked.model)) {
				return ctx.ui.notify(`No auth configured for ${picked.model.provider}/${picked.model.id}; the relay keeps its current model`, "error");
			}
			return stage({ provider: picked.model.provider, modelId: picked.model.id, thinkingLevel: picked.thinkingLevel });
		}

		const parsedSpec = parseModelSpec(spec);
		if ("error" in parsedSpec) return ctx.ui.notify(parsedSpec.error, "error");
		const model = ctx.modelRegistry.find(parsedSpec.model.provider, parsedSpec.model.modelId);
		if (!model) {
			return ctx.ui.notify(`Model ${parsedSpec.model.provider}/${parsedSpec.model.modelId} is not available; the relay keeps its current model`, "error");
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			return ctx.ui.notify(`No auth configured for ${model.provider}/${model.id}; the relay keeps its current model`, "error");
		}
		stage({ provider: model.provider, modelId: model.id, thinkingLevel: parsedSpec.model.thinkingLevel });
	}

	/** Handles `/hand-off-relay \u2026`. */
	async function handleRelayCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseRelayArgs(args);
		if (parsed.kind === "error") return ctx.ui.notify(parsed.error, "error");
		const relay = readRelay();
		const sessionId = ctx.sessionManager.getSessionId();
		if (parsed.kind === "status") {
			if (!relay) {
				const other = relayOwnedByOtherProcess(ctx.cwd);
				if (other) return ctx.ui.notify(ownedElsewhereMessage(other.record), "info");
				const saved = loadPersistedRelay(relayStatePath(ctx.cwd));
				const stoppedRecord = readStoppedRelay(ctx.cwd)?.record;
				const recovered = stoppedRecord ?? (saved && "record" in saved ? saved.record : undefined);
				if (recovered) {
					const r = recovered.relay;
					const stopped = recovered.stopped;
					return ctx.ui.notify(
						stopped
							? `Hand-off relay stopped at step ${relayStep(r)} of ${r.maxSteps}: ${stopped.reason} \`/hand-off-relay resume\` reopens it; \`off\` discards the stopped snapshot.`
							: `No hand-off relay is running, but one was interrupted at step ${relayStep(r)} of ${r.maxSteps}. \`/hand-off-relay resume\` continues it; \`/hand-off-relay off\` discards it.`,
						"info",
					);
				}
				return ctx.ui.notify("No hand-off relay is active", "info");
			}
			const phase = relayPhase(relay);
			const lines = [
				`Hand-off relay ${relayPhaseLabel(relay)}: step ${relayStep(relay)} of ${relay.maxSteps}, $${relay.spent.toFixed(2)} spent before this session${relay.maxCost !== undefined ? ` (limit $${relay.maxCost.toFixed(2)})` : ""}`,
			];
			const tasks = relay.backgroundTasks ?? [];
			if (tasks.length > 0) {
				lines.push(`Background tasks: ${tasks.map((task) => `${task.description} (${task.source}/${task.id})`).join(", ")}`);
			}
			if (phase === "running") {
				lines.push("Next: the current agent works and eventually supplies a relay signal. Reply to steer it, or use `model` / `off`.");
			} else if (phase === "background") {
				lines.push(tasks.length > 0
					? "Next: a completion notification resumes the agent automatically. `resume` is available after they finish; `off` stops the relay."
					: "Next: wait for the completion notification. If it was lost, `resume` re-prompts this session; `off` stops the relay.");
			} else if (phase === "unsignalled") {
				lines.push(`Reason: ${relay.waiting?.kind === "unsignalled" ? relay.waiting.reason : "no relay signal"}`);
				lines.push("Next: any notification or reply lets the agent continue. `resume` asks for a relay signal now; `off` stops it.");
			} else if (phase === "user") {
				lines.push(`Waiting for you: ${relay.waiting?.kind === "user" ? relay.waiting.reason : "the agent needs an answer"}`);
				lines.push("Next: reply in this session or run `resume`. Unrelated notifications do not advance the relay; `off` stops it.");
			} else if (phase === "attention") {
				lines.push(`Problem: ${relay.waiting?.kind === "attention" ? relay.waiting.reason : "the relay needs guidance"}`);
				lines.push("Next: reply with guidance or run `resume` to retry the protocol. `off` stops the relay.");
			} else if (relay.pending?.deliverHere) {
				lines.push(relay.pending.targetSessionId === sessionId
					? "Next: this replacement session has not accepted the saved prompt. `resume` retries delivery; `off` stops recoverably."
					: "Next: the replacement prompt has not started, so its session is not a committed step. `resume` replays the hand-off; `off` stops recoverably.");
			} else {
				lines.push("Next: the saved hand-off is advancing into a fresh session. `off` can cancel it before replacement.");
			}
			const staged = relay.nextModel;
			const next = staged
				? `${staged.provider}/${staged.modelId}${staged.thinkingLevel ? ` · ${staged.thinkingLevel}` : ""} (staged with /hand-off-relay model)`
				: ctx.model
					? `${ctx.model.provider}/${ctx.model.id}${ctx.thinkingLevel ? ` · ${ctx.thinkingLevel}` : ""} (carries over; /hand-off-relay model switches it)`
					: undefined;
			if (next) lines.push(`Next hop: ${next}`);
			if (relay.sessionIds.length > 1) lines.push(`Sessions: ${relay.sessionIds.join(" \u2192 ")}`);
			if (relay.pending?.deliverHere && relay.pending.targetSessionId !== sessionId) {
				lines.push(`Delivery targeted session ${relay.pending.targetSessionId ?? "unknown"}, but that step is not committed. If it is unavailable, \`resume\` replays the hand-off from here.`);
			} else if (!relay.pending?.deliverHere && relay.sessionIds.at(-1) !== sessionId) {
				lines.push(`Waiting on session ${relay.sessionIds.at(-1)}, not this one. \`/hand-off-relay off\` clears it.`);
			}
			return ctx.ui.notify(lines.join("\n"), "info");
		}
		if (parsed.kind === "off") {
			const other = relay ? undefined : relayOwnedByOtherProcess(ctx.cwd);
			if (other) return ctx.ui.notify(`${ownedElsewhereMessage(other.record)} It can only be stopped from that process.`, "warning");
			setRelayPersistence({ cwd: ctx.cwd, model: persistence?.model });
			if (relay) return stopRelay(ctx, "disarmed by the user", "info");
			const saved = loadPersistedRelay(relayStatePath(ctx.cwd));
			const stopped = readStoppedRelay(ctx.cwd);
			writeRelay(undefined);
			ctx.ui.notify(
				stopped
					? "Stopped hand-off relay snapshot discarded"
					: saved && "record" in saved ? "Interrupted hand-off relay discarded" : "No hand-off relay is active",
				"info",
			);
			announceRelayState(ctx, "No hand-off relay is active. Its previous protocol has no effect unless the user resumes it or explicitly arms another relay.");
			return;
		}
		if (parsed.kind === "model") return handleRelayModel(ctx, relay, parsed.spec);
		if (flowInProgress) return ctx.ui.notify("A hand-off is already in progress", "warning");
		if (parsed.kind === "resume") return resumeRelay(ctx, relay, parsed);
		if (!ctx.model) return ctx.ui.notify("/hand-off-relay: the current session has no model to carry over", "error");
		if (relay?.sessionIds.at(-1) === sessionId) {
			return ctx.ui.notify(
				`A relay is already present in this session (${relayPhaseLabel(relay)}). Use \`/hand-off-relay status\` to inspect it, \`resume\` to continue an idle relay, or \`off\` to stop it first.`,
				"warning",
			);
		}
		const other = relay ? undefined : relayOwnedByOtherProcess(ctx.cwd);
		if (other) {
			return ctx.ui.notify(
				`${ownedElsewhereMessage(other.record)} Only one relay can run per directory; start this one elsewhere, or after that one stops.`,
				"warning",
			);
		}
		const previous = !relay ? loadPersistedRelay(relayStatePath(ctx.cwd)) : undefined;
		const stopped = !relay ? readStoppedRelay(ctx.cwd) : undefined;
		const interrupted = !stopped && previous && "record" in previous && !previous.record.stopped;
		if (!ctx.isIdle()) await ctx.waitForIdle();

		// A relay waiting on some other session is stale (its session was left
		// by hand); this process can only run one relay, so replace it.
		setRelayPersistence({
			cwd: ctx.cwd,
			model: { provider: ctx.model.provider, modelId: ctx.model.id, thinkingLevel: ctx.thinkingLevel },
		});
		writeRelay({ maxSteps: parsed.maxSteps, maxCost: parsed.maxCost, spent: 0, sessionIds: [sessionId] });
		const stale = relay ? " Replaced a stale relay." : interrupted ? " Replaced an interrupted relay." : stopped ? " Replaced a stopped relay." : "";
		ctx.ui.notify(
			`Hand-off relay armed: up to ${parsed.maxSteps} hand-offs${parsed.maxCost !== undefined ? `, $${parsed.maxCost.toFixed(2)} limit` : ", no cost limit"}, same model each hop unless you stage a switch with \`/hand-off-relay model\`.${stale} Agents run unattended with your full tool access. \`/hand-off-relay off\` stops it.`,
			"info",
		);
		const protocol = buildRelayProtocol(0, parsed.maxSteps);
		if (parsed.task) {
			await pi.sendUserMessage(`${parsed.task}\n\n---\n\n${protocol}`);
		} else {
			await pi.sendMessage(
				{ customType: RELAY_PROTOCOL_TYPE, content: protocol, display: true },
				{ triggerTurn: false },
			);
		}
	}

	pi.registerFlag(FLAG_MAX_SOURCE_CHARS, {
		description:
			"pi-hand-off: max characters of conversation sent to the /hand-off writer (0 disables the budget)",
		type: "string",
	});
	pi.registerFlag(FLAG_SUMMARIZER, {
		description: "pi-hand-off: model that writes /hand-off prompts, as provider/model",
		type: "string",
	});

	pi.registerCommand("hand-off-relay", {
		description:
			"Autonomous hand-off relay: /hand-off-relay --max-steps <N> [--max-cost USD] [task] lets agents hand off to each other for up to N hand-offs (the first agent is step 0); `model [provider/model[:level]]` stages the next hop's model; `off` stops an active relay or discards a stopped one; `status` reports the lifecycle state; `resume [--max-steps N] [--max-cost USD]` continues an idle, paused, failed-advance, stopped, or interrupted relay",
		handler: async (args, ctx) => handleRelayCommand(args, ctx),
	});

	pi.registerCommand("hand-off", {
		description:
			"Hand the conversation to another model: choose who writes the hand-off prompt (this agent or a fresh pass), pick the next model and thinking level, then review the prompt in a fresh session",
		handler: async (args, ctx) => {
			if (flowInProgress) {
				ctx.ui.notify("A hand-off is already in progress", "warning");
				return;
			}
			try {
				flowInProgress = true;

				const parsed = parseHandoffArgs(args);
				if (parsed.error) {
					ctx.ui.notify(parsed.error, "error");
					return;
				}

				if (!ctx.isIdle()) {
					ctx.ui.notify("Waiting for the agent to finish before handing off", "info");
					await ctx.waitForIdle();
				}

				// Read before the live writer's request adds a message of its own.
				const lastActiveMs = lastMessageTime(ctx);

				// Writer model: pi CLI flag > config file. There is no command-arg
				// flag; without a configured preference the picker just opens.
				const flagSummarizer = pi.getFlag(FLAG_SUMMARIZER);
				const summarizerSpec =
					(typeof flagSummarizer === "string" && flagSummarizer.trim() ? flagSummarizer.trim() : undefined) ??
					handoffSettings.summarizerModel;
				const pinnedModel = summarizerSpec
					? ctx.modelRegistry.find(
							summarizerSpec.slice(0, summarizerSpec.indexOf("/")),
							summarizerSpec.slice(summarizerSpec.indexOf("/") + 1),
						)
					: undefined;
				if (summarizerSpec && !pinnedModel) {
					ctx.ui.notify(
						`Hand-off writer model ${summarizerSpec} is not available; choose one instead`,
						"warning",
					);
				}
				// A pi CLI flag is not asked about again; a config-file model is only
				// silently accepted when `askSummarizerModel` is false.
				const pinnedByFlag = typeof flagSummarizer === "string";
				const askSummarizer =
					!pinnedModel || (!pinnedByFlag && handoffSettings.askSummarizerModel !== false);

				// 1. Choose who writes the hand-off prompt, and (for the fresh pass)
				// how hard that model should think.
				const writer = await chooseWriter(ctx, {
					writer: parsed.writer,
					pinnedModel,
					askSummarizer,
				});
				if (!writer) return;

				let writerReasoning: ThinkingLevel | undefined;
				if (writer.kind === "fresh" && writer.model.reasoning) {
					const chosen = await selectWriterReasoningLevel(ctx, handoffSettings.summarizerThinkingLevel);
					if (!chosen) return;
					writerReasoning = chosen.reasoning;
				}

				// 2–3. Destination model and thinking level. The same-or-pick picker's
				// first option re-uses the current session's values in one Enter press;
				// `--same` skips that dialog. On the picked-model path a scoped
				// `model:level` entry pins the level.
				const reuse = parsed.same ? "same" : await chooseSameOrPick(ctx);
				if (!reuse) return;
				let target: PickedModel | undefined;
				let level: ThinkingLevel | undefined;
				if (reuse === "same") {
					if (!ctx.model) {
						ctx.ui.notify("--same: the current session has no model to reuse", "error");
						return;
					}
					target = { model: ctx.model };
					level = ctx.thinkingLevel;
				} else {
					target = await pickTargetModel(ctx);
					if (!target) return;
					level = target.thinkingLevel ?? (await selectThinkingLevel(ctx));
					if (level === undefined) return;
				}

				// 4. Steering instructions: when passed inline as `/hand-off <instructions>`
				// they are used as-is; only an empty steering text opens the editor.
				const inlineSteering = parsed.steering.trim();
				const steering =
					inlineSteering ||
					(await ctx.ui.editor(
						writer.kind === "live"
							? "Steering for the hand-off prompt (sent to the current agent)"
							: "Steering for the hand-off prompt (sent to the hand-off writer)",
						"",
					));
				if (steering === undefined) return;

				// 5. Write the hand-off prompt with the chosen writer.
				const prompt =
					writer.kind === "live"
						? await captureFromLiveAgent(ctx, steering)
						: await captureFromFreshPass(ctx, writer, writerReasoning, steering, lastActiveMs);
				if (!prompt) return;

				// 6. Carry everything across session replacement as plain data, with
				// the provenance comment and authority note added here (never by the writer model).
				writeHandoff({
					provider: target.model.provider,
					modelId: target.model.id,
					thinkingLevel: level,
					prompt: withSessionProvenance(prompt, ctx, { fresh: writer.kind === "fresh", lastActiveMs }),
				});

				const result = await ctx.newSession();
				// Normally session_start already consumed the handoff; clear any
				// leftover so it can never apply to a later, unrelated /new.
				takeHandoff();
				if (result.cancelled) {
					ctx.ui.notify("Hand-off cancelled by extension", "warning");
				}
			} catch (err) {
				takeHandoff();
				awaitingHandoff = false;
				ctx.ui.notify(`Hand-off failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				flowInProgress = false;
			}
		},
	});

	pi.on("agent_end", (event) => {
		if (!awaitingHandoff) return;
		awaitingHandoff = false;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				// Only accept a cleanly finished message: agent_end also fires on
				// abort and error, where the text is partial or absent.
				if ((message as { stopReason?: string }).stopReason !== "stop") break;
				const text = messageText(message as { role: string; content: string | Array<{ type: string; text?: string }> });
				if (text.trim()) capturedPrompt = text.trim();
				break;
			}
		}
	});

	pi.on("session_start", async (event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		const loaded = loadHandoffSettings();
		handoffSettings = loaded.settings;
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");

		// Keep the persistence target pointed at this directory; during a relay
		// the model comes from the hop, otherwise there is nothing to save.
		setRelayPersistence({ cwd: ctx.cwd, model: persistence?.cwd === ctx.cwd ? persistence?.model : undefined });
		if (!readRelay() && event.reason !== "new") {
			const saved = loadPersistedRelay(relayStatePath(ctx.cwd));
			const stoppedRecord = readStoppedRelay(ctx.cwd)?.record;
			const recovered = stoppedRecord ?? (saved && "record" in saved ? saved.record : undefined);
			// A relay that another live pi process is running is not interrupted.
			if (recovered && !relayOwnedByOtherProcess(ctx.cwd)) {
				const r = recovered.relay;
				const stopped = recovered.stopped;
				ctx.ui.notify(
					stopped
						? `A hand-off relay stopped in session ${r.sessionIds.at(-1)}: ${stopped.reason} Open that session and use \`/hand-off-relay resume\` to reconsider, or \`off\` to discard the snapshot.`
						: `A hand-off relay was interrupted at step ${relayStep(r)} of ${r.maxSteps} ($${r.spent.toFixed(2)} spent before that session). \`/hand-off-relay resume\` continues it; \`/hand-off-relay off\` discards it.`,
					stopped ? "info" : "warning",
				);
			}
		}

		if (event.reason !== "new") return;

		const handoff = takeHandoff();
		if (!handoff) return;

		await applyHandoffModel(handoff, ctx);

		if (handoff.prompt) {
			try {
				ctx.ui.setEditorText(handoff.prompt);
			} catch (err) {
				ctx.ui.notify(
					`pi-hand-off: could not insert the hand-off prompt into the editor: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}
	});
}
