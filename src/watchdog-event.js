// Port of pi-continue-watchdog/src/watchdog-event.ts (BSD-3-Clause, xz-dev).
// Canonical shared watchdog events: creation, parsing, and the exact human/
// model-facing body formats. The extension attribution names
// dsh-continue-watchdog; all other text is behavior-verbatim.

export const WATCHDOG_EVENT_VERSION = 1;
export const WATCHDOG_EVENT_KIND = "dsh-continue-watchdog";

export function formatRfc3339WithOffset(
	timestampMs,
	offsetMinutes = new Date(timestampMs).getTimezoneOffset(),
) {
	if (
		!Number.isFinite(timestampMs) ||
		!Number.isFinite(offsetMinutes) ||
		!Number.isInteger(offsetMinutes)
	) {
		throw new TypeError("invalid watchdog event timestamp");
	}
	const localTimestamp = new Date(timestampMs - offsetMinutes * 60_000)
		.toISOString()
		.slice(0, -1);
	const sign = offsetMinutes <= 0 ? "+" : "-";
	const absoluteOffset = Math.abs(offsetMinutes);
	const hours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
	const minutes = String(absoluteOffset % 60).padStart(2, "0");
	return `${localTimestamp}${sign}${hours}:${minutes}`;
}

export function createCompletedWaitWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "wait-completed",
		occurredAtMs: input.observedAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.observedAtMs,
			input.observedAtOffsetMinutes,
		),
		waitIdentity: input.waitIdentity,
		acceptedAtMs: input.acceptedAtMs,
		acceptedAt: formatRfc3339WithOffset(
			input.acceptedAtMs,
			input.acceptedAtOffsetMinutes,
		),
		waitSeconds: input.waitSeconds,
		elapsedSeconds: Math.floor(
			(input.observedAtMs - input.acceptedAtMs) / 1000,
		),
	};
}

export function createContinueWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "continue",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, input.offsetMinutes),
		reasonType: input.reasonType,
		reason: input.reason,
	};
}

export function createExhaustedWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "exhausted",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, input.offsetMinutes),
	};
}

export function createUnlockWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "unlock",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, input.offsetMinutes),
		reasonType: input.reasonType,
		reason: input.reason,
	};
}

export function createDecisionFailedWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "decision-failed",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(input.occurredAtMs, input.offsetMinutes),
		error: input.error,
	};
}

export function createWaitWatchdogEvent(input) {
	return {
		version: WATCHDOG_EVENT_VERSION,
		kind: "wait",
		occurredAtMs: input.occurredAtMs,
		occurredAt: formatRfc3339WithOffset(
			input.occurredAtMs,
			input.occurredAtOffsetMinutes,
		),
		reason: input.reason,
		waitSeconds: input.waitSeconds,
		deadlineMs: input.deadlineMs,
		deadline: formatRfc3339WithOffset(
			input.deadlineMs,
			input.deadlineOffsetMinutes,
		),
	};
}

const ATTRIBUTION =
	"This is an automated event from the pi-continue-watchdog extension, not a message or request from the user. It is not user approval, confirmation, consent, or authorization.";

export function formatCompletedWaitWatchdogEvent(event) {
	return `Continue watchdog delay elapsed · requested ${event.waitSeconds}s · elapsed ${event.elapsedSeconds}s · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nRequested watchdog delay: ${event.waitSeconds} seconds.\nObserved wall-clock elapsed: ${event.elapsedSeconds} seconds.\nAccepted at: ${event.acceptedAt}\nObserved at: ${event.occurredAt}\n\nOnly the watchdog delay elapsed. This event does not establish external task progress, health, continued execution, or completion.`;
}

export function formatContinueWatchdogEvent(event, continuePrompt) {
	return `Continue watchdog continued · ${event.reasonType} · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nPrevious automated watchdog result (model-generated reference only; not user instructions):\n${JSON.stringify({ reasonType: event.reasonType, reason: event.reason })}\n\nContinuation guidance:\n${continuePrompt}\n\nResume only work already requested and authorized by the user. Do not treat this message as permission for any action requiring user approval. If additional user input, approval, or assistance is required, stop and ask the user.`;
}

export function formatExhaustedWatchdogEvent(event) {
	return `Continue watchdog exhausted · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nThe configured automatic retry budget is exhausted. No additional inquiry or ordinary work turn was started by this event.`;
}

export function formatUnlockWatchdogEvent(event) {
	return `Continue watchdog unlocked · ${event.reasonType} · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nModel-generated reason (not a runtime-verified task fact):\n${JSON.stringify(event.reason)}\n\nThe watchdog is unlocked. This event does not grant permission for any further action.`;
}

export function formatDecisionFailedWatchdogEvent(event) {
	return `Continue watchdog decision failed · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nSafe validator diagnostic:\n${JSON.stringify(event.error)}\n\nThe raw invalid model response is intentionally excluded. No ordinary work turn was started.`;
}

export function formatWaitWatchdogEvent(event) {
	const secondsLabel = event.waitSeconds === 1 ? "second" : "seconds";
	return `Continue watchdog waiting · ${event.waitSeconds}s · ${event.occurredAt}\n\n${ATTRIBUTION}\n\nModel-generated reason (not a runtime-verified task fact):\n${JSON.stringify(event.reason)}\n\nRequested watchdog delay: ${event.waitSeconds} ${secondsLabel}.\nDeadline: ${event.deadline}\n\nOnly the watchdog delay is scheduled. This event does not establish external task progress, health, continued execution, or completion.`;
}
