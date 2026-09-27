import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig } from "../src/config.js";
import { createWatchdog, TOOL_DENY_REASON } from "../src/runtime.js";

function harness(overrides = {}) {
	let time = 0;
	const pending = [];
	const clock = {
		now: () => time,
		setTimeout(fn, ms) {
			const handle = { fn, at: time + ms, cleared: false };
			pending.push(handle);
			return handle;
		},
		clearTimeout(handle) {
			if (handle) handle.cleared = true;
		},
	};
	const sent = [];
	const silent = [];
	const toasts = [];
	const hooks = [];
	const cancels = [];
	const agent = {
		id: "root",
		status: "idle",
		inbox: { nextTurn: [], nextStep: [] },
		session: {
			deriveMessages() {
				return silent.map((message) => message);
			},
			append(_type, message) {
				silent.push(message);
				return { seq: silent.length };
			},
		},
		followup(message) {
			sent.push(message);
			this.inbox.nextTurn.push(message);
		},
		cancel(cause) {
			cancels.push(cause);
			this.status = "idle";
		},
	};
	let streamImpl = async () =>
		`<watchdog><function>continue_watchdog</function><reason_type>WORK_REMAINS</reason_type><reason_content>tests left</reason_content></watchdog>`;
	const config = mergeConfig(undefined, undefined).config;
	const watchdog = createWatchdog({
		config: overrides.config ?? config,
		agents: () => [agent, ...(overrides.extraAgents ?? [])],
		roots: () => [agent],
		now: () => time,
		clock,
		offsetMinutes: () => -480,
		streamText: (request) => streamImpl(request),
		createUser: (input) => ({ role: "user", ...input }),
		toast: (text) => toasts.push(text),
		events: { emit: (channel, data) => hooks.push([channel, data]) },
		followup: (target, message) => target.followup(message),
		appendSilent: (target, message) => {
			target.session.append("user/message", message);
			return true;
		},
		cancelAgent: (target) => target.cancel({ kind: "user" }),
	});
	function advance(ms) {
		time += ms;
		for (const handle of pending) {
			if (!handle.cleared && handle.at <= time) {
				handle.cleared = true;
				handle.fn();
			}
		}
	}
	return {
		agent,
		watchdog,
		sent,
		silent,
		toasts,
		hooks,
		cancels,
		advance,
		setStream(fn) {
			streamImpl = fn;
		},
		text(message) {
			return message.content.map((block) => block.text).join("");
		},
	};
}

async function settle(env) {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

test("user message locks silently; idle fence then continue wakes once", async () => {
	const env = harness();
	env.agent.status = "running";
	env.watchdog.noteUserMessage(env.agent, "user");
	assert.equal(env.toasts.length, 0);
	assert.equal(env.watchdog.snapshot().locked, true);
	env.watchdog.noteTurnEnd(env.agent, "completed");
	env.agent.status = "idle";
	env.watchdog.noteStatus(env.agent);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.sent.length, 1);
	assert.match(env.text(env.sent[0]), /^Continue watchdog continued · WORK_REMAINS · /);
	assert.match(env.text(env.sent[0]), /Continue until user assistance is required\./);
	assert.equal(env.hooks[0][0], "pi:semantic-hook:v1");
	assert.equal(env.hooks[0][1].name, "watchdog-continued");
	assert.equal(env.silent.length, 0);
	env.watchdog.dispose();
});

test("wait publishes no work turn and blocks the next fence until the deadline", async () => {
	const env = harness();
	env.setStream(async () =>
		`<watchdog><function>wait_watchdog</function><reason_content>Waiting for CI.</reason_content><wait_seconds>30</wait_seconds></watchdog>`,
	);
	env.agent.status = "running";
	env.watchdog.noteUserMessage(env.agent, "user");
	env.agent.status = "idle";
	env.watchdog.noteTurnEnd(env.agent, "completed");
	env.watchdog.noteStatus(env.agent);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.sent.length, 0);
	assert.equal(env.silent.length, 1);
	assert.match(env.text(env.silent[0]), /^Continue watchdog waiting · 30s · /);
	assert.equal(env.hooks.at(-1)[1].name, "watchdog-waiting");
	assert.equal(env.hooks.at(-1)[1].values.WAIT_SECONDS, "30");
	env.advance(10_000);
	await settle(env);
	assert.equal(env.silent.length, 1);
	env.advance(20_000);
	await settle(env);
	assert.ok(env.silent.some((message) => env.text(message).startsWith("Continue watchdog delay elapsed · requested 30s · ")));
	env.watchdog.dispose();
});

