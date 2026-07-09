# Design: Batch Sweep Compression + Age-Based Protection

> **Status**: Confirmed design (v2 — supersedes original Solutions A–D which proposed silent pre-pruning, **rejected** by maintainer)
> **Date**: 2026-07-09
> **Decision**: Model-driven batch compression with cache-friendly ranges, NOT silent content stripping.

---

## 1. Problem Statement

ACP's protected-tools mechanism (Bug 39) hard-excludes protected tool messages from compression ranges. This has two consequences:

1. **Protected tools accumulate** — `todowrite`, `write`, `edit` calls between compressed ranges are never swept.
2. **Small compressions fragment cache** — the model does many small range compressions (<5 messages each), each invalidating the prefix cache.

### 1.1 The Accumulation Pattern

```
Session timeline:
  [big output] [small write] [small edit] [small todo] [big output] [small write] ...
       ↓                                                        ↓
   compressed                                              compressed
       ↓                                                        ↓
   summary block                                        summary block

  What remains visible:
  [summary] [small write] [small edit] [small todo] [summary] [small write] ...
              ↑              ↑              ↑                     ↑
         never swept      never swept   never swept           never swept
```

### 1.2 The Cache Fragmentation Problem

Each compression changes the message array sent to the API. The prefix cache (Anthropic prompt caching) matches from the beginning; any change at position N invalidates the cache for everything after N.

**Empirical finding**: One session had 70 compressions, 71% covering <5 messages. That's ~50 small compressions, each breaking the cache at a different point. Another session (same model, same task type) had 37 compressions, 0% small ranges, 72% large ranges — dramatically better cache efficiency.

---

## 2. Empirical Analysis (5 Sessions)

### 2.1 Methodology

Analyzed 5 sessions (331–1638 messages each) using `acp-inspect --tool-analysis` mode and direct SQLite queries. Data is sanitized: no file paths, no session IDs, no project-specific content.

### 2.2 Per-Tool Accumulation

| Tool | Typical visible calls | Typical visible tok | % of visible tool | Key pattern |
|------|-----------------------|---------------------|-------------------|-------------|
| `bash` | 14–78 | 12K–33K | 23–47% | Repeated env-prefix commands (`export CI=true...` ×11–30), repeated SSH commands (×30), status checks |
| `todowrite` | 32–84 | 12K–19K | 18–51% | **0% pruned** in most sessions; spread across 70%+ of session; avg gap 5–7 msgs |
| `write` | 3–8 | 3K–12K | 5–17% | Input dominated (file content duplicates disk) |
| `edit` | 3–12 | 1K–4K | 4–12% | "Edit applied successfully." echoes |
| `compress` | 1–22 | 1K–15K | 2–24% | Compression tool calls themselves accumulate |

### 2.3 bash Prefix Duplication

The single biggest waste pattern across all sessions:

| Pattern | Repetitions | Waste per session |
|---------|-------------|-------------------|
| `export CI=true DEBIAN_FRONTEND=noninteractive...` (env injection) | 11–30× | 24K–66K chars |
| `ssh -p 1194 -o StrictHostKeyChecking=no...` (remote ops) | 30× | ~40K chars |
| `awork-reply N owner/repo << 'AWORK_REPLY_END'` (bot replies) | 7–10× | ~4K chars |

These are command prefixes repeated in every invocation due to environment injection, not user choice.

### 2.4 todowrite Fragmentation

| Session | Visible calls | Pruned calls | Span (% of session) | Avg gap (msgs) |
|---------|--------------|--------------|---------------------|-----------------|
| Session A | 84 | **0** | 70%+ | 5–7 |
| Session B | 34 | 41 | 60% | 8–10 |
| Session C | 32 | **0** | 65% | 6–8 |
| Session D | 46 | 11 | 75% | 4–6 |

**Key finding**: todowrite is **never pruned** in sessions where ACP doesn't explicitly compress a range containing it. This is because Bug 39 hard-excludes it from compression selections.

