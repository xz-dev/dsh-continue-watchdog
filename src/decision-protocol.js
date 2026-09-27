// Port of pi-continue-watchdog/src/decision-protocol.ts (BSD-3-Clause, xz-dev).
// XML decision protocol: prompt construction, response normalization,
// validation. The Pi collector/session machinery (cycle ids, pre-commit
// fencing) is replaced by the DSH runtime's single in-flight decision call;
// validation rules, limits, and prompt text are behavior-verbatim.

import {
	buildXmlDocument,
	extractTrailingXml,
	parseTrailingXml,
} from "./xml.js";

/** The fixed re-ask budget is owned by the controller, not configuration. */
export const DECISION_INVALID_ATTEMPT_LIMIT = 3;

export const MAX_REASON_CHARACTERS = 1000;
export const REASON_GUIDANCE_CHARACTERS = MAX_REASON_CHARACTERS / 2;

export const INVALID_DECISION_XML_ERROR =
	"Your entire response must be exactly one valid watchdog XML decision document.";
export const INVALID_CONTINUE_REASON_TYPE_ERROR =
	"continue_watchdog requires an allowed reason_type.";
export const INVALID_CONTINUE_REASON_ERROR = `continue_watchdog requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const MISSING_CONTINUE_FIELDS_ERROR =
	"continue_watchdog requires reason_type and reason_content.";
export const INVALID_WAIT_REASON_ERROR = `wait_watchdog requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const INVALID_WAIT_SECONDS_ERROR =
	"wait_watchdog requires an integer wait_seconds from 1 through 1800.";
export const MISSING_WAIT_FIELDS_ERROR =
	"wait_watchdog requires reason_content and wait_seconds.";
export const INVALID_WAIT_REASON_TYPE_ERROR =
	"wait_watchdog does not use reason_type; use reason_content and wait_seconds only.";
export const INVALID_UNLOCK_REASON_TYPE_ERROR =
	"unlock_continue_watchdog requires an allowed reason_type.";
export const INVALID_UNLOCK_REASON_ERROR = `unlock_continue_watchdog requires a non-empty reason_content of at most ${MAX_REASON_CHARACTERS} Unicode characters.`;
export const MISSING_UNLOCK_FIELDS_ERROR =
	"unlock_continue_watchdog requires reason_type and reason_content.";
export const UNSUPPORTED_DECISION_CONTENT_ERROR =
	"The decision response contains unsupported content. Your entire response must be the one watchdog XML document.";
export const MALFORMED_DECISION_RESPONSE_ERROR =
	"The decision response was malformed. Your entire response must be the one watchdog XML document.";

export const MIN_WAIT_SECONDS = 1;
export const MAX_WAIT_SECONDS = 30 * 60;

export function normalizeDecisionUnlockReasonType(reasonType, reasonTypes) {
	if (typeof reasonType !== "string") return null;
	const trimmed = reasonType.trim();
	if (trimmed.length === 0) return null;
	const needle = trimmed.toLowerCase();
	for (const entry of reasonTypes) {
		if (entry.toLowerCase() === needle) {
			return entry.toUpperCase();
		}
	}
	return null;
}

export function normalizeDecisionUnlockReason(reason) {
	if (typeof reason !== "string") return null;
	const trimmed = reason.trim();
	if (
		trimmed.length === 0 ||
		Array.from(trimmed).length > MAX_REASON_CHARACTERS
	)
		return null;
	return trimmed;
}

export function normalizeWaitSeconds(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return null;
	const seconds = Number(trimmed);
	return Number.isSafeInteger(seconds) && seconds <= MAX_WAIT_SECONDS
		? seconds
		: null;
}

/**
 * Append the parser-critical XML contract to the configurable decision intent.
 * Behavior-verbatim port of the Pi builder.
 */
