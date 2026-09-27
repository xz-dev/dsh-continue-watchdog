// Status line from pi-continue-watchdog/src/commands.ts. Domain count stays
// "unavailable" when the caller has no authenticated process domain.

const BLOCKER_TEXT = {
	"not-main": "not main",
	"config-loading": "config loading",
	unlocked: "unlocked",
	exhausted: "retry limit exhausted",
	"decision-failed": "decision failed",
	"observable-agent-busy": "observable agent busy",
	"local-agent-busy": "local agent busy",
	"pending-messages": "pending messages",
	"decision-open": "decision open",
	"decision-finalizing": "decision finalizing",
};

export function formatWatchdogTriggerStatus(status) {
	const lines = [
		"Continue watchdog status",
		`Main: ${status.main ? "yes" : "no"}`,
		`Lock: ${
			status.locked === null
				? "unavailable"
				: status.locked
					? "locked"
					: "unlocked"
		}`,
		`Attempt: ${status.attempt ?? "unavailable"}/${status.maxRetries}`,
		`Trigger: ${
			status.blocker === null
				? "eligible"
				: `blocked · ${BLOCKER_TEXT[status.blocker] ?? status.blocker}`
		}`,
		`Grace: ${
			status.gracePhase === "grace" && status.graceRemainingMs !== null
				? `waiting · ${Math.ceil(status.graceRemainingMs / 1000)}s remaining`
				: status.gracePhase
		}`,
		`Busy: observable ${status.observableBusyCount}, domain ${
			status.domainBusyParticipants ?? "unavailable"
		}`,
	];
	return lines.join("\n");
}

export function truncateHumanReason(reason) {
	const trimmed = typeof reason === "string" ? reason.trim() : "";
	const chars = Array.from(trimmed);
	if (chars.length === 0) return "";
	return chars.slice(0, 500).join("");
}