### 2.5 Cache Invalidation Impact

| Session | Compressions | Small ranges (<5 msgs) | Large ranges (≥20 msgs) |
|---------|-------------|----------------------|------------------------|
| Session A | 70 | **50 (71%)** | 4 (5%) |
| Session B | 37 | 0 (0%) | 27 (72%) |

Session A's 50 small compressions each broke the cache prefix. Session B's large-range strategy preserved cache much better.

---

## 3. Root Cause

### 3.1 Why todowrite Can't Be Compressed

**Code path**: `lib/compress/range.ts:99`

```typescript
selection: filterProtectedToolMessages(
    plan.selection,
    searchContext,
    ctx.config.compress.protectedTools,  // ["task", "skill", "todowrite", "todoread"]
    ctx.config.protectedFilePatterns,
)
```

`filterProtectedToolMessages` (`lib/compress/protected-content.ts:233`) unconditionally removes any message containing a protected tool from the compression selection. The removed messages survive intact in visible context.

**The problem**: This protection is **ageless** — a todowrite from 2 messages ago and one from 200 messages ago are treated identically. Recent todowrite state may be actively referenced by the model, but old todowrite state is pure history.

### 3.2 Why Small Compressions Fragment Cache

The current nudge system (`lib/messages/inject/inject.ts`) triggers on:
- Context usage exceeding `minContextLimit` / `maxContextLimit` (percentage of model context)
- Tool output growth exceeding `toolOutputNudgeThreshold` (adaptive, ~5% of context)

The nudge lists top ranges and says "compress these now." The model tends to compress the largest single output it sees, then the next, creating many small blocks. There's no mechanism to encourage batching multiple small items into one large range.

---

## 4. Solution: Two Features

### Feature A: Age-Based Protection Expiry (PR-A)

**Concept**: Protected tools lose protection status after N messages. Old protected tool calls become compressible; recent ones stay protected.

**Config**:
```jsonc
{
    "compress": {
        "protectedTools": ["task", "skill", "todowrite", "todoread"],
        "protectedToolMaxAge": {
            "todowrite": 15,
            "todoread": 15
            // task/skill: not listed → Infinity (permanent protection)
        }
    }
}
```

**Implementation**: Modify `filterProtectedToolMessages` in `lib/compress/protected-content.ts`:

```typescript
// Current (Bug 39): unconditional removal
if (messageContainsProtectedTool(message, protectedTools, patterns)) {
    removedMessageIds.add(messageId)
}

// New: age-conditional removal
if (messageContainsProtectedTool(message, protectedTools, patterns)) {
    const toolName = getProtectedToolName(message, protectedTools)
    const maxAge = protectedToolMaxAge?.[toolName] ?? Infinity
    const messageIndex = searchContext.rawIndexById.get(messageId) ?? 0
    const currentIndex = searchContext.rawMessages.length - 1
    const age = currentIndex - messageIndex
    if (age <= maxAge) {
        removedMessageIds.add(messageId)  // recent: protect
    }
    // old: allow compression (don't add to removedMessageIds)
}
```

**Scope**: 
- Changes: `lib/compress/protected-content.ts` (filterProtectedToolMessages), `lib/config.ts` (new config field), `lib/config-validation.ts` (validate new field)
- Tests: `tests/compress-state.test.ts` or new `tests/protected-age.test.ts`
- Risk: LOW — opt-in via config; default behavior unchanged if `protectedToolMaxAge` not set

**Why this works for todowrite**: Recent todowrite (last 15 msgs) stays visible — the model can reference the current todo list. Old todowrite (50+ msgs ago) gets compressed into summaries when the model next compresses a range containing it.

### Feature B: Batch Sweep Compression (PR-B)

**Concept**: Track accumulated small tool calls per type. When a tool type hits 5% of context AND a quantitative threshold, inject a batch nudge suggesting cache-friendly contiguous ranges.

