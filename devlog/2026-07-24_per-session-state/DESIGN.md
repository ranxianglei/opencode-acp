# DESIGN - Per-Session State Registry

- Task ID: `2026-07-24_per-session-state`
- Home Repo: `opencode-acp`
- Created: 2026-07-24
- Status: Draft (Oracle-validated)

## 1. Problem Statement

- **What problem are we solving?** One shared `SessionState` singleton causes cross-session state corruption when sessions interleave (parent + subagents). Most visible symptom: subagent `modelContextLimit` is always `undefined` → over-compression at ~5% context.
- **Why now?** Blocking reliable multi-agent review workflows (#33). Root cause confirmed from `sst/opencode` source: `experimental.chat.system.transform` DOES fire for subagents with `model.limit.context` populated; the value is lost purely due to the shared-state reset/load thrash.

## 2. Goals & Non-Goals

- **Goals**:
  - Each OpenCode session gets its own `SessionState` held for its lifetime; no reset-on-switch.
  - `modelContextLimit`, `isSubAgent`, `manualMode`, compression blocks, nudge anchors all isolated per session.
  - Preserve all existing behavior (compaction detection, currentTurn, GC, persistence).
- **Non-Goals**: safety-net nudge suppression; provider.list; full eviction policy; upstream opencode change.

## 3. Current Architecture

```
index.ts: const state = createSessionState()  // ONE shared singleton
   └─ passed to all hooks + compressToolContext
hooks.ts messages.transform → checkSession(state, messages):
   if state.sessionId !== lastSessionId → ensureSessionInitialized → resetSessionState (WIPES all)
                                                       → loadSessionState (reload from {sessionId}.json)
```
- **Pain points**: reset-on-switch wipes `modelContextLimit` (set only by system.transform, which fires AFTER messages.transform saves). Also flips `isSubAgent`/`manualMode` to whichever session ran last.

## 4. Proposed Architecture

```
index.ts: const registry = new SessionStateRegistry(logger)
   └─ registry holds Map<sessionId, SessionState> + a SHARED compressionTiming

SessionStateRegistry:
  get(sessionId)            // sync, returns cached or undefined
  all()                     // iterate all session states (for event-handler apply)
  getOrCreate(client, sessionId, messages, manualModeDefault, config)  // lazy create + init (idempotent)
  compressionTiming         // SHARED CompressionTimingState (hoisted out of per-session identity)

Each hook resolves its own state at entry:
  messages.transform: sessionId = lastUserMessage.info.sessionID → registry.getOrCreate(...)
                       → updatePerTurnState(state, ...)  // compaction + currentTurn (the non-switch parts of checkSession)
  system.transform:   registry.get(input.sessionID) → set state.modelContextLimit
  command:            registry.getOrCreate(client, input.sessionID, messages, ...)
  event:              uses registry.compressionTiming (shared); on complete, iterate registry.all() for apply
  compress tools:     resolve state at execute entry (registry.get(toolCtx.sessionID))
```

### Why shared `compressionTiming` (hoist)
The event handler has no `sessionID` in its input. If each session had its OWN `compressionTiming` map, `consumeCompressionStart` (destructive `.delete`) would consume the start in the wrong session, leaving the owning session dangling. Solution: the registry assigns ONE shared `compressionTiming` object to every session's `state.compressionTiming` (same reference). Record/consume operate on a single map (correct). The apply step (`applyPendingCompressionDurations`) matches `pendingByCallId` against each session's `blocksById`, so we iterate `registry.all()` and only the owning session gets `applied > 0` (and deletes the pending entry). This preserves the `SessionState.compressionTiming` field shape → tests/fixtures unchanged.

### compress tool context
`ToolFactoryContext` (new) = `{ client, registry, logger, config, prompts }`. Each factory resolves state at `execute` entry into a local `ToolContext` (shape unchanged) so the ~10 compress modules are untouched.

## 5. Design Decisions & Rationale

| Decision | Options Considered | Chosen | Why |
|----------|--------------------|--------|-----|
| State container | (a) shared singleton+reset (b) per-session registry | registry | Only correct option; reset thrash is the bug |
| compressionTiming | (a) per-session + iterate-all (b) hoist to shared ref | hoist (shared ref) | Iterate-all is INCORRECT: consume is destructive; shared ref keeps single map |
| compress tool state | (a) resolve at entry (b) thread registry everywhere | resolve at entry | Minimizes blast radius; modules untouched |
| Eviction | (a) none (b) soft cap (c) full LRU/TTL | soft cap (~32) | v1 daemon-safety; cheap; full policy premature |
| Async init guard | (a) none (b) in-flight Promise per session | none for v1 | JS single-threaded: Map.set + sessionId assignment are sync before await; OpenCode fires hooks sequentially per session |
| Smaller fix (isolate modelContextLimit only) | side Map<sessionId,number> | rejected | Masks one symptom; leaves block/anchor/isSubAgent corruption |

## 6. Impact Analysis

- **Backward compatibility**: No persisted-state format change. Existing `{sessionId}.json` (incl. `modelContextLimit`) loads as before. Subagent JSONs with corrupt `modelContextLimit: undefined` self-heal (restore guard skips non-number; next system.transform sets it).
- **Performance**: One extra Map lookup per hook (negligible). Registry memory bounded by soft cap. Event apply iterates ≤ cap sessions (cheap).
- **Security**: N/A (no new I/O surfaces).
- **Dependencies**: none.

## 7. Migration Plan

- **Steps**: None. Pure in-process refactor; persistence unchanged.
- **Feature flags**: N/A.

## 8. Open Questions

- [ ] (resolved by Oracle) event handler: hoist compressionTiming — confirmed.
- [ ] Eviction cap value: 32 (configurable later).

## Invariants preserved (Oracle checklist)
- `if (!lastUserMessage) return` BEFORE registry.getOrCreate (cannot derive sessionId otherwise).
- `INTERNAL_AGENT_NAMES` skip BEFORE registry.getOrCreate (title/summary/compaction must not init bogus sessions).
- Post-compaction `saveSessionState` kept inside `updatePerTurnState`.
- `applyPendingCompressionDurations` during init uses the SHARED compressionTiming (registry assigns it before ensureSessionInitialized; `resetSessionState` must NOT recreate compressionTiming).
- Incidentally fixes: `isSubAgent`/`manualMode` no longer flip-flop across sessions (latent bug).