test("third invalid decision publishes the safe diagnostic and stays locked", async () => {
	const env = harness();
	env.setStream(async () => "nope");
	env.agent.status = "running";
	env.watchdog.noteStatus(env.agent);
	env.agent.status = "idle";
	env.watchdog.noteTurnEnd(env.agent, "completed");
	env.watchdog.noteStatus(env.agent);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.watchdog.snapshot().decisionFailed, true);
	assert.equal(env.watchdog.snapshot().locked, true);
	assert.match(env.toasts.at(-1), /decision failed after 3 attempts/);
	assert.match(env.text(env.silent[0]), /^Continue watchdog decision failed · /);
	assert.equal(env.hooks.at(-1)[1].values.STOP_KIND, "DECISION_FAILED");
	env.watchdog.dispose();
});

test("terminal error unlocks without an inquiry; abort unlocks reasonlessly", async () => {
	const env = harness();
	env.agent.status = "running";
	env.watchdog.noteUserMessage(env.agent, "user");
	env.watchdog.noteTurnEnd(env.agent, "error");
	assert.equal(env.watchdog.snapshot().locked, false);
	assert.equal(env.toasts.at(-1), "Continue watchdog unlocked · run ended in error");
	assert.equal(env.hooks.at(-1)[1].values.STOP_KIND, "ERROR_UNLOCK");
	env.agent.status = "running";
	env.watchdog.noteStatus(env.agent);
	env.watchdog.noteTurnEnd(env.agent, "aborted");
	assert.equal(env.toasts.at(-1), "Continue watchdog unlocked");
	env.watchdog.dispose();
});

test("manual lock notifies; reasoned human unlock does not toast and cancels a live run", () => {
	const env = harness();
	env.agent.status = "idle";
	env.watchdog.noteStatus(env.agent);
	const locked = env.watchdog.commandLock(env.agent);
	assert.equal(locked.text, "Continue watchdog locked");
	assert.equal(env.toasts.at(-1), "Continue watchdog locked");
	env.agent.status = "running";
	const unlocked = env.watchdog.commandUnlock(env.agent, "  user took over  ");
	assert.equal(unlocked.text, "Continue watchdog unlocked · user took over");
	assert.equal(env.toasts.at(-1), "Continue watchdog locked");
	assert.equal(env.cancels.length, 1);
	env.watchdog.noteTurnEnd(env.agent, "aborted");
	assert.equal(env.watchdog.snapshot().locked, false);
	assert.ok(!env.toasts.includes("Continue watchdog unlocked"));
	env.watchdog.dispose();
});

test("a busy other agent holds the fence; tool calls are denied only during a decision", async () => {
	const other = { id: "child", status: "running", inbox: { nextTurn: [], nextStep: [] } };
	const env = harness({ extraAgents: [other] });
	env.agent.status = "running";
	env.watchdog.noteUserMessage(env.agent, "user");
	env.agent.status = "idle";
	env.watchdog.noteTurnEnd(env.agent, "completed");
	env.watchdog.noteStatus(env.agent);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.sent.length, 0);
	other.status = "idle";
	env.watchdog.noteStatus(other);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.sent.length, 1);
	assert.equal(TOOL_DENY_REASON.includes("watchdog XML"), true);
	env.watchdog.dispose();
});

test("tool execution is denied only while a decision call is in flight", async () => {
	const env = harness();
	let release;
	env.setStream(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	env.agent.status = "idle";
	env.watchdog.noteUserMessage(env.agent, "user");
	env.watchdog.noteTurnEnd(env.agent, "completed");
	env.watchdog.noteStatus(env.agent);
	assert.equal(env.watchdog.blocksTools(env.agent), false);
	env.advance(10_000);
	await settle(env);
	assert.equal(env.watchdog.blocksTools(env.agent), true);
	release(
		`<watchdog><function>unlock_continue_watchdog</function><reason_type>JOB_DONE</reason_type><reason_content>done</reason_content></watchdog>`,
	);
	await settle(env);
	assert.equal(env.watchdog.blocksTools(env.agent), false);
	assert.equal(env.sent.length, 0);
	assert.match(env.text(env.silent[0]), /^Continue watchdog unlocked · JOB_DONE · /);
	assert.equal(env.hooks.at(-1)[1].values.STOP_KIND, "AI_UNLOCK");
	env.watchdog.dispose();
});

test("status command reports the main blocker", () => {
	const env = harness();
	const text = env.watchdog.commandStatus(env.agent).text;
	assert.match(text, /Main: yes/);
	assert.match(text, /Lock: unlocked/);
	assert.match(text, /domain unavailable/);
	env.watchdog.dispose();
});
