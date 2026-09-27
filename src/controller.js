// Port of pi-continue-watchdog/src/controller.ts (BSD-3-Clause, xz-dev).
// Pure lock and decision-window state machine. Runtime wiring owns activity
// generations, grace timers, DSH hooks, and notifications; this controller
// owns only lock and decision accounting. Behavior-verbatim.

const INVALID_DECISION_LIMIT = 3;
const GENERIC_INVALID_DECISION_ERROR = "Invalid decision.";

function snapshotOf(state) {
	return {
		locked: state.locked,
		attempt: state.attempt,
		exhausted: state.exhausted,
		decisionFailed: state.decisionFailed,
		invalidDecisionAttempts: state.invalidDecisionAttempts,
		lastInvalidDecisionError: state.lastInvalidDecisionError,
		decisionOpen: state.decisionOpen,
		waitUntilMs: state.waitUntilMs,
	};
}

function normaliseInvalidDecisionError(error) {
	return typeof error === "string" && error.length > 0
		? error
		: GENERIC_INVALID_DECISION_ERROR;
}

function initialState() {
	return {
		locked: false,
		attempt: 0,
		exhausted: false,
		decisionFailed: false,
		invalidDecisionAttempts: 0,
		lastInvalidDecisionError: null,
		decisionOpen: false,
		decisionId: null,
		waitUntilMs: 0,
	};
}

class PureLockDecisionController {
	#state = initialState();
	#nextDecisionId = 1;
	#maxRetries;

	constructor(config) {
		this.#maxRetries = config.maxRetries;
	}

	get snapshot() {
		return snapshotOf(this.#state);
	}

	lock() {
		const effects = this.#clearPendingIntents();
		this.#state = { ...initialState(), locked: true };
		effects.push({ kind: "notify", notification: "locked" });
		return this.#applied(effects);
	}

	/** Unlocked => fresh lock; locked => strict no-op. */
	ensureLocked() {
		return this.#state.locked ? this.#noop() : this.lock();
	}

	/**
	 * Assign locked=false, clear a pending decision, and notify. Attempt,
	 * exhaustion, decisionFailed, and invalid counters remain visible.
	 */
	unlock() {
		const effects = this.#clearPendingIntents();
		this.#state = {
			...this.#state,
			locked: false,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		effects.push({ kind: "notify", notification: "unlocked" });
		return this.#applied(effects);
	}

	onMainUserMessageStart() {
		return this.lock();
	}

	beginDecision(nowMs) {
		if (!this.#isDecisionEligible(nowMs)) return this.#noop();
		const decisionId = this.#nextDecisionId++;
		this.#state = {
			...this.#state,
			decisionOpen: true,
			decisionId,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
		};
		return this.#applied([
			{
				kind: "openDecisionWindow",
				decisionId,
				attempt: this.#state.attempt,
			},
		]);
	}

	recordInvalidDecision(decisionId, error) {
		if (!this.#isCurrentDecision(decisionId)) return this.#noop();
		const normalisedError = normaliseInvalidDecisionError(error);
		const invalidDecisionAttempts = this.#state.invalidDecisionAttempts + 1;
		if (invalidDecisionAttempts < INVALID_DECISION_LIMIT) {
			this.#state = {
				...this.#state,
				invalidDecisionAttempts,
				lastInvalidDecisionError: normalisedError,
			};
			return this.#applied([
				{
					kind: "reaskDecision",
					decisionId,
					invalidDecisionAttempt: invalidDecisionAttempts,
					error: normalisedError,
				},
			]);
		}

		this.#state = {
			...this.#state,
			decisionOpen: false,
			decisionId: null,
			decisionFailed: true,
			invalidDecisionAttempts: INVALID_DECISION_LIMIT,
			lastInvalidDecisionError: normalisedError,
		};
		return this.#applied([
			{ kind: "restoreDecisionTools", decisionId },
			{ kind: "decisionFailed", error: normalisedError },
		]);
	}

	recordValidContinue(decisionId) {
		if (!this.#isCurrentDecision(decisionId)) return this.#noop();
		const attempt = this.#state.attempt + 1;
		this.#state = {
			...this.#state,
			attempt,
			exhausted: attempt >= this.#maxRetries,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		return this.#applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	recordValidWait(decisionId, waitUntilMs) {
		if (
			!this.#isCurrentDecision(decisionId) ||
			!Number.isSafeInteger(waitUntilMs) ||
			waitUntilMs < 0
		) {
			return this.#noop();
		}
		const attempt = this.#state.attempt + 1;
		this.#state = {
			...this.#state,
			attempt,
			exhausted: attempt >= this.#maxRetries,
			invalidDecisionAttempts: 0,
			lastInvalidDecisionError: null,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs,
		};
		return this.#applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	/** Close a stale decision without consuming attempts or unlocking. */
	invalidateDecision(decisionId) {
		if (!this.#isCurrentDecision(decisionId)) return this.#noop();
		this.#state = {
			...this.#state,
			decisionOpen: false,
			decisionId: null,
		};
		return this.#applied([{ kind: "restoreDecisionTools", decisionId }]);
	}

	recordValidUnlock(decisionId) {
		if (!this.#isCurrentDecision(decisionId)) return this.#noop();
		this.#state = {
			...this.#state,
			locked: false,
			decisionOpen: false,
			decisionId: null,
			waitUntilMs: 0,
		};
		return this.#applied([
			{ kind: "restoreDecisionTools", decisionId },
			{ kind: "notify", notification: "unlocked" },
		]);
	}

	#isDecisionEligible(nowMs) {
		return (
			Number.isFinite(nowMs) &&
			this.#state.locked &&
			!this.#state.exhausted &&
			!this.#state.decisionFailed &&
			!this.#state.decisionOpen &&
			nowMs >= this.#state.waitUntilMs
		);
	}

	#isCurrentDecision(decisionId) {
		return this.#state.decisionOpen && this.#state.decisionId === decisionId;
	}

	#clearPendingIntents() {
		return this.#state.decisionOpen && this.#state.decisionId !== null
			? [
					{
						kind: "restoreDecisionTools",
						decisionId: this.#state.decisionId,
					},
				]
			: [];
	}

	#applied(effects) {
		return { applied: true, snapshot: this.snapshot, effects: [...effects] };
	}

	#noop() {
		return { applied: false, snapshot: this.snapshot, effects: [] };
	}
}

/** Construct an in-memory controller from already validated runtime config. */
export function createLockDecisionController(config) {
	return new PureLockDecisionController({ maxRetries: config.maxRetries });
}