export function buildDecisionPrompt(
	decisionPrompt,
	reasonTypes,
	continueReasonTypes,
) {
	const allowedReasonTypes = JSON.stringify(reasonTypes);
	const allowedContinueReasonTypes = JSON.stringify(continueReasonTypes);
	const configuredReasonType = (builtIn) => {
		const match = reasonTypes.find(
			(reasonType) => reasonType.toLowerCase() === builtIn.toLowerCase(),
		);
		return match === undefined ? null : match.toUpperCase();
	};
	const waitUserType = configuredReasonType("WAIT_USER");
	const jobDoneType = configuredReasonType("JOB_DONE");
	const jobBlockedType = configuredReasonType("JOB_BLOCKED");
	const waitUserGuidance =
		waitUserType === null
			? "choose the allowed reason_type value that represents required user action"
			: `the default reason_type is ${waitUserType}`;
	const jobDoneGuidance =
		jobDoneType === null
			? "choose the allowed reason_type value that represents completed work"
			: `the default reason_type is ${jobDoneType}`;
	const jobBlockedGuidance =
		jobBlockedType === null
			? "choose the allowed reason_type value that represents a non-user blocker"
			: `the default reason_type is ${jobBlockedType}`;
	const continueExample = buildXmlDocument("watchdog", [
		{ name: "function", value: "continue_watchdog" },
		{ name: "reason_type", value: continueReasonTypes[0] ?? "ALLOWED_TYPE" },
		{ name: "reason_content", value: "concise reason" },
	]);
	const waitExample = buildXmlDocument("watchdog", [
		{ name: "function", value: "wait_watchdog" },
		{ name: "reason_content", value: "Waiting for automation." },
		{ name: "wait_seconds", value: "300" },
	]);
	const unlockExample = buildXmlDocument("watchdog", [
		{ name: "function", value: "unlock_continue_watchdog" },
		{ name: "reason_type", value: reasonTypes[0] ?? "ALLOWED_TYPE" },
		{ name: "reason_content", value: "concise reason" },
	]);
	return `${decisionPrompt}

Use only the existing conversation context and decide quickly. Do not make decisions on the user's behalf. Do not call tools. Your entire response must be exactly one <watchdog>...</watchdog> XML document, with no text before or after it; express your reasoning inside the fields, above all reason_content. reason_content must be non-empty and at most ${REASON_GUIDANCE_CHARACTERS} Unicode characters. Do not output multiple <watchdog>...</watchdog> blocks.

First reconcile the user's outstanding requests with the latest ordinary assistant response and relevant tool results. Exclude work already delivered, cancelled, or superseded; preserve genuinely unfinished earlier requests. Earlier plans and watchdog reasons are not proof that work remains. A final response or stop marker alone is not proof of completion: compare actual deliverables with the requests. Before claiming that the user has not been answered, check whether the latest ordinary assistant response already answers the question. For continue, identify the specific missing deliverable and an authorized next action; do not repeat an already-delivered answer or invent optional follow-up work.

Use these decision labels:
- STOP: decide to stop here or pause for user action; use unlock_continue_watchdog.
- LOCK: decide work can continue immediately; use continue_watchdog.
- WAIT: pause only for temporary external automation or elapsed time, with no user action required; use wait_watchdog.

Compare requests with actual delivery
|
+-- Complete --> STOP (${jobDoneType ?? "allowed completion type"})
+-- Incomplete, authorized action executable now --> LOCK
+-- No executable action, needs user --> STOP (${waitUserType ?? "allowed user-action type"})
+-- No executable action, waiting for automation --> WAIT
+-- Other blocker --> STOP (${jobBlockedType ?? "allowed blocker type"})

Choose the outcome using these rules in order:
1. If all requested work is complete, choose STOP by using unlock_continue_watchdog. For reason_type, ${jobDoneGuidance}.
2. Choose LOCK by using continue_watchdog only if at least one concrete requested and authorized next action can be performed immediately for a still-incomplete deliverable without additional user input or approval. reason_content must name that immediately executable action, not a user-blocked action. Unfinished work alone is not sufficient reason to continue.
3. If no concrete next action can proceed without additional user input, approval, confirmation, authorization, credentials, or another user action, choose STOP by using unlock_continue_watchdog. For reason_type, ${waitUserGuidance}.
4. If no authorized action can be performed now and progress only requires temporary external automation or elapsed time and no user action is required, choose WAIT by using wait_watchdog.
5. Otherwise, if work cannot proceed for a blocker that is neither user action nor a temporary external wait, choose STOP by using unlock_continue_watchdog. For reason_type, ${jobBlockedGuidance}.

If you choose continue_watchdog, reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedContinueReasonTypes}. Use:
${continueExample}

If you choose unlock_continue_watchdog, reason_type must exactly match one of this JSON list (case-insensitive after trimming): ${allowedReasonTypes}. Use:
${unlockExample}

If you choose wait_watchdog, use a non-empty reason_content and an integer wait_seconds from ${MIN_WAIT_SECONDS} through ${MAX_WAIT_SECONDS}. Use:
${waitExample}`;
}

export function extractTrailingWatchdogXml(fullNonThinkingAssistantText) {
	return extractTrailingXml(fullNonThinkingAssistantText, "watchdog");
}

export function parseWatchdogDecisionXml(raw) {
	const parsed = parseTrailingXml(raw, "watchdog");
	if (!parsed.valid) return { ok: false };
	const functionName = parsed.value.fields.get("function");
	if (functionName === undefined) return { ok: false };
	return {
		ok: true,
		fields: {
			functionName,
			reasonType: parsed.value.fields.get("reason_type"),
			reasonContent: parsed.value.fields.get("reason_content"),
			waitSeconds: parsed.value.fields.get("wait_seconds"),
		},
	};
}

