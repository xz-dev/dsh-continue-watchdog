// dsh-continue-watchdog — port of pi-continue-watchdog onto DeepSeek Harness.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { mergeConfig, mergeRow } from "./config.js";
import { createWatchdog, TOOL_DENY_REASON } from "./runtime.js";

export const name = "dsh-continue-watchdog";
export const inject = ["agents"];

export const Config = z.object({
	idleDelaySeconds: z.number().min(0).default(10),
	maxRetries: z.number().step(1).min(1).max(10).default(10),
	// "" = use the built-in prompt (blankRow drops it); min(1) here would reject the default itself.
	decisionPrompt: z.string().default(""),
	continuePrompt: z.string().default(""),
	reasonTypes: z.array(z.string()).default([]),
	continueReasonTypes: z.array(z.string()).default([]),
	unlockShortcut: z.union([z.string(), z.const(false)]).default("alt+u"),
});

export function resolveConfig(row = {}) {
	const base = mergeConfig(undefined, undefined);
	const merged = mergeRow(base.config, blankRow(row));
	return merged.config;
}

function blankRow(row) {
	const next = { ...row };
	if (next.decisionPrompt === "") delete next.decisionPrompt;
	if (next.continuePrompt === "") delete next.continuePrompt;
	if (Array.isArray(next.reasonTypes) && next.reasonTypes.length === 0)
		delete next.reasonTypes;
	if (
		Array.isArray(next.continueReasonTypes) &&
		next.continueReasonTypes.length === 0
	)
		delete next.continueReasonTypes;
	return next;
}

async function streamText(ctx, request) {
	const runtime = ctx.get("llm");
	if (runtime === undefined) throw new Error("llm runtime unavailable");
	const provider = request.agent.options?.provider;
	const model = request.agent.options?.model;
	if (!provider || !model) throw new Error("agent has no provider/model route");
	let text = "";
	for await (const chunk of runtime.stream({
		provider,
		model,
		messages: request.messages,
		purpose: "session-title",
		signal: request.signal,
	})) {
		if (chunk?.type === "text-delta" && typeof chunk.text === "string")
			text += chunk.text;
		else if (chunk?.type === "text" && typeof chunk.text === "string")
			text += chunk.text;
	}
	return text;
}

export function apply(ctx, rawConfig = {}) {
	const config = resolveConfig(rawConfig);
	const agentsService = ctx.agents;
	const watchdog = createWatchdog({
		config,
		agents: () => agentsService.list?.() ?? agentsService.roots?.() ?? [],
		roots: () => agentsService.roots?.() ?? [],
		streamText: (request) => streamText(ctx, request),
		createUser: (input) => createUserMessage(input),
		toast: (text) => ctx.get("tuiToast")?.show?.(text),
		events: { emit: (channel, data) => ctx.emit(channel, data) },
		followup: (agent, message) => agent.followup(message),
		appendSilent: (agent, message) => {
			agent.session.append("user/message", message, { surfaceOp: "append" });
			return true;
		},
		cancelAgent: (agent) => agent.cancel({ kind: "user" }),
	});

	ctx.on("agent/status", (payload) => {
		watchdog.noteStatus(payload.agent);
	});
	ctx.on("agent/disposed", () => {
		watchdog.reconcile();
	});
	ctx.on("session/event", (session, event) => {
		const agent = agentsService.get?.(session.id) ?? agentsService.roots?.().find((candidate) => candidate.session === session);
		if (agent === undefined) return;
		if (event.type === "user/message") {
			watchdog.noteUserMessage(agent, event.data?.source?.kind);
			return;
		}
		if (event.type === "turn/end") {
			watchdog.noteTurnEnd(agent, event.data?.reason?.kind);
		}
	});
	ctx.on("tools/pre-execute", async (exec, next) => {
		if (watchdog.blocksTools(exec.agent))
			return { kind: "deny", reason: TOOL_DENY_REASON };
		return next();
	});

	const commands = ctx.get("commands");
	commands?.register?.({
		name: "lock-continue-watchdog",
		description: "Lock continue watchdog and start a fresh cycle",
		handler: async (invocation) => watchdog.commandLock(invocation.agent),
	});
	commands?.register?.({
		name: "unlock-continue-watchdog",
		description: "Unlock continue watchdog; optional untyped reason",
		input: { hint: "optional reason" },
		handler: async (invocation) =>
			watchdog.commandUnlock(invocation.agent, invocation.rawInput),
	});
	commands?.register?.({
		name: "status-continue-watchdog",
		description: "Show continue watchdog trigger status",
		handler: async (invocation) => watchdog.commandStatus(invocation.agent),
	});

	if (config.unlockShortcut !== false) {
		const disposer = ctx.get("tuiShortcuts")?.register?.(config.unlockShortcut, {
			description: "Unlock continue watchdog (dsh-continue-watchdog)",
			handler: () => {
				const agent = agentsService.roots?.()[0];
				if (agent === undefined) return;
				watchdog.commandUnlock(agent, "");
			},
		});
		if (typeof disposer === "function") ctx.effect?.(() => disposer);
	}

	return () => watchdog.dispose();
}

export default { name, inject, Config, apply };
