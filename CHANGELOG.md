# Changelog

### v1.14.26 — Growth nudges respect the minNudgeContextPercent floor

**Problem**: T1 growth nudges fired well below any configured lower context limit — the `minNudgeContextPercent` floor was plumbed into the trigger policy but ignored, so growth nudges fired at any context size (issue #342: ten `trigger=growth` nudges at 67K–152K against a 150K minimum on a 400K model).

**Fix** (#343):
- Growth nudges now require `currentTokens >= minNudgeContextPercent% × model context` (default **5%**; set `0` to disable). Over-max (`maxContextLimit`) and the 98% emergency override bypass the floor; T2/T3 tier-promotion nudges are unaffected.
- When the model context window is unknown the floor is unresolvable and pre-fix growth-only behavior is preserved.
- Docs: corrected stale `minContextLimit`/`maxContextLimit` defaults in README/CONFIGURATION (45%/55% → 80%/80%) and clarified that `minContextLimit` governs turn/iteration reminder nudges while `minNudgeContextPercent` governs the growth-nudge floor.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.14.25 — Self-disable under the billion-context proxy

**Problem**: Users running `bili opencode` (the billion-context launcher) got BOTH stacks at once: the proxy injects compress / decompress / search_context / acp_status at the wire level and adds its own `/acp` panel, while opencode-acp registered the same tool names and a competing `/acp` — duplicate tools and a client-side panel shadowing the proxy's real compression state.

**Fix** (#335):
- The plugin now checks `process.env.BILLION_CONTEXT_PROXY` (always exported by the `bili` launcher) at startup and, when set, logs one line and returns an empty plugin object — no tools, no commands, no transforms.
- Zero behavior change without the env var; standalone installs are byte-for-byte identical.

**Install**: `opencode plugin opencode-acp@latest --global`