#### B.1 Accumulation Tracker (SessionState)

```typescript
// New field in SessionState
batchSweep: {
    byToolType: Map<string, {
        visibleTokens: number,      // total tokens of visible calls of this type
        visibleCallCount: number,   // count of visible calls
        candidateRanges: Array<{    // pre-computed compressible ranges
            startRef: string,       // mNNNNN
            endRef: string,         // mNNNNN
            msgCount: number,
            estimatedTokens: number,
        }>,
    }>,
    lastSweepBlockId: number | null,  // last block created by a batch sweep
}
```

Updated every message-transform cycle by scanning visible messages.

#### B.2 Trigger Conditions (AND logic)

A batch sweep nudge fires when ALL of the following are true for at least one tool type:

1. **Percentage threshold**: `visibleTokens / totalContextTokens >= 5%`
2. **Quantitative threshold**: `visibleTokens >= tokenThreshold` (default: 10K)
3. **Call count threshold**: `visibleCallCount >= messageThreshold` (default: 10)
4. **Fragmentation detected**: `avgGap >= 3` (calls are scattered, not clustered)

#### B.3 Range Pre-Computation

When trigger conditions are met, compute optimal batch ranges:

```
1. Scan visible messages, find contiguous segments of uncompressed small tool calls
2. Merge segments with gap < 3 messages (reduce fragmentation)
3. Filter out segments < 500 tokens (too small to bother)
4. Sort by recency: newest first (cache-friendly — end of message array)
5. Output top 1-3 ranges as recommendations
```

**Why newest-first**: Prefix cache matches from the beginning of the message array. Compressing the newest content (end of array) only invalidates cache at the tail. Compressing old content (middle of array) invalidates everything after it.

#### B.4 Deferred Delivery

Don't fire the nudge if the model is mid-task:

```
Check: is the last message a tool call with no assistant response yet?
  YES → defer (model is executing tools)
  NO  → fire (natural pause point: user message or completed turn)

Exception: if context > 90% full, force-fire regardless of deferral
```

This respects @dog's requirement: "允许他把提醒稍微滞后" (allow the reminder to be slightly delayed).

#### B.5 Nudge Format

```
📦 Batch compression opportunity: {toolType} has {N} visible calls (~{K} tokens, {P}% of context).
These are scattered across your context and compressing them individually would cause
multiple cache invalidations. Consider one batch compress:

  {startRef}–{endRef} ({msgCount} msgs, ~{tokens} tok)  ← most recent
  {startRef}–{endRef} ({msgCount} msgs, ~{tokens} tok)

⚠️ These tool calls may contain important information. When writing the summary,
transcribe any critical details (file paths, decisions, error messages) before discarding.

This batch compress would save ~{totalSavings} tokens with only 1 cache invalidation.
```

#### B.6 Config

```jsonc
{
    "compress": {
        "batchSweep": {
            "enabled": false,                  // opt-in
            "contextPercentThreshold": 5,      // tool type must be ≥5% of context
            "tokenThreshold": 10000,           // AND ≥10K tokens
            "callCountThreshold": 10,          // AND ≥10 visible calls
            "fragmentationGapThreshold": 3,    // AND avg gap ≥3 msgs
            "rangeMergeGapThreshold": 3,       // merge segments with gap <3
            "minRangeTokens": 500,             // skip ranges <500 tok
            "maxRecommendedRanges": 3,         // suggest at most 3 ranges
            "deferDuringToolUse": true,        // don't interrupt mid-task
            "forceAtContextPercent": 90        // force fire if context >90%
        }
    }
}
```

#### B.7 Fragmentation Detection

For each tool type, compute:

