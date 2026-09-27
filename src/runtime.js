// DSH wiring for the Pi continue-watchdog decision flow.
// Decision XML stays off the session log (auxiliary model call). Only the
// canonical event body is published. Cross-process Pi domain is not available.

import { createActivityGraceCoordinator } from "./activity-grace.js";
import { createLockDecisionController } from "./controller.js";
import {
	buildDecisionPrompt,
	buildDecisionReaskPrompt,
	formatDecisionFailedNotification,
	validateDecisionResponse,
} from "./decision-protocol.js";
import {
	createUserReadyEnvelope,
	createWatchdogContinuedEnvelope,
	createWatchdogWaitingEnvelope,
	emitSemanticHook,
} from "./semantic-hook.js";
import { formatWatchdogTriggerStatus, truncateHumanReason } from "./status.js";
import {
	createCompletedWaitWatchdogEvent,
	createContinueWatchdogEvent,
	createDecisionFailedWatchdogEvent,
	createExhaustedWatchdogEvent,
	createUnlockWatchdogEvent,
	createWaitWatchdogEvent,
	formatCompletedWaitWatchdogEvent,
	formatContinueWatchdogEvent,
	formatDecisionFailedWatchdogEvent,
	formatExhaustedWatchdogEvent,
	formatUnlockWatchdogEvent,
	formatWaitWatchdogEvent,
} from "./watchdog-event.js";

const SOURCE_KIND = "dsh-continue-watchdog";
const TOOL_DENY_REASON =
	"Continue watchdog decision in progress. Do not call tools. Finish with exactly one watchdog XML block.";

function inboxPending(agent) {
	const inbox = agent?.inbox;
	if (inbox === undefined || inbox === null) return false;
	return (
		(inbox.nextTurn?.length ?? 0) > 0 || (inbox.nextStep?.length ?? 0) > 0
	);
}

function textMessage(createUser, text) {
	return createUser({
		content: [{ type: "text", text }],
		source: { kind: SOURCE_KIND },
	});
}

