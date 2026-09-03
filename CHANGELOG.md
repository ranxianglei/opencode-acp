# Changelog

### v1.14.27 — Self-disable also triggers in manual proxy mode (/bili/ baseURL detection)

**Problem**: The v1.14.25 self-disable only covered the `bili opencode` launcher (env var `BILLION_CONTEXT_PROXY`). Users pointing a provider `baseURL` at the billion-context proxy directly (manual mode) still got duplicate context-management stacks — ACP's tools and `/acp` command alongside the proxy's wire-level compression (issue #337).

**Fix** (#338):
- The plugin's config hook now scans every configured provider for the documented `/bili/` path prefix in `options.baseURL` and, when found, self-disables: all five ACP tools (`compress`, `decompress`, `search_context`, `acp_status`, `acp_context_recap`) are permission-denied (removed from the LLM tool list), the `/acp` command and `primary_tools` registration are skipped, and every transform/event hook becomes a no-op. One log line explains why.
- Detection is per-provider and case-sensitive; lookalikes (`/bilix/`, `bilibili.com`, bare `/bili`) do not match. The disable flag un-latches on config reload when no provider routes through the proxy again.
- Zero behavior change when no provider routes through the proxy — standalone installs are unaffected. 15 new tests (unit + integration through the real plugin factory); full suite 1044/1044.

**Docs** (#352):
- Soft-deprecated `minContextLimit` and `modelMinLimits` (JSDoc + JSON schema + README/CONFIGURATION, EN/zh). Both remain fully honored until removed; growth nudges (`minNudgeContextPercent` + `nudgeGrowthTokens`) are the maintained nudge mechanism. `modelMaxLimits` is **not** deprecated.

**Bookkeeping** (#358): promoted the npm `stable` dist-tag to 1.14.26.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.14.26 — Per-provider/per-model compress overrides; growth nudges respect the minNudgeContextPercent floor

**Problem**: T1 growth nudges fired well below any configured lower context limit — the `minNudgeContextPercent` floor was plumbed into the trigger policy but ignored, so growth nudges fired at any context size (issue #342: ten `trigger=growth` nudges at 67K–152K against a 150K minimum on a 400K model).

**Fix** (#343):
- Growth nudges now require `currentTokens >= minNudgeContextPercent% × model context` (default **5%**; set `0` to disable). Over-max (`maxContextLimit`) and the 98% emergency override bypass the floor; T2/T3 tier-promotion nudges are unaffected.
- When the model context window is unknown the floor is unresolvable and pre-fix growth-only behavior is preserved.
- Docs: corrected stale `minContextLimit`/`maxContextLimit` defaults in README/CONFIGURATION (45%/55% → 80%/80%) and clarified that `minContextLimit` governs turn/iteration reminder nudges while `minNudgeContextPercent` governs the growth-nudge floor.

**Feature** (#351):
- New nested `compress.providers` map: override **any** `compress` field per provider and per model (23 fields — thresholds, nudge behavior, protection, preservation, …). Resolution is per field: model > provider > global; unknown provider/model IDs fall back to the global value.
- A nested `maxContextLimit` outranks the legacy flat `modelMaxLimits` map (nested > flat > global). Overrides deep-merge across the three config layers per provider/model key.
- Strict validation (unknown fields and wrong types rejected) + JSON schema; documented in README (EN/zh) and CONFIGURATION (EN/zh) with recipes.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.14.25 — Self-disable under the billion-context proxy

**Problem**: Users running `bili opencode` (the billion-context launcher) got BOTH stacks at once: the proxy injects compress / decompress / search_context / acp_status at the wire level and adds its own `/acp` panel, while opencode-acp registered the same tool names and a competing `/acp` — duplicate tools and a client-side panel shadowing the proxy's real compression state.

**Fix** (#335):
- The plugin now checks `process.env.BILLION_CONTEXT_PROXY` (always exported by the `bili` launcher) at startup and, when set, logs one line and returns an empty plugin object — no tools, no commands, no transforms.
- Zero behavior change without the env var; standalone installs are byte-for-byte identical.

**Install**: `opencode plugin opencode-acp@latest --global`

