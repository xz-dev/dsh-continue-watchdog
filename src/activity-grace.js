// Port of pi-continue-watchdog/src/activity-grace.ts (BSD-3-Clause, xz-dev).
// Idle grace fence: every automatic inquiry waits one complete fixed 10s
// fence after aggregate idle is observed, never before a pending wait's
// deadline.

/** Product invariant: every automatic inquiry waits one complete fixed fence. */
export const INQUIRY_FENCE_MS = 10_000;

const nodeClock = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle),
	now: () => Date.now(),
};

export function createActivityGraceCoordinator(options) {
	const clock = options.clock ?? nodeClock;
	let phase = "blocked";
	let generation = null;
	let deadlineMs = null;
	let timer = null;
	let token = 0;
	let disposed = false;

	const clearTimer = () => {
		if (timer !== null) clock.clearTimeout(timer);
		timer = null;
	};

	return {
		get snapshot() {
			return { phase, generation, deadlineMs };
		},
		update(input) {
			if (disposed) return;
			const capturedToken = ++token;
			clearTimer();
			generation = input.generation;
			if (!input.allIdle) {
				phase = "blocked";
				deadlineMs = null;
				return;
			}

			phase = "grace";
			const startedAtMs = clock.now();
			const notBeforeMs = Number.isFinite(input.notBeforeMs)
				? (input.notBeforeMs ?? 0)
				: 0;
			const targetDeadlineMs = Math.max(
				startedAtMs + INQUIRY_FENCE_MS,
				notBeforeMs,
			);
			deadlineMs = targetDeadlineMs;
			const delayMs = Math.max(0, Math.ceil(targetDeadlineMs - startedAtMs));
			const handle = clock.setTimeout(() => {
				if (
					disposed ||
					capturedToken !== token ||
					phase !== "grace" ||
					generation !== input.generation
				) {
					return;
				}
				timer = null;
				phase = "ready";
				deadlineMs = null;
				options.onReady(input.generation);
			}, delayMs);
			timer = handle;
			if (handle !== null && typeof handle === "object" && "unref" in handle && typeof handle.unref === "function") {
				handle.unref();
			}
		},
		invalidate() {
			if (disposed) return;
			token += 1;
			clearTimer();
			phase = "blocked";
			deadlineMs = null;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			token += 1;
			clearTimer();
			phase = "blocked";
			generation = null;
			deadlineMs = null;
		},
	};
}
