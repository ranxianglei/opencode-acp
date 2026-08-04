# DESIGN — opencode-acp → acp-kernel migration

Issue: dog/opencode-acp#42 · Branch: `2026-08-05_acp-kernel`

## 1. Why a phased migration

The current engine (`lib/compress`, `lib/messages`, `lib/state`, `lib/gc`) is
load-bearing: ~70 files, persisted-state format, 900+ tests, `dcp-` XML tags in
production state files, and a `/dcp` command alias for backward compat
(AGENTS.md §2.6). A big-bang replacement would break the shipped plugin, the
persisted state of live sessions, and be unreviewable. So:

- **Phase 1 (this PR)**: land `acp-kernel` + an additive `lib/kernel/` adapter.
  Zero behavior change. Builds + tests stay green.
- **Phase 2+ (follow-ups)**: switch the hot paths to the kernel, migrate state,
  delete the old engine.

## 2. The two state shapes (and why they differ)

### acp-kernel `CompressionState` (`acp-kernel/src/types.ts`)

```ts
interface CompressionState {
  blocks: CompressionBlock[];      // blockId: string ("b0"…), tier: 1|2|3
  messageRefs: { byRaw: Record; byRef: Record };
  nudge: NudgeState;               // flat: lastPerMessageNudgeTokens, lastShownByTier{}, …
  stats: CompressionStats;         // tokensCompressed, compressionCount
  nextBlockId: number;
  nextRunId: number;
}
```

### opencode-acp `SessionState` (`lib/state/types.ts`)

Richer / older format:

```ts
interface SessionState {
  prune: { messages: { byMessageId: Map; blocksById: Map<number, CompressionBlock>;
    activeBlockIds: Set<number>; activeByAnchorMessageId: Map; nextBlockId; nextRunId; markedForCleanup } }
  nudges: { contextLimitAnchors: Set; turnNudgeAnchors: Set; …; lastTier2/3NudgeTokens; compressBaselineSet; … }
  messageIds: { byRawId: Map; byRef: Map; nextRef }
  stats; compressionTiming; toolParameters; toolIdList; modelContextLimit; systemPromptTokens; …
}
// blockId: number (NOT string); block has startId/endId (m-refs), anchorMessageId,
// compressMessageId, includedBlockIds, consumedBlockIds, parentBlockIds,
// directToolIds, effectiveToolIds, effectiveCompressedTokens, summaryTokens, …
```

**Implication**: the formats are incompatible. Phase 3 must ship a converter
(old → kernel) and a one-time migration on load. Phase 1 only ships a
*detector* + writes the kernel state to a **new** path
(`plugin/acp-kernel/{sessionId}.json`) so the old `plugin/acp/{sessionId}.json`
is never touched until the converter exists.

## 3. Config mapping (`lib/kernel/config.ts`)

`resolveKernelConfig(plugin: PluginConfig, modelContextLimit: number): Config`

| kernel `Config` field            | source |
|----------------------------------|--------|
| `modelContextLimit`              | runtime `ctx.input.model.limit.context` (hooks), fallback 150000 |
| `protectedTools`                 | `plugin.compress.protectedTools` (FORCE_COMPRESS_PROTECTED appended) + `plugin.commands.protectedTools` |
| `preserveRecentMessages`         | `plugin.compress.preserveRecentMessages ?? 5` |
| `preserveRecentTokens`           | `plugin.compress.preserveRecentTokens ?? 5000` |
| `promotionThreshold`             | `plugin.gc.promotionThreshold` |
| `truncate.threshold`             | `plugin.gc.majorGcThresholdPercent` parsed → fraction (default 1.0) |
| `nudge.{max,min}ContextLimitPct` | `plugin.compress.{max,min}ContextLimit` percent parsed |
| `nudge.frequency`                | `plugin.compress.nudgeFrequency` |
| `nudge.iterationThreshold`       | `plugin.compress.iterationNudgeThreshold` |
| `nudge.force`                    | `plugin.compress.nudgeForce` |
| `nudge.growthRatio/Floor/Cap`    | defaults (0.05 / 6000 / 50000); `nudgeGrowthTokens` override → ratio |
| `nudge.minGrowthFloor/Ratio`     | `plugin.compress.minNudgeGrowthFloor / minNudgeGrowthRatio` |
| `nudge.emergencyThresholdPct`    | `plugin.compress.emergencyThresholdPercent` parsed |
| `compress.{min,max}…`            | `plugin.compress.minCompressRange / maxSummaryLengthHard` |
| `tiers.enabled`                  | `true` (kernel always supports tiers) |
| `messageFilters`                 | `plugin.messageFilters` (shape-compatible passthrough) |

Percentage parsing reused from existing `lib/config.ts` helpers where possible.

## 4. Message projection (`lib/kernel/messages.ts`)

