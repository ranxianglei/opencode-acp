# DESIGN - Batch Compress Interface (Multi-Topic)

## 1. Schema (range mode)

New canonical shape:
```jsonc
{
  "topics": [
    { "topic": "Auth Exploration", "content": [ { "startId": "m00001", "endId": "m00012", "summary": "..." } ] },
    { "topic": "Build Fix",         "content": [ { "startId": "m00020", "endId": "m00035", "summary": "..." } ] }
  ],
  "summaryMaxChars": 6000  // optional, per-summary override
}
```

Legacy shape (backward compat, wrapped internally to `[{topic, content}]`):
```jsonc
{ "topic": "Auth Exploration", "content": [ { "startId": "...", "endId": "...", "summary": "..." } ] }
```

### Tool schema (buildSchema)
All fields optional at the schema layer so the SDK accepts both forms; structural enforcement moves to `normalizeTopics`/`validateArgs`:
- `topics?`: array of `{ topic: string, content: array<{startId,endId,summary}> }`
- `topic?`, `content?`: legacy single-topic fields
- `summaryMaxChars?`: number

`normalizeTopics(input) -> CompressBatchTopic[]`:
- if `topics` is a non-empty array → use it
- else if `topic` (string) + `content` (array) → `[{topic, content}]`
- else → throw "Provide `topics` ..."

### Type additions (lib/compress/types.ts)
```ts
export interface CompressBatchTopic { topic: string; content: CompressRangeEntry[] }
```
`ResolvedRangeCompression` gains `topic: string` (set during resolution from the owning topic).

## 2. range.ts execute flow (revised)

```
normalizeTopics(input) -> topics[]
for each topic: validateArgs({topic, content})   // reuse existing per-entry validation
summary length check per entry (maxLen)
prepareSession -> rawMessages, searchContext
checkCompressCooldown(ctx, rawMessages)          // NEW
resolvedPlans: for each topic -> resolveRanges({topic,content}, ...).map(p => ({...p, topic}))
validateNonOverlapping(allResolvedPlans)         // GLOBAL across topics (unchanged fn)
filterProtectedToolMessages per plan; drop empties
minCompressRange total-chars check across all
preparedPlans loop (parseBlockPlaceholders ... appendMissingBlockSummaries) — unchanged, per plan
runId = allocateRunId ONCE
for each preparedPlan:
    blockId = allocateBlockId
    applyCompressionState({ topic: plan.topic, batchTopic: plan.topic, ... })   // topic per plan
recordCompressSuccess(ctx, rawMessages)          // NEW — before finalize so it persists
finalizeSession(ctx, toolCtx, rawMessages, notifications, topics.length===1 ? topics[0].topic : undefined)
```

### Why range-utils barely changes
`validateArgs` and `resolveRanges` already take the flat `{topic, content}`. We call them once per topic with that topic's flat shape, then tag each resolved plan with its topic. `validateNonOverlapping` already operates globally on a plan list — we feed it the concatenated list, so ranges from different topics are also overlap-checked. Only addition: `resolveRanges` populates `plan.topic = args.topic`.

## 3. Cooldown design

### State (lib/state/types.ts Nudges)
```ts
lastCompressAssistantCount?: number  // undefined = no prior compress this session
```
Persisted in `PersistedNudges`; `?? undefined` on load (old files → undefined → first compress allowed).

### Config (lib/config.ts CompressConfig)
```ts
cooldownOutputs?: number  // default 2; undefined/0 disables
```
DEFAULT_CONFIG.compress.cooldownOutputs = 2; mergeCompress: `override.cooldownOutputs ?? base.cooldownOutputs`.

### Helper (lib/compress/pipeline.ts)
```ts
checkCompressCooldown(ctx, rawMessages):
  cooldown = ctx.config.compress.cooldownOutputs
  if (cooldown === undefined || cooldown <= 0) return        // disabled
  if (ctx.state.manualMode === "compress-pending") return    // manual /acp compress exempt
  last = ctx.state.nudges.lastCompressAssistantCount
  if (last === undefined) return                             // first compress
  if (isOverMaxContextLimit(ctx, rawMessages)) return        // overflow priority
  current = countAssistantOutputs(rawMessages)
  if (current - last < cooldown) throw "Frequent compression blocked: ..."

recordCompressSuccess(ctx, rawMessages):
  ctx.state.nudges.lastCompressAssistantCount = countAssistantOutputs(rawMessages)
```
- `countAssistantOutputs`: `messages.filter(m => m.info.role === "assistant" && m.info.summary !== true).length` (exclude synthetic recap pseudo-messages).
- `isOverMaxContextLimit`: mirrors inject/utils.ts — resolves `maxContextLimit` (% of modelContextLimit or absolute number) vs `getCurrentTokenUsage(state, rawMessages)`.

### Placement
Called in range.ts and message.ts execute **after prepareSession, before any state mutation**. `recordCompressSuccess` called **immediately before finalizeSession** (so it persists; all throwing checks precede it).

### Why count assistant messages
Same-turn double-compress sees the same rawMessages → delta 0 → blocked. After 1 new assistant output → delta 1 → blocked (cooldown 2). After 2 → allowed. Robust to message-transform vs tool-call timing because it measures persisted assistant message count, not turn number.

## 4. message.ts
No schema change (already per-entry topic + batch). Only adds `checkCompressCooldown` after prepareSession and `recordCompressSuccess` before finalize.

## 5. Prompts
- `compress-range.ts` BATCHING → rewritten for `topics` (group independent ranges under separate topics in ONE call).
- `extensions/tool.ts` RANGE_FORMAT_EXTENSION → shows `topics` JSON.
- `context-limit-nudge.ts` / `turn-nudge.ts` / `iteration-nudge.ts` → multi-topic JSON example + "compress everything in one call".
- `messages/inject/inject.ts:295` one-call hint expanded to mention `topics`.

## 6. Backward compatibility
- Persisted state: `lastCompressAssistantCount` optional; old files load (undefined → first compress allowed).
- Tool args: legacy `{topic, content}` accepted via shim.
- Config: `cooldownOutputs` optional; old configs get default 2 via merge.
- Internal `dcp` tags/naming untouched.
