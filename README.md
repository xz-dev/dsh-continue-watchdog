# dsh-continue-watchdog

Port of [pi-continue-watchdog](https://github.com/xz-dev/pi-continue-watchdog) (BSD-3-Clause, Copyright xz-dev) to DeepSeek Harness. After the main agent and other in-process agents go idle, the plugin asks the model, off the transcript, whether to continue, wait, or unlock, then publishes one canonical event body.

Behaviour matrix and gaps: [BEHAVIOR.md](./BEHAVIOR.md).

```bash
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile tui add file:/absolute/path/dsh-continue-watchdog-0.1.0.tgz --ignore-scripts
```

The bundle patch inserts plugin `dsh-continue-watchdog` with Pi built-in defaults. Commands: `/lock-continue-watchdog`, `/unlock-continue-watchdog [reason]`, `/status-continue-watchdog`. Shortcut `alt+u` unlocks when `ctx.tuiShortcuts` exists.

`idleDelaySeconds` is ignored. The fence is 10 seconds. `maxRetries` counts valid continue and wait outcomes only.