OpenCode `WithParts = { info: Message; parts: Part[] }`. Part kinds (from
existing `lib/message-ids.ts`, `lib/messages/utils.ts`):

- `part.type === "text"` → `{ text, ignored? }`
- `part.type === "tool"`  → `{ tool, callID, state: { status, input, output } }`
- `part.type === "reasoning"` → reasoning text

`withPartsToCoreMessages(messages: WithParts[]): CoreMessage[]` maps each
message → one or more `CoreMessage`:

- role `user` text → `{ role:"user", contentType:"text", text }`
- assistant with N tool parts → N `{ role:"assistant", contentType:"tool-call",
  toolName, toolCallId: callID, text: JSON(input)+text }` (split by callID, ids
  `${id}#${callID}` — same id-splitting convention as pai-acp)
- assistant text-only → `{ role:"assistant", contentType:"text", text }`
- tool result: OpenCode models tool results as tool parts with `state.status`
  on the assistant/tool message. The converter emits
  `{ role:"tool", contentType:"tool-result", toolCallId, toolName, text }`
  from completed tool parts.
- `reasoning` parts are dropped from `CoreMessage` (kernel is reasoning-blind);
  a follow-up can add a `contentType:"reasoning"` if needed.

The inverse (`coreToWithParts`) reconstructs the OpenCode message list: for
non-split ids, patch ref tag onto the original; for split (`id#callID`) ids,
rebuild the assistant message keeping only surviving callIDs (pai-acp pattern).
`acp_summary_*` synthetic ids are skipped (compress-as-anchor: summaries live
inside the model's own `compress` calls, not synthetic messages).

## 5. Runtime (`lib/kernel/runtime.ts`)

Mirrors `pai-acp/src/runtime.ts`:

```ts
export interface AcpCoreRuntime {
  core: CompressionCore
  configFor(plugin: PluginConfig, modelContextLimit: number): Config
  stateFor(sessionId: string): Promise<{ state: CompressionState; coreMessages: CoreMessage[] }>
  save(state: CompressionState, sessionId: string): Promise<void>
  acquireLock(sessionId: string): Promise<() => void>
  invalidate(sessionId: string): void
}
export function createCoreRuntime(): AcpCoreRuntime
```

- `createCore({ countTokens })` once; `countTokens` from existing
  `lib/token-utils.ts` (BPE) so token counts match the rest of the plugin.
- per-session in-memory cache + async lock (no concurrent processTurn for the
  same session — pai-acp uses a promise-chain lock; we copy it).
- `stateFor` loads kernel state (or fresh) and projects current messages; the
  actual message list is passed in by the caller (hooks) so the runtime stays
  free of the OpenCode client SDK.

## 6. State persistence (`lib/kernel/state.ts`)

- Path: `<storage>/plugin/acp-kernel/{sessionId}.json`
  (`<storage>` = existing `~/.local/share/opencode/storage`).
- Atomic write (tmp + rename), same pattern as `lib/state/persistence.ts`.
- Load merges missing top-level fields from `createInitialState()`
  (forward-compat, pai-acp `mergeInitialState`).
- `detectLegacyState(sessionId)` returns the parsed legacy `SessionState` if
  `plugin/acp/{sessionId}.json` exists and looks like one (has
  `prune.blocksById`). Phase 3 will consume this; Phase 1 only logs it.

## 7. tsup / packaging

`tsup.config.ts` `noExternal` gains `"acp-kernel"` so the published
`dist/index.js` is self-contained (npm consumers install no extra dep). Same
treatment as `context-compress-algorithms`. `NOTICE` gains the acp-kernel MIT
attribution.

## 8. What does NOT change in Phase 1

- `index.ts` entry, `lib/hooks.ts`, all tools, `/acp` commands, prompts,
  notifications, the old engine — untouched.
- `plugin/acp/{sessionId}.json` legacy state — untouched.
- `dcp-` XML tags, `/dcp` alias, config schema — untouched.

## 9. Phasing summary

| Phase | PR scope | Risk |
|-------|----------|------|
| **1 (this)** | acp-kernel dep + `lib/kernel/` adapter (additive) | none — nothing wired |
| 2 | rewire hooks message-transform + tools to kernel runtime | high — hot path |
| 3 | legacy-state migration converter + delete old engine | high — persisted state |
| 4 | retire `dcp-` tags (needs persisted-state migration plan) | medium |

## 10. Backward-compat guardrails

- Never write to `plugin/acp/{sessionId}.json` from kernel code.
- Never change `dcp-` tag names without a migration (AGENTS.md §2.6).
- Keep `compress.protectedTools` force-protect of `"compress"`
  (`FORCE_COMPRESS_PROTECTED`) in the config mapping — losing a compress
  summary is irreversible (Bug: sequential-compress summary loss).
