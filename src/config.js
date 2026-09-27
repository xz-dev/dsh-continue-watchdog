// Port of pi-continue-watchdog/src/config.ts (BSD-3-Clause, xz-dev).
// Built-in defaults, validation, and field-level merge.
// Precedence: builtins < global < trusted project < dsh row config.
// Invalid higher-precedence values do not erase valid lower-precedence values.

export const DEFAULT_DECISION_PROMPT =
	"This is an automated continuation check from the pi-continue-watchdog extension, not a message or request from the user. It does not represent any decision by the user. Decide whether work should continue. Before deciding, check whether every task the user requested in this session is complete, including earlier requests and not only the latest one.";

export const DEFAULT_CONTINUE_PROMPT =
	"Continue until user assistance is required.";

export const DEFAULT_REASON_TYPES = Object.freeze([
	"JOB_DONE",
	"WAIT_USER",
	"JOB_BLOCKED",
]);

export const DEFAULT_CONTINUE_REASON_TYPES = Object.freeze([
	"WORK_REMAINS",
	"VERIFYING",
]);

export const MAX_PROMPT_CHARACTERS = 16_384;
export const MIN_IDLE_DELAY_SECONDS = 0;
export const MIN_RETRIES = 1;
export const MAX_RETRIES = 10;

export const BUILT_IN_CONFIG = Object.freeze({
	idleDelaySeconds: 10,
	maxRetries: 10,
	decisionPrompt: DEFAULT_DECISION_PROMPT,
	continuePrompt: DEFAULT_CONTINUE_PROMPT,
	reasonTypes: DEFAULT_REASON_TYPES,
	continueReasonTypes: DEFAULT_CONTINUE_REASON_TYPES,
	unlockShortcut: "alt+u",
});

const MAX_DIAGNOSTIC_LENGTH = 240;

const KNOWN_KEYS = new Set([
	"idleDelaySeconds",
	"maxRetries",
	"decisionPrompt",
	"continuePrompt",
	"reasonTypes",
	"continueReasonTypes",
	"unlockShortcut",
]);

function diagnostic(source, message) {
	return { source, message: message.slice(0, MAX_DIAGNOSTIC_LENGTH) };
}

function copyBuiltIn() {
	return {
		idleDelaySeconds: BUILT_IN_CONFIG.idleDelaySeconds,
		maxRetries: BUILT_IN_CONFIG.maxRetries,
		decisionPrompt: BUILT_IN_CONFIG.decisionPrompt,
		continuePrompt: BUILT_IN_CONFIG.continuePrompt,
		reasonTypes: [...BUILT_IN_CONFIG.reasonTypes],
		continueReasonTypes: [...BUILT_IN_CONFIG.continueReasonTypes],
		unlockShortcut: BUILT_IN_CONFIG.unlockShortcut,
	};
}

function validIdleDelaySeconds(value) {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_IDLE_DELAY_SECONDS
	);
}

function validMaxRetries(value) {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= MIN_RETRIES &&
		value <= MAX_RETRIES
	);
}

export function normalizeReasonTypes(value) {
	if (!Array.isArray(value) || value.length === 0) return null;
	const normalized = [];
	for (const entry of value) {
		if (typeof entry !== "string") return null;
		const trimmed = entry.trim();
		if (trimmed.length === 0) return null;
		normalized.push(trimmed);
	}
	return normalized;
}

export function hasAtMostUnicodeCodePoints(value, maximum) {
	let codePoints = 0;
	for (let index = 0; index < value.length; codePoints += 1) {
		if (codePoints >= maximum) return false;
		const first = value.charCodeAt(index);
		const second = value.charCodeAt(index + 1);
		index +=
			first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff
				? 2
				: 1;
	}
	return true;
}

export function isValidPrompt(value) {
	return (
		typeof value === "string" &&
		hasAtMostUnicodeCodePoints(value, MAX_PROMPT_CHARACTERS) &&
		value.trim().length > 0
	);
}