function validateParsedFields(fields, reasonTypes, continueReasonTypes) {
	if (fields.functionName.trim().toLowerCase() === "continue_watchdog") {
		if (fields.reasonType === undefined || fields.reasonContent === undefined) {
			return { valid: false, error: MISSING_CONTINUE_FIELDS_ERROR };
		}
		const normalizedType = normalizeDecisionUnlockReasonType(
			fields.reasonType,
			continueReasonTypes,
		);
		if (normalizedType === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_TYPE_ERROR };
		}
		const normalizedReason = normalizeDecisionUnlockReason(
			fields.reasonContent,
		);
		if (normalizedReason === null) {
			return { valid: false, error: INVALID_CONTINUE_REASON_ERROR };
		}
		return {
			valid: true,
			decision: {
				kind: "continue",
				reasonType: normalizedType,
				reason: normalizedReason,
			},
		};
	}
	if (fields.functionName.trim().toLowerCase() === "wait_watchdog") {
		if (
			fields.reasonContent === undefined ||
			fields.waitSeconds === undefined
		) {
			return { valid: false, error: MISSING_WAIT_FIELDS_ERROR };
		}
		if (fields.reasonType !== undefined) {
			return { valid: false, error: INVALID_WAIT_REASON_TYPE_ERROR };
		}
		const normalizedReason = normalizeDecisionUnlockReason(
			fields.reasonContent,
		);
		if (normalizedReason === null) {
			return { valid: false, error: INVALID_WAIT_REASON_ERROR };
		}
		const waitSeconds = normalizeWaitSeconds(fields.waitSeconds);
		if (waitSeconds === null) {
			return { valid: false, error: INVALID_WAIT_SECONDS_ERROR };
		}
		return {
			valid: true,
			decision: {
				kind: "wait",
				reason: normalizedReason,
				waitSeconds,
			},
		};
	}
	if (fields.functionName.trim().toLowerCase() !== "unlock_continue_watchdog") {
		return { valid: false, error: INVALID_DECISION_XML_ERROR };
	}
	if (fields.reasonType === undefined || fields.reasonContent === undefined) {
		return { valid: false, error: MISSING_UNLOCK_FIELDS_ERROR };
	}
	const normalizedType = normalizeDecisionUnlockReasonType(
		fields.reasonType,
		reasonTypes,
	);
	if (normalizedType === null) {
		return { valid: false, error: INVALID_UNLOCK_REASON_TYPE_ERROR };
	}
	const normalizedReason = normalizeDecisionUnlockReason(fields.reasonContent);
	if (normalizedReason === null) {
		return { valid: false, error: INVALID_UNLOCK_REASON_ERROR };
	}
	return {
		valid: true,
		decision: {
			kind: "unlock",
			reasonType: normalizedType,
			reason: normalizedReason,
		},
	};
}

/**
 * Apply the XML decision protocol to one completed DSH assistant content
 * block list. Text blocks join; thinking blocks are ignored; tool calls and
 * unknown blocks fail validation exactly like Pi.
 */
export function validateDecisionResponse(content, reasonTypes, continueReasonTypes) {
	if (!Array.isArray(content)) {
		return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
	}

	const textParts = [];
	for (const block of content) {
		if (block === undefined || block === null) {
			return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
		}
		if (block.type === "thinking") continue;
		if (block.type === "tool-call" || block.type === "toolCall") continue;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
			continue;
		}
		if (block.type === "text") {
			return { valid: false, error: MALFORMED_DECISION_RESPONSE_ERROR };
		}
		return { valid: false, error: UNSUPPORTED_DECISION_CONTENT_ERROR };
	}

	const parsed = parseWatchdogDecisionXml(textParts.join(""));
	if (!parsed.ok) {
		return { valid: false, error: INVALID_DECISION_XML_ERROR };
	}
	return validateParsedFields(parsed.fields, reasonTypes, continueReasonTypes);
}

/** Build the immediate re-ask body from a safe fixed validator error. */
export function buildDecisionReaskPrompt(decisionPrompt, error) {
	return `${decisionPrompt}

Your previous decision response was invalid: ${error}
Correct it now without calling tools. Your entire response must be exactly one valid <watchdog> XML document with no text before or after it.`;
}

export function formatDecisionFailedNotification(error) {
	return `Continue watchdog decision failed after ${DECISION_INVALID_ATTEMPT_LIMIT} attempts: ${error}`;
}
