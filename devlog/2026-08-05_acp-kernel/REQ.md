# REQ — opencode-acp 内核换成 acp kernel

Issue: dog/opencode-acp#42
Branch: `2026-08-05_acp-kernel` (worktree `/home/dog/projects/opencode-acp-kernel`)

## Goal

Replace opencode-acp's in-tree compression engine with the external
**`acp-kernel`** library, following the **`pai-acp`** adapter pattern. Both
reference projects live under `~/projects`; per the issue ("参考 pai acp … 可以搞新的
worktree 工作") the work is done in a new git worktree.

## Background

`opencode-acp` currently ships its own copy of the compression engine in `lib/`
(`lib/compress/`, `lib/messages/`, `lib/state/`, `lib/gc/`, … — ~70 files).
`acp-kernel` (npm `acp-kernel@0.0.16`, MIT, zero runtime deps) is the same
engine extracted as a framework-agnostic library with a clean host adapter
surface:

- `createCore(ports?)` → `{ processTurn, applyCompression, defaultNodes, decompress, search, status }`
- `createInitialState()`, `defaultConfig(modelContextLimit, overrides?)`, `validateConfig()`
- Stateless re: storage — the host owns persistence; state is passed in/out each call.

`pai-acp` (`v0.1.20`) is the reference adapter: it wraps `acp-kernel` with a
small `AcpRuntime` (per-session state store + lock + config/message projection)
and is the model to follow for the OpenCode port.

## Non-goals (this PR)

- Do **not** delete the existing `lib/` engine in this PR. This PR lands the
  kernel as a dependency plus the adapter layer (`lib/kernel/`) as **additive**
  code that builds and typechecks alongside the old engine. Rewiring
  `hooks.ts`/tools and deleting the old engine happens in follow-up PRs (see
  DESIGN → Phasing). This keeps the change reviewable and never breaks the
  shipped plugin.

## Scope of this PR (Phase 1 — Foundation)

1. Add `acp-kernel` as a dependency (exact pin `0.0.16`) and inline-bundle it
   via `tsup` `noExternal` (published tarball must stay self-contained, matching
   the `context-compress-algorithms` precedent).
2. Add `NOTICE` attribution for the bundled MIT `acp-kernel`.
3. Add `lib/kernel/` adapter package:
   - `runtime.ts` — `AcpCoreRuntime`: owns `createCore`, a per-session
     `CompressionState` store (with async lock), config resolver, message
     projection entry points (`stateFor` / `save`).
   - `config.ts` — `resolveKernelConfig(PluginConfig, modelContextLimit)`:
     maps the existing 3-layer `PluginConfig` onto the kernel `Config`
     (incl. nudge thresholds, protectedTools, preserve-recent, tiers, message
     filters).
   - `messages.ts` — `withPartsToCoreMessages` (OpenCode `WithParts[]` →
     `CoreMessage[]`) and the inverse reconstruction helper.
   - `state.ts` — persist the kernel `CompressionState` under
     `plugin/acp-kernel/{sessionId}.json`, with a forward-compatible load
     (merge missing fields from `createInitialState()`), plus a **detector**
     that recognizes the legacy `plugin/acp/{sessionId}.json` SessionState so a
     later migration PR can convert it.
   - `index.ts` — barrel.
4. Verify `npm run typecheck`, `npm run build`, and `npm run test` all pass
   (existing suite must remain green — nothing in the old engine is touched).

## Acceptance criteria

- [ ] `acp-kernel@0.0.16` is a dependency and is bundled into `dist/index.js`.
- [ ] `lib/kernel/` exists, exports the adapter API, and `tsc --noEmit` passes.
- [ ] Existing test suite stays green (no behavior change to the running plugin).
- [ ] `devlog/2026-08-05_acp-kernel/{REQ,DESIGN,WORKLOG}.md` present.

## Follow-up PRs (tracked here, NOT done in this PR)

- **Phase 2**: rewire `lib/hooks.ts` message-transform to call
  `runtime.core.processTurn` and convert its output back to OpenCode messages;
  port the compress/decompress/search/status tools to use
  `runtime.core.applyCompression` / `decompress` / `search` / `status`.
- **Phase 3**: legacy-state migration (old `SessionState` → kernel
  `CompressionState`), then delete `lib/compress/`, `lib/messages/`,
  `lib/state/`, `lib/gc/` engine code.
- **Phase 4**: retire `dcp-` internal tags in favor of kernel tags where the
  migration plan permits (AGENTS.md §2.6 — needs a persisted-state migration).