export function validateConfig(source, value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return {
			config: {},
			diagnostics: [diagnostic(source, "configuration must be an object")],
		};
	}

	const input = value;
	const config = {};
	const diagnostics = [];

	if (Object.hasOwn(input, "idleDelaySeconds")) {
		const idle = input.idleDelaySeconds;
		if (validIdleDelaySeconds(idle)) {
			config.idleDelaySeconds = idle;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"idleDelaySeconds must be a finite number greater than or equal to 0",
				),
			);
		}
	}

	if (Object.hasOwn(input, "maxRetries")) {
		const retries = input.maxRetries;
		if (validMaxRetries(retries)) {
			config.maxRetries = retries;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"maxRetries must be a safe integer between 1 and 10",
				),
			);
		}
	}

	if (Object.hasOwn(input, "decisionPrompt")) {
		const decision = input.decisionPrompt;
		if (isValidPrompt(decision)) {
			config.decisionPrompt = decision;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`decisionPrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	if (Object.hasOwn(input, "continuePrompt")) {
		const cont = input.continuePrompt;
		if (isValidPrompt(cont)) {
			config.continuePrompt = cont;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`continuePrompt must be a non-empty string of at most ${MAX_PROMPT_CHARACTERS} Unicode characters`,
				),
			);
		}
	}

	for (const key of ["reasonTypes", "continueReasonTypes"]) {
		if (!Object.hasOwn(input, key)) continue;
		const reasonTypes = normalizeReasonTypes(input[key]);
		if (reasonTypes !== null) {
			config[key] = reasonTypes;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					`${key} must be a non-empty array of non-blank strings`,
				),
			);
		}
	}

	if (Object.hasOwn(input, "unlockShortcut")) {
		const shortcut = input.unlockShortcut;
		if (
			shortcut === false ||
			(typeof shortcut === "string" && shortcut.trim().length > 0)
		) {
			config.unlockShortcut = shortcut;
		} else {
			diagnostics.push(
				diagnostic(
					source,
					"unlockShortcut must be a non-empty key id string or false",
				),
			);
		}
	}

	for (const key of Object.keys(input)) {
		if (!KNOWN_KEYS.has(key)) {
			diagnostics.push(diagnostic(source, "ignoring unsupported keys"));
			break;
		}
	}

	return { config, diagnostics };
}

export function loadConfigText(source, text) {
	try {
		return validateConfig(source, JSON.parse(text));
	} catch {
		return {
			config: {},
			diagnostics: [
				diagnostic(source, "configuration contains malformed JSON"),
			],
		};
	}
}

/**
 * Pi merge: builtins < global < project. The DSH row config is applied as an
 * additional highest-precedence layer by the caller via mergeRow().
 */
export function mergeConfig(global, project) {
	const layers = [
		validateConfig("global", global ?? {}),
		validateConfig("project", project ?? {}),
	];

	const config = copyBuiltIn();
	for (const { config: partial } of layers) {
		applyPartial(config, partial);
	}

	return {
		config,
		diagnostics: layers.flatMap((layer) => layer.diagnostics),
	};
}

function applyPartial(config, partial) {
	if (partial.idleDelaySeconds !== undefined) {
		config.idleDelaySeconds = partial.idleDelaySeconds;
	}
	if (partial.maxRetries !== undefined) {
		config.maxRetries = partial.maxRetries;
	}
	if (partial.decisionPrompt !== undefined) {
		config.decisionPrompt = partial.decisionPrompt;
	}
	if (partial.continuePrompt !== undefined) {
		config.continuePrompt = partial.continuePrompt;
	}
	if (partial.reasonTypes !== undefined) {
		config.reasonTypes = [...partial.reasonTypes];
	}
	if (partial.continueReasonTypes !== undefined) {
		config.continueReasonTypes = [...partial.continueReasonTypes];
	}
	if (partial.unlockShortcut !== undefined) {
		config.unlockShortcut = partial.unlockShortcut;
	}
}

/**
 * Apply the DSH cordis row config (already validated by the schemastery
 * schema) as the top layer, with Pi field-level diagnostics semantics.
 */
export function mergeRow(config, row) {
	const { config: partial, diagnostics } = validateConfig("dsh", row ?? {});
	applyPartial(config, partial);
	return { config, diagnostics };
}
