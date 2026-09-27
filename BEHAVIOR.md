# Behaviour map — dsh-continue-watchdog

Pi source: `~/.pi/agent/git/github.com/xz-dev/pi-continue-watchdog` (BSD-3-Clause). Contract: `docs/behavior-contract.md`. User config: package `git:github.com/xz-dev/pi-continue-watchdog` in `~/.pi/agent/settings.json` only. No `pi-continue-watchdog.json`. Effective config is the Pi built-ins (`maxRetries` 10, fence 10s, `unlockShortcut` `alt+u`, default prompts and reason types).

| Item | Pi evidence | DSH mapping | Status | Test |
|---|---|---|---|---|
| Built-in defaults, invalid higher layer does not clobber | `src/config.ts`, contract defaults | `src/config.js` + cordis row | ported | `test/protocol.test.js` |
| `idleDelaySeconds` accepted, runtime fence fixed 10s | contract fence rule | `INQUIRY_FENCE_MS` | ported | grace test |
| Trailing `<watchdog>` continue / wait / unlock XML, 3 invalid re-asks | `src/decision-protocol.ts` | `src/decision-protocol.js` | ported | protocol test |
| Shared continue/wait attempt budget, exhaustion | `src/controller.ts` | `src/controller.js` | ported | protocol + runtime |
| Canonical event bodies (Pi attribution text) | `src/watchdog-event.ts` | `src/watchdog-event.js` | ported | protocol test |
| Silent fresh lock on real main user message; manual `/lock-continue-watchdog` notifies once | `extension.ts`, `commands.ts` | `user/message` `source.kind===user`; command `lock-continue-watchdog` | ported | runtime test |
| Ensure lock when main run starts while unlocked | contract rule 6 | `agent/status` `running` while unlocked | ported | error/abort test |
| Abort unlock, reasonless toast | contract rule 7 | `turn/end` `reason.kind===aborted` | ported | runtime test |
| Terminal error unlock, distinct toast, no fence | contract rule 8 | `turn/end` `reason.kind===error` | ported | runtime test |
| Aggregate idle = every registry agent not `running` and with empty inbox | hub + `ctx.isIdle()` | `agents.list()` + `AgentStatus` (`dsh-agent` `runtime-types.d.ts`) | ported | busy-agent test |
| One full 10s fence, restarted on activity, wait deadline is `max(fence, waitUntil)` | `activity-grace.ts` | `src/activity-grace.js` | ported | grace + wait tests |
| Decision prompt not a user message; raw XML not stored | contract isolation | auxiliary `ctx.llm.stream` (`purpose: session-title`); only canonical body is published | partial | runtime tests |
| Valid continue wakes one work turn with the canonical body | `Agent.followup` | `agent.followup` | ported | runtime test |
| Valid wait stores body, no work turn, `watchdog-waiting` | contract ex. 6b | `session.append(user/message)` | ported | wait test |
| Completed-wait body once, then next inquiry | contract ex. 6b | append on the fence that passes `waitUntilMs` | ported | wait test |
| AI unlock body, no work turn, no reasoned toast, `user-ready` `AI_UNLOCK` | contract ex. 7 | silent append + hook | ported | tool-deny test |
| Decision-failed body + toast + stay locked | contract ex. 8 | 3 invalid auxiliary replies | ported | runtime test |
| Exhaustion after the completing wait publishes exhausted + `user-ready` and no inquiry | contract ex. 10 | fence path when `snapshot.exhausted` | ported | controller unit; runtime path covered by the same publisher |
| Semantic hooks `pi:semantic-hook:v1` | `semantic-hook.ts` | `ctx.emit` same channel/envelope | ported | runtime hooks |
| `/unlock-continue-watchdog [reason]`, 500-char trim, empty toast, reasoned command text, cancel live run once | `commands.ts` | `dsh-commands` + `agent.cancel({kind:'user'})` | partial | runtime test |
| `/status-continue-watchdog` | `formatWatchdogTriggerStatus` | same lines; domain column `unavailable` | partial | status test |
| Block tools during the decision window | `tools` blocked before execute | `tools/pre-execute` deny while `decisionOpen` | partial | blocksTools test |
| Shortcut `alt+u` unlocks with no reason | `pi.registerShortcut` | `ctx.tuiShortcuts.register` when that service exists | ported | not executed headless |
| Lock is memory-only | contract rule 5 | no disk | ported | — |
| Cross-process authenticated child domain, 1s reconnect | `process-domain.ts` | no DSH seam | gap | — |
| In-agent decision turn with the live tool list still advertised | contract entry | no seam to run a turn that is hidden from the transcript but keeps tools | gap | — |
| Muted user-only history entries (human reason, error unlock) | TUI custom entries | no user-only transcript seam; command result + toast | gap | — |
| Fold a logged decision exchange via surface replace | `context-fold.ts` | exchange is not logged, so fold is unnecessary; human transcript never shows XML | built-in unused | — |
| Trusted project `./.pi/pi-continue-watchdog.json` and global `pi-continue-watchdog.json` | `config-loader.ts` | no Pi trust bit; user has neither file | gap | — |
| Abort correlated run cleans partial assistant out of model context | contract human unlock | `agent.cancel` only | gap | — |
| Several roots: UI-bound session wins main | contract election | `agents.roots()[0]` only | gap | — |

## Gaps (missing seams)

- Process domain: DSH has no inherited authenticated child-Pi coordinator. Only agents in this process registry count.
- Decision turn: `llm.stream` is not the agent loop, so the decision call does not advertise ordinary tools and does not keep the prompt-cache prefix. `tools/pre-execute` still denies real tool calls on the main agent while that call is in flight.
- User-only history: `session.append('user/message')` is model-visible. Human reason and the error-unlock record are command/toast text, not muted transcript rows.
- Correlated-run cleanup: no API to strip a partial assistant or mark `pi-continue-watchdog:cancelled` after `message_end`.
- Project trust: no Pi `trusted project` flag, so a cwd json is not read.
- Main election: no "UI-bound session" query beyond root order.
- `tuiToast.show` caps text at 200 cells (`dsh-tui` toast.d.ts). Short notices fit. A long decision-failed diagnostic is complete in the canonical message and may be clipped in the toast.
