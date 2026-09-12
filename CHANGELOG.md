# Changelog

### v1.18.0 — adaptive compression candidates (opt-in): MICRO/EPISODE targets, executor-parity validated

**PR #341 + follow-ups.** Adds a candidate-planning layer on top of the existing range nudges — off by default, byte-exact with v1.17.1 behavior until you opt in.

**What it does when enabled** (`{"compress": {"candidates": true}}`):
- Nudges and `acp_status` advertise pre-validated, batchable compression targets instead of raw ranges: **MICRO** = one large message or a complete tool transaction (call+result closed pair); **EPISODE** = a contiguous historical segment of smaller units (≥ `minCompressRange`).
- Executor-parity: candidates are validated through the same `prepareExecutableRangePlans` path the `compress` tool uses — everything listed is submittable as-is (tool-pair closure, protection parity, Bug 39 semantics preserved). Planning is fail-closed and bounded to the visible context (v1.17.1 #385 guarantees ~1.2 ms).
- Solves the over-compression failure mode where a model facing "compress m00150–m00220" nukes a whole span to save one big tool output.

**Default OFF means exactly v1.17.1**: base nudge templates, breakdown copy, `acp_status` overview, and debug logs are restored byte-exact; candidate planning never runs (zero cost). Per-post-merge review, `compress.candidates` is NOT per-model overridable (global/project layers only) — the type surface, validation allowlist, and docs now agree. One deliberate carry-over from the PR branch: the transform pipeline reorder (tool-output truncation and budget guard now run after nudge injection) applies in both modes; e2e scenarios 01–12 all pass in OFF mode with the reorder in place.

**Also in this release**: system-prompt and `compress-range`-prompt candidate guidance is gated behind the same switch (a1a2f23); e2e scenario 13 opts in explicitly; 12 new tests including a §5.7 four-turn growth-cycle with production `preserveRecentMessages: 20` and #207 baseline-retention assertions. Full suite 1263/1263.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.17.1 — transform no longer scales with compression history (13.6 s → 1.2 ms) + config/CI fixes

Three fixes bundled — headliner is #385, which removes the long-session slowdown reported in #384:

**1. Transform cost bounded to visible context + active blocks** (#385, fixes #384):
Per-transform work scaled with the **total compression history** instead of the visible context. Candidate planning at 1,000 messages measured **13.6 s** on master; now **~1.2 ms** (acceptance target ≤20 ms met with ~17× headroom; same-harness before/after, `scripts/bench-candidate-planning.ts`).
- **RC1** `resolveBoundaryIds()` rebuilt the global boundary lookup per candidate draft → request-scoped `SearchContext.boundaryLookup` memo, built once per compress call.
- **RC1b** `resolveSelection()` ran the real Anthropic BPE tokenizer per message (~27 ms/KB) → new `estimateAllMessageTokensFast()` (chars/4, the existing estimation convention); exact BPE kept where correctness requires it.
- **RC2** T1 nudge analysis (context composition / protected refs / compressible ranges) ran every transform even when no nudge could fire → gated on `nudgeAllowed || emergencyOverride || tierTriggerPossible`, all consumers null-guarded.
- **RC3** `syncCompressionBlocks()` replayed ALL blocks (active + inactive) and `hideConsumedCompressCalls()` rebuilt immutable consumed-call indexes every transform → transient `structureVersion` bumped at the three block-mutation sites; sync skips full replay when unchanged; hide-consumed caches its derived index by version.
- **RC4** fire-and-forget state saves raced (stale-overwrite possible) → ordered, coalescing per-session save queue (snapshot at enqueue, `setImmediate` drain, batch writes latest snapshot only, FIFO, failure isolation).
- Persisted-state format **unchanged** — all new fields are transient; candidate executor validation, Bug 39 protection semantics, decompression, fork recovery untouched. +20 tests (sync equivalence, cache invalidation, memoization, save coalescing, §5.7 multi-turn growth-cycle).

**2. `qualityGate.algorithms` false "Unknown keys" warning** (#389, fixes #329): per-algorithm params (`qualityGate.algorithms.rouge-recall-v1.*`) are a legal dynamic-key map but the key-allowlist recursed into it — every startup warned on a valid config. Added to the recursion skip list (same convention as `compress.providers` / `messageFilters.filters`). Note: real param names for `rouge-recall-v1` are `layer1MinChars`, `layer1MinRetentionPct`, `layer2MaxRougeF1`, `layer2MaxTop20Recall` — unknown inner keys are silently ignored, so check your params actually take effect.

**3. Fork PR builds green again** (#390, fixes #366): `build-artifact` ran `npm publish` on every PR, but fork PRs can't access `NPM_TOKEN` → ENEEDAUTH killed the whole job. The publish step is now gated to same-repo heads; fork PRs still build, pack, and upload the artifact, and the install comment no longer advertises the npm tag or a base-repo ref that doesn't exist for forks. CI-only — no runtime code.

Files: `lib/compress/search.ts`, `lib/messages/sync.ts`, `lib/messages/utils.ts`, `lib/token-utils.ts`, `lib/state/persistence.ts`, `lib/state/types.ts`, `lib/config-validation.ts`, `scripts/bench-candidate-planning.ts` (new), `.github/workflows/pr-artifact.yml`. Full suite 1209/1209 on the release branch; typecheck + build clean.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.17.0 — context-limit safety net + budget guard: no more silent 400 death loops

Six fixes bundled, two of them new protection subsystems for sessions whose context window was unknown or exceeded:

**1. Context-limit safety net for spawn+resume** (#349, fixes #346 — HIGH):
In headless spawn+resume mode the model-limit catalog seed raced server readiness and stayed empty forever; `state.modelContextLimit` was learned and lost every message, disabling every percentage threshold (nudges, emergency override, GC, truncation). The session grew until the backend rejected it.
- The system hook now persists the learned limit (and its model identity) to session state, so a freshly spawned process resumes with the limit already known.
- `hydrateAndResolve()`: on a catalog miss during a request (server guaranteed up), hydration is retried once per process; concurrent callers await the same promise.
- New `resolveEffectiveContextLimit()` — model limit if known, else new `compress.contextLimitFallback` (default 128000, `0` disables) — now drives nudge thresholds, emergency override, GC batch cleanup, and tool-output truncation uniformly.
- Internal agents (title/summary/compaction) running on a different model no longer overwrite the session's limit.
- `OUTPUT_RESERVE_TOKENS` (16384) subtracted from the GC truncation threshold — the serving wall is window minus system prompt minus max_tokens, not the full window.
- Post-transform hard guard: ERROR log when the outgoing request still exceeds the real budget (the only signal before opencode's silent exit-0 on rejection).

**2. Context budget guard** (#350, fixes #347 — HIGH):
A model with no declared window (`limit.context = 0`, common on custom OpenAI-compatible providers) grew requests past the backend's real window → HTTP 400 → opencode swallows it as empty exit-0 — a permanently stuck session with no error surface.
- New `enforceContextBudget` in `messages.transform`: deterministic truncate-then-clear of the oldest compressible tool outputs when the estimated wire size exceeds `modelContextLimit − compress.completionReserveTokens` (default 32768, covering opencode's 32000 max_tokens fallback). Guards first user message, last 3 messages, protected tools, and compress summaries (Bug 39 parity). Idempotent with GC's truncation marker.
- Enforces ONLY the model-reported window — an absolute `compress.maxContextLimit` stays a soft nudge threshold (pruning to a guessed threshold starves the nudge of compressible targets; observed as an `e2e-blocks-nudges` regression during development).
- One-time per-session WARN with actionable guidance when the model reports no window.
- The competing design (#348, absolute-config fallback chain + clear-only) was closed in favor of this one.

**3. Nudge/exec char-counter alignment** (#360, fixes #359): the compress-recommendation side counted tool parts via `JSON.stringify(part).length / 4` while the execution-side min-size check used `countMessageCharacters` — recommendations could point at ranges the executor then rejected as below floor. Both sides now use `countMessageCharacters(msg) / 4`.

**4. Tier-aware cadence reset** (#365, fixes #364): every tier-1 capture reset the T2/T3 nudge baselines, re-arming the growthFloor wait — in compression-active sessions T2 distillation never fired. New `isCaptureOnlyCompress()`: only block-ref boundaries (real distillations/condensations) reset tier baselines; raw-message captures (all `mNNNNN`) don't. No-boundary/malformed calls conservatively keep the reset (#235 loop-prevention preserved).

**5. Reasoning tokens in context estimates** (#374, fixes #371): `/acp status` overview and drilldowns, and the nudge CONTEXT BREAKDOWN, previously omitted `reasoning` parts entirely; reasoning is now its own tracked category, included in totals and size sorting.

**6. `/acp` command error-log leak** (#297, fixes #296): the command handler's `throw new Error("__DCP_CONTEXT_HANDLED__")` sentinel leaked to opencode's error log on every `/acp` invocation; replaced with a plain `return` (commands already deliver output via `sendIgnoredMessage`).

Files: `lib/state/state.ts`, `lib/state/utils.ts`, `lib/hooks.ts`, `lib/config.ts`, `lib/config-validation.ts`, `lib/messages/inject/utils.ts`, `lib/messages/truncate-tools.ts`, `lib/messages/enforce-budget.ts` (new), `lib/messages/query.ts`, `lib/messages/inject/inject.ts`, `lib/compress/status.ts`, `dcp.schema.json`, CONFIGURATION (EN/zh). Tests: `tests/context-limit-fallback.test.ts`, `tests/model-switch-limits.test.ts`, `tests/truncate-tools.test.ts`, `tests/enforce-budget.test.ts` (new), `tests/recommend-exec-counter-alignment.test.ts` (new), `tests/inject.test.ts`, `tests/query-pure.test.ts`, `tests/acp-status.test.ts`, `tests/hooks-permission.test.ts`. Full suite 1207/1207; all six PRs locally re-verified (typecheck + tests + build) before merge.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.16.0 — storagePath: custom storage location for session state files

**Problem**: ACP's per-session state files (`{sessionId}.json` — compression blocks, nudge state, token stats) were always written to the hardcoded `$XDG_DATA_HOME/opencode/storage/plugin/acp`. Users on containers, NFS homes, or tight XDG data dirs had no way to relocate them (issue #379).

**Feature** (#380, closes #379):
- New optional top-level config `storagePath` (string) relocating the session-state directory:

| Value | Resolution |
|---|---|
| unset / empty | default `$XDG_DATA_HOME/opencode/storage/plugin/acp` (unchanged) |
| `/abs/path` | as-is |
| `~` / `~/x` | expanded against the home directory |
| `rel/path` | resolved against the project directory (opencode cwd) |

```jsonc
// acp.jsonc — global / config-dir / project layers all supported
{ "storagePath": "~/data/acp-state" }
```

- The resolved directory is computed once per session and carried on a transient `SessionState.storageDir` field that is never written to the persisted JSON.
- **No auto-migration**: when `storagePath` is set, no valid state is found there, but a state file exists at the default location, ACP logs a one-time WARN per session pointing at the file to move manually.
- Config validation, JSON schema, and CONFIGURATION (EN/zh) updated; 19 new tests (path resolution, custom-dir save/load round-trip, default-location regression, 3-layer merge, migration WARN, non-persistence, registry wiring); full suite 1131/1131; dual-agent code + test review.
- Default location is byte-for-byte unchanged when the option is unset; all API changes are additive.

**Install**: `opencode plugin opencode-acp@latest --global`

### v1.15.0 — compress.reasoning: drop oversized thinking from closed-turn compress calls

**Problem**: `compress` tool-call messages are hard-exempt from every compression selection (Bug 39) and are therefore re-sent verbatim on every LLM request. Their `reasoning` (thinking) parts ride along forever — a monotonically growing, unreclaimable context floor (measured at 83.5% of residual context in a real session; issue #368).

**Feature** (#377, supersedes #370):
- New request-time pass that removes `reasoning` parts from a message only when ALL gates hold: (1) **closed turn** — strictly before the last genuine user message (the active round is never touched; some providers require replaying active-round thinking); (2) **selector** — the message carries a `tool === "compress"` part (any status; only compress, not skill/task); (3) **single-thinking size** — the message's total reasoning length (summed across parts) **strictly exceeds** `threshold` chars. Small thinkings are kept; lengths are not accumulated across messages. Persisted history is never modified.
- New nested config `compress.reasoning { drop: true, threshold: 2048 }`, merged **field-wise** across the three config layers and the #344 provider/model cascade (model > provider > global; a deeper layer overrides only the fields it sets):

```jsonc
{
    "compress": {
        "reasoning": { "drop": true, "threshold": 2048 },
        "providers": {
            "my-gateway": { "reasoning": { "drop": false } },
            "anthropic": { "models": { "claude-opus-4-5": { "reasoning": { "threshold": 8000 } } } }
        }
    }
}
```

- Provider/model identity comes from the current request's last user message `info.model`, falling back to session state. `threshold: 0` drops any non-empty reasoning.
- Validation, JSON schema, README/CONFIGURATION (EN/zh) all updated; 29+ new tests (unit, cascade, validation, hook-level e2e — mutation-verified per gate); full suite 1112/1112; dual-agent reviewed (code + test).
- Also fixes two config-validation defects found in review: `reasoning` overrides inside `compress.providers` were spuriously rejected as unknown fields, and `compress.reasoning: null` crashed plugin startup instead of producing a warning.

**Process** (#367): AGENTS.md now requires issue tracking for problems discovered/fixed during development.

**Install**: `opencode plugin opencode-acp@latest --global`

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

