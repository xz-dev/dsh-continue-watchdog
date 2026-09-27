import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfig, mergeRow } from "../src/config.js";
import { createLockDecisionController } from "../src/controller.js";
import {
	buildDecisionPrompt,
	validateDecisionResponse,
} from "../src/decision-protocol.js";
import { createActivityGraceCoordinator } from "../src/activity-grace.js";
import { INQUIRY_FENCE_MS } from "../src/activity-grace.js";
import {
	createWatchdogContinuedEnvelope,
	SEMANTIC_HOOK_CHANNEL,
} from "../src/semantic-hook.js";
import { formatWatchdogTriggerStatus } from "../src/status.js";
import { formatContinueWatchdogEvent, createContinueWatchdogEvent } from "../src/watchdog-event.js";

test("defaults match the Pi built-ins and a bad row does not clobber them", () => {
	const base = mergeConfig(undefined, undefined).config;
	assert.equal(base.maxRetries, 10);
	assert.equal(base.idleDelaySeconds, 10);
	assert.equal(base.unlockShortcut, "alt+u");
	assert.deepEqual(base.reasonTypes, ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"]);
	assert.match(base.decisionPrompt, /pi-continue-watchdog extension/);
	const merged = mergeRow(base, { maxRetries: 99, continuePrompt: "  " });
	assert.equal(merged.config.maxRetries, 10);
	assert.equal(merged.config.continuePrompt, "Continue until user assistance is required.");
	assert.ok(merged.diagnostics.length >= 1);
});

test("decision XML accepts continue, wait, and typed unlock; rejects a typed wait", () => {
	const reasonTypes = ["JOB_DONE", "WAIT_USER", "JOB_BLOCKED"];
	const continueReasonTypes = ["WORK_REMAINS", "VERIFYING"];
	const prompt = buildDecisionPrompt("Decide.", reasonTypes, continueReasonTypes);
	assert.match(prompt, /<watchdog>/);
	const continueVerdict = validateDecisionResponse(
		[{ type: "text", text: `note\n<watchdog><function>continue_watchdog</function><reason_type>verifying</reason_type><reason_content>still checking</reason_content></watchdog>` }],
		reasonTypes,
		continueReasonTypes,
	);
	assert.equal(continueVerdict.valid, true);
	assert.equal(continueVerdict.decision.reasonType, "VERIFYING");
	const waitVerdict = validateDecisionResponse(
		[{ type: "text", text: `<watchdog><function>wait_watchdog</function><reason_content>Waiting for CI.</reason_content><wait_seconds>1500</wait_seconds></watchdog>` }],
		reasonTypes,
		continueReasonTypes,
	);
	assert.equal(waitVerdict.decision.waitSeconds, 1500);
	const typedWait = validateDecisionResponse(
		[{ type: "text", text: `<watchdog><function>wait_watchdog</function><reason_type>WAIT_USER</reason_type><reason_content>no</reason_content><wait_seconds>10</wait_seconds></watchdog>` }],
		reasonTypes,
		continueReasonTypes,
	);
	assert.equal(typedWait.valid, false);
	const unlock = validateDecisionResponse(
		[{ type: "text", text: `<watchdog><function>unlock_continue_watchdog</function><reason_type>job_done</reason_type><reason_content>All requested package bumps are merged.</reason_content></watchdog>` }],
		reasonTypes,
		continueReasonTypes,
	);
	assert.equal(unlock.decision.reasonType, "JOB_DONE");
});

test("three invalid decisions fail the window; valid continue and wait share maxRetries", () => {
	const controller = createLockDecisionController({ maxRetries: 2 });
	controller.lock();
	const opened = controller.beginDecision(0);
	const id = opened.effects[0].decisionId;
	assert.equal(controller.recordInvalidDecision(id, "bad").effects[0].kind, "reaskDecision");
	assert.equal(controller.recordInvalidDecision(id, "bad").effects[0].kind, "reaskDecision");
	assert.equal(controller.recordInvalidDecision(id, "bad").effects.at(-1).kind, "decisionFailed");
	assert.equal(controller.snapshot.decisionFailed, true);
	const again = createLockDecisionController({ maxRetries: 2 });
	again.lock();
	const first = again.beginDecision(0).effects[0].decisionId;
	again.recordValidContinue(first);
	const second = again.beginDecision(0).effects[0].decisionId;
	again.recordValidWait(second, 5_000);
	assert.equal(again.snapshot.exhausted, true);
	assert.equal(again.beginDecision(5_000).applied, false);
});

test("idle fence restarts from a full 10s after activity", () => {
	let time = 1_000;
	const pending = [];
	const clock = {
		now: () => time,
		setTimeout(fn, ms) {
			const handle = { fn, at: time + ms, cleared: false };
			pending.push(handle);
			return handle;
		},
		clearTimeout(handle) {
			handle.cleared = true;
		},
	};
	let ready = 0;
	const grace = createActivityGraceCoordinator({
		clock,
		onReady() {
			ready += 1;
		},
	});
	grace.update({ generation: 1, allIdle: true, notBeforeMs: 0 });
	assert.equal(pending.at(-1).at - time, INQUIRY_FENCE_MS);
	grace.update({ generation: 1, allIdle: false, notBeforeMs: 0 });
	time = 50_000;
	for (const handle of pending) {
		if (!handle.cleared && handle.at <= time) handle.fn();
	}
	assert.equal(ready, 0);
	const before = pending.length;
	grace.update({ generation: 1, allIdle: true, notBeforeMs: 0 });
	assert.equal(pending[before].at - time, INQUIRY_FENCE_MS);
});

test("canonical continue body and semantic envelope keep Pi text", () => {
	const event = createContinueWatchdogEvent({
		occurredAtMs: Date.parse("2026-09-19T08:02:16.951Z"),
		offsetMinutes: -480,
		reasonType: "WORK_REMAINS",
		reason: "tests left",
	});
	const body = formatContinueWatchdogEvent(event, "Continue until user assistance is required.");
	assert.match(body, /^Continue watchdog continued · WORK_REMAINS · 2026-09-19T16:02:16\.951\+08:00/);
	assert.match(body, /pi-continue-watchdog extension/);
	const envelope = createWatchdogContinuedEnvelope({
		REASON_TYPE: "WORK_REMAINS",
		REASON: "tests left",
	});
	assert.equal(SEMANTIC_HOOK_CHANNEL, "pi:semantic-hook:v1");
	assert.equal(envelope.name, "watchdog-continued");
	const status = formatWatchdogTriggerStatus({
		main: true,
		locked: true,
		attempt: 0,
		maxRetries: 10,
		blocker: null,
		gracePhase: "blocked",
		graceRemainingMs: null,
		observableBusyCount: 0,
		domainBusyParticipants: null,
	});
	assert.match(status, /Trigger: eligible/);
	assert.match(status, /domain unavailable/);
});