export function createWatchdog(options) {
	const {
		config,
		agents,
		roots,
		now = () => Date.now(),
		clock,
		streamText,
		createUser,
		toast = () => {},
		events = { emit() {} },
		followup,
		appendSilent,
		cancelAgent = () => {},
	} = options;

	const controller = createLockDecisionController(config);
	const offsets = () =>
		options.offsetMinutes?.() ?? new Date(now()).getTimezoneOffset();
	let epoch = 0;
	let decision = null;
	let pendingWait = null;
	let suppressAbortUnlock = false;
	let disposed = false;

	const mainAgent = () => roots()?.[0];
	const isMain = (agent) => agent !== undefined && agent === mainAgent();

	const grace = createActivityGraceCoordinator({
		clock,
		onReady(generation) {
			if (disposed || generation !== epoch) return;
			void onFence(generation);
		},
	});

	function snapshot() {
		return controller.snapshot;
	}

	function anyBusy() {
		for (const agent of agents?.() ?? []) {
			if (agent?.status === "running" || inboxPending(agent)) return true;
		}
		return decision !== null;
	}

	function blockerFor(agent) {
		if (!isMain(agent)) return "not-main";
		const snap = snapshot();
		if (!snap.locked) return "unlocked";
		if (snap.decisionFailed) return "decision-failed";
		if (decision !== null) return "decision-open";
		if (agent.status === "running") return "local-agent-busy";
		if (inboxPending(agent)) return "pending-messages";
		for (const other of agents?.() ?? []) {
			if (other !== agent && (other.status === "running" || inboxPending(other)))
				return "observable-agent-busy";
		}
		if (snap.exhausted && !(pendingWait && now() >= pendingWait.deadlineMs))
			return "exhausted";
		return null;
	}

	function triggerStatus(agent) {
		const snap = snapshot();
		const main = isMain(agent);
		const graceSnap = grace.snapshot;
		const remaining =
			graceSnap.phase === "grace" && graceSnap.deadlineMs !== null
				? Math.max(0, graceSnap.deadlineMs - now())
				: null;
		let observableBusyCount = 0;
		for (const candidate of agents?.() ?? []) {
			if (candidate?.status === "running") observableBusyCount += 1;
		}
		return {
			main,
			locked: main ? snap.locked : null,
			attempt: main ? snap.attempt : null,
			maxRetries: config.maxRetries,
			blocker: main ? blockerFor(agent) : "not-main",
			gracePhase: main ? graceSnap.phase : "blocked",
			graceRemainingMs: main ? remaining : null,
			observableBusyCount,
			domainBusyParticipants: null,
		};
	}

	function statusText(agent) {
		return formatWatchdogTriggerStatus(triggerStatus(agent));
	}

	function reconcile() {
		if (disposed) return;
		const agent = mainAgent();
		const snap = snapshot();
		const eligible =
			agent !== undefined &&
			snap.locked &&
			!snap.decisionFailed &&
			decision === null &&
			!anyBusy() &&
			(!snap.exhausted || (pendingWait !== null && now() >= snap.waitUntilMs));
		grace.update({
			generation: epoch,
			allIdle: eligible,
			notBeforeMs: snap.waitUntilMs,
		});
	}

	function freshLock(notify) {
		epoch += 1;
		abortDecision();
		pendingWait = null;
		controller.lock();
		if (notify) toast("Continue watchdog locked");
		reconcile();
	}

	function unlock(kind, reason) {
		epoch += 1;
		abortDecision();
		pendingWait = null;
		controller.unlock();
		grace.invalidate();
		if (kind === "error") {
			toast("Continue watchdog unlocked · run ended in error");
			emitSemanticHook(
				events,
				createUserReadyEnvelope({ STOP_KIND: "ERROR_UNLOCK" }),
			);
		} else if (kind === "abort" || kind === "empty") {
			toast("Continue watchdog unlocked");
		}
		if (reason) {
			/* Human reasoned unlock is command text, not a model message. */
		}
		reconcile();
	}

	function abortDecision() {
		if (decision === null) return;
		decision.controller.abort();
		const id = decision.decisionId;
		decision = null;
		controller.invalidateDecision(id);
	}

	function blocksTools(agent) {
		return decision !== null && isMain(agent);
	}

	async function publish(agent, text, mode) {
		const message = textMessage(createUser, text);
		if (mode === "wake") {
			followup(agent, message);
			return true;
		}
		return appendSilent(agent, message) !== false;
	}

	function rememberWait(decisionResult, acceptedAtMs) {
		const offset = offsets();
		const deadlineMs = acceptedAtMs + decisionResult.waitSeconds * 1000;
		const event = createWaitWatchdogEvent({
			occurredAtMs: acceptedAtMs,
			occurredAtOffsetMinutes: offset,
			reason: decisionResult.reason,
			waitSeconds: decisionResult.waitSeconds,
			deadlineMs,
			deadlineOffsetMinutes: offset,
		});
		pendingWait = {
			waitSeconds: decisionResult.waitSeconds,
			acceptedAtMs,
			acceptedAtOffsetMinutes: offset,
			deadlineMs,
			deadlineOffsetMinutes: offset,
			completed: false,
			event,
		};
		return formatWaitWatchdogEvent(event);
	}

	async function publishCompletedWait(agent, generation) {
		if (pendingWait === null || pendingWait.completed) return null;
		if (now() < pendingWait.deadlineMs) return null;
		const observedAtMs = now();
		const event = createCompletedWaitWatchdogEvent({
			observedAtMs,
			observedAtOffsetMinutes: offsets(),
			waitIdentity: pendingWait.deadlineMs,
			acceptedAtMs: pendingWait.acceptedAtMs,
			acceptedAtOffsetMinutes: pendingWait.acceptedAtOffsetMinutes,
			waitSeconds: pendingWait.waitSeconds,
		});
		const text = formatCompletedWaitWatchdogEvent(event);
		const ok = await publish(agent, text, "silent");
		if (!ok || generation !== epoch) return null;
		pendingWait.completed = true;
		return text;
	}

	async function onFence(generation) {
		const agent = mainAgent();
		if (agent === undefined || generation !== epoch || anyBusy()) return;
		const snap = snapshot();
		if (!snap.locked || snap.decisionFailed || decision !== null) return;
		const completed = await publishCompletedWait(agent, generation);
		if (generation !== epoch) return;
		if (snapshot().exhausted) {
			if (completed !== null) {
				const exhausted = createExhaustedWatchdogEvent({
					occurredAtMs: now(),
					offsetMinutes: offsets(),
				});
				const ok = await publish(
					agent,
					formatExhaustedWatchdogEvent(exhausted),
					"silent",
				);
				if (ok) {
					emitSemanticHook(
						events,
						createUserReadyEnvelope({ STOP_KIND: "EXHAUSTED" }),
					);
				}
			}
			grace.invalidate();
			return;
		}
		if (now() < snapshot().waitUntilMs) {
			reconcile();
			return;
		}
		await runDecision(agent, generation, completed);
	}

	async function runDecision(agent, generation, preamble) {
		const opened = controller.beginDecision(now());
		if (!opened.applied || generation !== epoch) return;
		const decisionId = opened.effects.find(
			(effect) => effect.kind === "openDecisionWindow",
		)?.decisionId;
		const ac = new AbortController();
		decision = { decisionId, controller: ac };
		grace.invalidate();
		let basePrompt = buildDecisionPrompt(
			config.decisionPrompt,
			config.reasonTypes,
			config.continueReasonTypes,
		);
		if (preamble) basePrompt = `${preamble}\n\n${basePrompt}`;
		let prompt = basePrompt;
		try {
			for (;;) {
				if (ac.signal.aborted || generation !== epoch) return;
				let text = "";
				try {
					const history = agent.session?.deriveMessages?.() ?? [];
					text = await streamText({
						agent,
						messages: [
							...history,
							textMessage(createUser, prompt),
						],
						signal: ac.signal,
					});
				} catch {
					text = "";
				}
				if (ac.signal.aborted || generation !== epoch || decision?.decisionId !== decisionId)
					return;
				const verdict = validateDecisionResponse(
					[{ type: "text", text: text ?? "" }],
					config.reasonTypes,
					config.continueReasonTypes,
				);
				if (!verdict.valid) {
					const recorded = controller.recordInvalidDecision(
						decisionId,
						verdict.error,
					);
					if (recorded.effects.some((effect) => effect.kind === "decisionFailed")) {
						const failed = createDecisionFailedWatchdogEvent({
							occurredAtMs: now(),
							offsetMinutes: offsets(),
							error: verdict.error,
						});
						const ok = await publish(
							agent,
							formatDecisionFailedWatchdogEvent(failed),
							"silent",
						);
						if (ok && generation === epoch) {
							toast(formatDecisionFailedNotification(verdict.error));
							emitSemanticHook(
								events,
								createUserReadyEnvelope({ STOP_KIND: "DECISION_FAILED" }),
							);
						}
						decision = null;
						grace.invalidate();
						return;
					}
					prompt = buildDecisionReaskPrompt(basePrompt, verdict.error);
					continue;
				}
				const outcome = verdict.decision;
				if (outcome.kind === "continue") {
					const event = createContinueWatchdogEvent({
						occurredAtMs: now(),
						offsetMinutes: offsets(),
						reasonType: outcome.reasonType,
						reason: outcome.reason,
					});
					const body = formatContinueWatchdogEvent(event, config.continuePrompt);
					let published = false;
					try {
						published = await publish(agent, body, "wake");
					} catch {
						published = false;
					}
					if (!published || generation !== epoch) {
						controller.invalidateDecision(decisionId);
						decision = null;
						reconcile();
						return;
					}
					controller.recordValidContinue(decisionId);
					decision = null;
					emitSemanticHook(
						events,
						createWatchdogContinuedEnvelope({
							REASON_TYPE: outcome.reasonType,
							REASON: outcome.reason,
						}),
					);
					reconcile();
					return;
				}
				if (outcome.kind === "wait") {
					const acceptedAtMs = now();
					const body = rememberWait(outcome, acceptedAtMs);
					const ok = await publish(agent, body, "silent");
					if (!ok || generation !== epoch) {
						pendingWait = null;
						controller.invalidateDecision(decisionId);
						decision = null;
						reconcile();
						return;
					}
					controller.recordValidWait(
						decisionId,
						acceptedAtMs + outcome.waitSeconds * 1000,
					);
					decision = null;
					emitSemanticHook(
						events,
						createWatchdogWaitingEnvelope({
							REASON: outcome.reason,
							WAIT_SECONDS: String(outcome.waitSeconds),
						}),
					);
					reconcile();
					return;
				}
				const event = createUnlockWatchdogEvent({
					occurredAtMs: now(),
					offsetMinutes: offsets(),
					reasonType: outcome.reasonType,
					reason: outcome.reason,
				});
				const ok = await publish(agent, formatUnlockWatchdogEvent(event), "silent");
				if (!ok || generation !== epoch) {
					controller.invalidateDecision(decisionId);
					decision = null;
					reconcile();
					return;
				}
				controller.recordValidUnlock(decisionId);
				decision = null;
				pendingWait = null;
				emitSemanticHook(
					events,
					createUserReadyEnvelope({
						STOP_KIND: "AI_UNLOCK",
						REASON_TYPE: outcome.reasonType,
						REASON: outcome.reason,
					}),
				);
				grace.invalidate();
				return;
			}
		} finally {
			if (decision?.decisionId === decisionId) {
				controller.invalidateDecision(decisionId);
				decision = null;
			}
		}
	}

	return {
		blocksTools,
		statusText,
		triggerStatus,
		snapshot,
		get decisionOpen() {
			return decision !== null;
		},
		noteStatus(agent) {
			if (!isMain(agent)) {
				reconcile();
				return;
			}
			if (agent.status === "running" && !snapshot().locked && decision === null) {
				freshLock(false);
				return;
			}
			reconcile();
		},
		noteUserMessage(agent, sourceKind) {
			if (!isMain(agent) || sourceKind !== "user") return;
			freshLock(false);
		},
		noteTurnEnd(agent, reasonKind) {
			if (!isMain(agent)) return;
			if (reasonKind === "aborted") {
				if (suppressAbortUnlock) {
					suppressAbortUnlock = false;
					reconcile();
					return;
				}
				if (snapshot().locked) unlock("abort");
				return;
			}
			if (reasonKind === "error") {
				if (snapshot().locked) unlock("error");
				return;
			}
			reconcile();
		},
		commandLock(agent) {
			if (!isMain(agent)) return { kind: "error", text: "Not the main agent." };
			freshLock(true);
			return { kind: "success", text: "Continue watchdog locked" };
		},
		commandUnlock(agent, rawInput) {
			if (!isMain(agent)) return { kind: "error", text: "Not the main agent." };
			const reason = truncateHumanReason(rawInput ?? "");
			if (agent.status === "running") {
				suppressAbortUnlock = true;
				try {
					cancelAgent(agent);
				} catch {
					/* cancel is best-effort */
				}
			}
			unlock(reason ? "human" : "empty");
			if (!reason) return { kind: "success", text: "Continue watchdog unlocked" };
			return {
				kind: "success",
				text: `Continue watchdog unlocked · ${reason}`,
			};
		},
		commandStatus(agent) {
			return { kind: "success", text: statusText(agent) };
		},
		reconcile,
		dispose() {
			disposed = true;
			abortDecision();
			grace.dispose();
		},
	};
}

export { TOOL_DENY_REASON, SOURCE_KIND };