```typescript
interface FragmentationReport {
    toolType: string
    callCount: number
    positions: number[]           // message indices of visible calls
    spanPercent: number           // (last - first) / totalMessages * 100
    avgGap: number                // average messages between consecutive calls
    isFragmented: boolean         // avgGap >= 3 && spanPercent >= 30
    mergeStrategy: "batch" | "individual"
}
```

| Tool type | Typical pattern | Strategy |
|-----------|----------------|----------|
| `todowrite` | span 70%+, gap 5–7 | **batch** (highly fragmented) |
| `bash` | clustered in work phases | **batch** (moderate fragmentation) |
| `delegate_task` | 1–2 large blocks | **individual** (not fragmented) |

---

## 5. Implementation Plan

### PR-A: Age-Based Protection (standalone, no dependencies)

**Files changed**:
- `lib/config.ts` — add `protectedToolMaxAge` to compress config
- `lib/config-validation.ts` — validate new field
- `lib/compress/protected-content.ts` — modify `filterProtectedToolMessages`
- `tests/protected-age.test.ts` — new test file

**Effort**: Small (1–2 hours). Low risk. Can ship independently.

**Testing**:
- Recent protected tool (age < maxAge) → excluded from compression (protected)
- Old protected tool (age > maxAge) → included in compression (compressible)
- Tool not in maxAge map → permanent protection (backward compat)
- Config not set → all tools permanently protected (backward compat)

### PR-B: Batch Sweep Compression (depends on PR-A for todowrite)

**Files changed**:
- `lib/state/types.ts` — add `batchSweep` to SessionState
- `lib/messages/inject/batch-sweep.ts` — new module (tracker + trigger + range computation)
- `lib/messages/inject/inject.ts` — wire batch sweep nudge into pipeline
- `lib/config.ts` — add `batchSweep` config
- `lib/config-validation.ts` — validate new config
- `tests/batch-sweep.test.ts` — new test file

**Effort**: Medium (3–5 hours). Moderate complexity (range computation, fragmentation detection).

**Why depends on PR-A**: Without age-based protection, todowrite can never be compressed even if batch sweep recommends a range containing it. PR-A unlocks todowrite compressibility; PR-B provides the trigger mechanism.

### PR-E: acp-inspect --tool-analysis (already done ✅)

- Script: `~/.local/bin/acp-inspect` (+200 lines)
- Docs: `~/.claude/skills/acp-inspect/SKILL.md`
- Status: Complete, tested on 4 sessions

---

## 6. What Was Rejected (v1 Solutions A–D)

The original proposal (v1) included silent pre-pruning strategies:
- **Solution A**: Strip write/edit input content after N turns
- **Solution B**: Deduplicate repeated hook outputs
- **Solution C**: Keep only latest K todowrite calls, prune rest
- **Solution D**: Keep only latest status check output

**Why rejected**: These operate without model involvement. The maintainer's position is that tools may contain important information — the model must decide what to keep by transcribing to summaries. Silent stripping removes model agency.

The v2 approach (batch sweep + age protection) preserves model agency: the model still writes the summary, decides what's important, and controls the compression. ACP only provides better triggers and range suggestions.

---

## 7. Backward Compatibility

- All new config fields default to disabled/opt-in
- `protectedToolMaxAge` unset → permanent protection (current behavior)
- `batchSweep.enabled = false` → no batch nudges (current behavior)
- No changes to persisted state format (batch sweep state is ephemeral, recomputed each cycle)
- No changes to compression tool API (model calls `compress` the same way)

---

## 8. Open Questions

1. **Age threshold value**: 15 messages for todowrite? Or should it be turn-based (after N user messages) rather than message-based?
2. **Batch sweep reset**: Should the accumulation tracker reset after a successful batch compression, or continue accumulating?
3. **Multiple tool types triggering simultaneously**: If both bash and todowrite hit thresholds at the same time, should the nudge suggest separate ranges per type, or one merged range?
4. **Interaction with existing nudges**: Should batch sweep replace the current `toolOutputNudgeThreshold` nudge, or coexist?
