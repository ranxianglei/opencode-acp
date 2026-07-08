# REQ: Memory Mechanism for ACP

## Problem

ACP's compression system is lossy by design — summaries replace original messages. Critical persistent facts (user preferences, corrections, constraints, decisions) can be lost through compression cycles, even with good compression rules.

Claude Code solves this with `CLAUDE.md` — a persistent file injected into every system prompt, never compressed. Cursor, GitHub Copilot, and Windsurf all use the same pattern.

ACP needs an equivalent: a **session-scoped memory store** that:
1. Persists critical facts across compression cycles
2. Is injected into every system prompt turn (never compressed away)
3. Can be written by the model via a `remember` tool
4. Can be queried and deleted by the user via `/acp` commands

## Scope

**In scope:**
- `remember` tool — model writes memory entries
- `/acp memory` command — list all entries
- `/acp forget` command — delete entries
- System prompt injection — memory appears every turn
- State persistence — memory survives restart

**Out of scope (future):**
- Cross-session memory transfer/templates
- Global (non-session) memory
- Memory categories/tags UI
- Automatic memory extraction (model decides what to remember)

## Constraints

1. **No FIFO / no auto-eviction** — memory must be reliable; auto-deletion defeats the purpose. Only explicit deletion removes entries.
2. **Per-entry ≤ 200 chars** — each entry is a concise constraint/preference, not a paragraph. Aligns with `compress.maxSummaryLengthHard` pattern: configurable + overridable via tool parameter.
3. **No `force` parameter** — use `maxChars` parameter (same as compress's `summaryMaxChars`).
4. **Memory ≠ user prompt** — system prompt must clearly distinguish memory from current user instructions.
5. **Backward compatible** — persisted state format change must not break existing sessions.
6. **No new dependencies** — use existing SDK patterns.
