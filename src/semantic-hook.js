// Port of pi-continue-watchdog/src/semantic-hook.ts (BSD-3-Clause, xz-dev).
// Same channel and envelope pi-notify / dsh-notify already consume.

export const SEMANTIC_HOOK_CHANNEL = "pi:semantic-hook:v1";
export const USER_READY_HOOK_NAME = "user-ready";
export const WATCHDOG_WAITING_HOOK_NAME = "watchdog-waiting";
export const WATCHDOG_CONTINUED_HOOK_NAME = "watchdog-continued";

function freezeValues(values) {
	const frozen = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) frozen[key] = value;
	}
	return Object.freeze(frozen);
}

export function createUserReadyEnvelope(values) {
	return Object.freeze({
		version: 1,
		name: USER_READY_HOOK_NAME,
		values: freezeValues({
			STOP_KIND: values.STOP_KIND,
			REASON_TYPE: values.REASON_TYPE,
			REASON: values.REASON,
		}),
	});
}

export function createWatchdogWaitingEnvelope(values) {
	return Object.freeze({
		version: 1,
		name: WATCHDOG_WAITING_HOOK_NAME,
		values: freezeValues({
			REASON: values.REASON,
			WAIT_SECONDS: values.WAIT_SECONDS,
		}),
	});
}

export function createWatchdogContinuedEnvelope(values) {
	return Object.freeze({
		version: 1,
		name: WATCHDOG_CONTINUED_HOOK_NAME,
		values: freezeValues({
			REASON_TYPE: values.REASON_TYPE,
			REASON: values.REASON,
		}),
	});
}

export function emitSemanticHook(events, envelope) {
	events.emit(SEMANTIC_HOOK_CHANNEL, envelope);
}
