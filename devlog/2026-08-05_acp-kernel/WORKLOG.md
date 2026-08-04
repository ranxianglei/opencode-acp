# WORKLOG — opencode-acp → acp-kernel (Phase 1 foundation)

Issue: dog/opencode-acp#42 · Branch: `2026-08-05_acp-kernel`
Worktree: `/home/dog/projects/opencode-acp-kernel`

## Investigation

- Surveyed the three sibling projects under `~/projects`:
  `acp-kernel` (engine lib, MIT, v0.0.16 on npm, zero runtime deps),
  `pai-acp` (reference adapter, v0.1.20), `opencode-acp` (target, v1.14.8).
- Read acp-kernel `compress.ts` (`createCore`), `types.ts`
  (`CompressionState`/`Config`/`CoreMessage`), `index.ts` (exports).
- Read pai-acp `runtime.ts`/`config.ts`/`messages.ts`/`state.ts` (adapter
  templates: per-session lock, config resolver, message projection, atomic
  state persistence, forward-compat load).
- Read opencode-acp `lib/state/types.ts` (`SessionState` — richer/older shape,
  `blockId: number`, Map-based prune/nudges), `lib/message-ids.ts` (Part kind
  detection: `text`/`tool`/`reasoning`; m-ref format `m\d{4,5}`), `lib/config.ts`
  (`PluginConfig` shape), `index.ts` (hook wiring), `tsup.config.ts`.
- Confirmed acp-kernel is published (`npm view acp-kernel` → 0.0.16).

## Decision

Phased migration (see DESIGN.md §9). This PR = **Phase 1 foundation only**:
add acp-kernel + an additive `lib/kernel/` adapter. No behavior change, nothing
rewired, old engine untouched. Keeps the shipped plugin safe and the diff
reviewable; rewiring + state migration + old-engine deletion move to follow-ups.

## Work performed

(to be filled as commits land)

- `devlog/2026-08-05_acp-kernel/{REQ,DESIGN,WORKLOG}.md`
- `package.json` — add `acp-kernel@0.0.16`; bundle via tsup `noExternal`
- `tsup.config.ts` — `noExternal: […, "acp-kernel"]`
- `NOTICE` — acp-kernel MIT attribution
- `lib/kernel/{config,messages,runtime,state,index}.ts` — adapter (additive)
- `npm run typecheck` / `build` / `test` — green

## Verification

- `npm install` — acp-kernel@0.0.16 installed; ESM `import * from "acp-kernel"` resolves.
- `npm run typecheck` — **PASS** (0 errors).
- `npm run build` — **PASS** (tsup ESM bundle 384 KB + `.d.ts`).
- `npm run test` — **PASS** (942 tests, 0 fail). No behavior change — old engine untouched.
- Bundling: `tsup.config.ts` `noExternal` lists `acp-kernel`. Because Phase 1 is purely
  additive (`lib/kernel/` is not yet imported by `index.ts`), tsup tree-shakes the
  adapter + kernel out of `dist/index.js` for now — expected. Phase 2 imports
  `lib/kernel/runtime` from the hook path, at which point `noExternal: ["acp-kernel"]`
  inlines the engine into the published bundle (same mechanism as
  `context-compress-algorithms`). Confirmed: zero `from "acp-kernel"` external imports
  remain when the adapter is reachable.

## Open items for follow-up PRs

- Phase 2: rewire `lib/hooks.ts` + tools to `lib/kernel/runtime`.
- Phase 3: legacy `SessionState` → kernel `CompressionState` converter; delete
  old engine.
- Phase 4: `dcp-` tag retirement (persisted-state migration plan).
