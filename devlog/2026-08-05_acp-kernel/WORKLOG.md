# WORKLOG — opencode-acp 内核换成 acp-kernel (one-shot rewrite)

Issue: dog/opencode-acp#42 · Branch: `2026-08-05_acp-kernel`
Worktree: `/home/dog/projects/opencode-acp-kernel`

## Investigation

- Surveyed the three sibling projects under `~/projects`:
  `acp-kernel` (engine lib, MIT, v0.0.16 on npm, zero runtime deps),
  `pai-acp` (reference adapter, v0.1.20), `opencode-acp` (target, v1.14.12).
- Read acp-kernel `src/` (25 modules): `compress.ts` (`createCore`),
  `types.ts` (`CompressionState`/`Config`/`CoreMessage`), `index.ts` (exports),
  `pipeline.ts`, `render-refs.ts`, `nudge-text.ts`, `boundaries.ts`.
- Read pai-acp `runtime.ts`/`config.ts`/`messages.ts`/`state.ts`/`index.ts`
  (adapter templates: per-session lock, config resolver, message projection,
  atomic state persistence, forward-compat load).
- Read opencode-acp `lib/hooks.ts` (SDK hook contracts + pipeline),
  `lib/state/types.ts` (`SessionState`), `lib/token-utils.ts`, `index.ts`.

## Decision (revised per issue feedback)

**Originally** proposed a 4-phase migration (see DESIGN.md §9). **User @dog
rejected** phasing on issue #42:

> 我建议一步到位即可 没必要分步骤 反而会引入很多 bug 建议你直接新开一个全新的 然后基于内核重新实现 然后基本功能通过微调对齐

→ Switched to a **one-shot fresh rewrite**: build a brand-new kernel-backed
adapter under `lib/kernel/`, rewire `index.ts` to use it exclusively, and leave
the old in-tree engine on disk as dead code (tree-shaken from the published
bundle). Basic functionality is aligned by tuning the kernel config; no
incremental/switchover machinery (which would itself be a source of bugs).

## Architecture of the new adapter (`lib/kernel/`)

| Module | Responsibility |
|--------|---------------|
| `messages.ts` | `withPartsToCoreMessages` (OpenCode `WithParts[]` → kernel `CoreMessage[]`; completed tool part → tool-call + tool-result cores sharing `toolCallId`) + `reconstructMessages` (kernel output → `WithParts[]`, burns `<acp>` ref tags back onto originals, rebuilds multi-call assistant messages). |
| `config.ts` | `resolveKernelConfig` (PluginConfig → kernel `Config` via `defaultConfig`; force-protects `compress`; maps growth thresholds). |
| `state.ts` | `load/saveKernelState` to `plugin/acp-kernel/{sessionId}.json` (atomic tmp+rename), forward-compat `mergeInitialState`, `detectLegacyState` for old `plugin/acp/`. |
| `runtime.ts` | `createCoreRuntime` → `AcpCoreRuntime` (`createCore(countTokens)`, per-session `stateFor`, `save`, `configFor`, promise-chain `acquireLock`, `invalidate`). |
| `system-prompt.ts` | `renderAcpSystemPrompt` = `COMPRESS_PHILOSOPHY` + `HOW_TO_COMPRESS_RULES` + tag/tools sections. |
| `hooks.ts` | 5 SDK hook handlers: `createSystemPromptHandler`, `createChatMessageTransformHandler` (the core integration — `processTurn` + reconstruct + nudge inject), `createTextCompleteHandler`, `createCommandExecuteHandler`, `createEventHandler`. |
| `tools.ts` | 4 tools: compress (→ `applyCompression`), decompress, search_context, acp_status. |
| `commands.ts` | `handleAcpCommand` → `/acp` + `/dcp` (back-compat) via model-invisible prompt. |
| `index.ts` | Barrel. |

`index.ts` (entry) imports **only** from `lib/kernel/` + shared infra
(`lib/config.ts`, `lib/host-permissions.ts`, `lib/logger.ts`, `lib/auth.ts`,
`lib/update.ts`, `lib/token-utils.ts`). The old engine
(`lib/hooks.ts`, `lib/compress/`, `lib/messages/`, `lib/state/` engine,
`lib/gc/`, `lib/prompts/`, `lib/commands/`, `lib/ui/`) is **no longer
imported** and is tree-shaken out of `dist/`.

## Work performed

- `package.json` — add `acp-kernel@0.0.16` (devDep, pinned exact).
- `tsup.config.ts` — `noExternal: […, "acp-kernel"]` (inline into bundle).
- `NOTICE` — acp-kernel MIT attribution.
- `lib/kernel/{messages,config,state,runtime,system-prompt,hooks,tools,commands,index}.ts` — fresh adapter.
- `lib/token-utils.ts` — `SessionState` import switched to `import type` (a value import pulled `lib/state` barrel → `SessionStateRegistry` class leaked into dist as runtime code).
- `index.ts` — rewired to kernel-backed hooks/tools.
- `tests/kernel-smoke.test.ts` — 7 tests covering the message projection → `processTurn` → `applyCompression` → `reconstruct` round-trip.

## Verification

- `npm install` — acp-kernel@0.0.16 installed; ESM `import * from "acp-kernel"` resolves.
- `npm run typecheck` — **PASS** (0 errors).
- `npm run build` — **PASS** (single ESM bundle `dist/index.js` 175.53 KB + `.d.ts`).
- `npm run test` — **PASS** (961 tests, 0 fail: 954 existing + 7 new smoke).
- `dist/` symbol audit:
  - Kernel inlined: `processTurn` / `applyCompression` / `createCore` / `renderNudgeText` present.
  - Old engine tree-shaken: `assignMessageRefs`, `createCompressRangeTool`, `runMajorGC`, `injectCompressNudges`, `createSessionState` = 0 hits.
  - acp-kernel not external: 0 `require("acp-kernel")` / `from "acp-kernel"`.

## Key findings / gotchas (load-bearing for future tuning)

- **`preserveRecentTokens` over-protection**: acp-kernel's `computeProtectedRefs`
  protects the last `preserveRecentMessages` **and** accumulates backward from
  the end up to `preserveRecentTokens`. `resolveKernelConfig` defaults the token
  window to `compress.preserveRecentTokens ?? 5000` (correct for production where
  messages are large). With tiny smoke-test messages, 5000 tokens over-protects
  everything, so the smoke test uses `preserveRecentTokens: 0`.
- **Reconstruction tag source**: the `<acp …>mNNNNN</acp>` ref tag must be
  extracted from the **burned `CoreMessage.text`**, not from
  `state.messageRefs.byRaw` — because the kernel splits one tool-bearing
  `WithParts` message into multiple `CoreMessage`s with composite ids
  (`{baseId}#{callID}`, `{baseId}#{callID}#result`) that are not present under
  the bare `baseId` key.
- **`ToolResult` shape**: OpenCode tool return values use
  `string | { title?, output: string, metadata?, attachments? }` — the object
  form **requires** an `output` field.
- **Nudge injection**: appended as an extra text `Part` to the last surviving
  user message (or a synthetic user message when none survives), matching the
  OpenCode SDK pattern of user-role text for system guidance.

## Open items (follow-up PRs)

- `git rm` the orphaned old engine (`lib/compress/`, `lib/messages/`, `lib/state/`
  engine, `lib/gc/`, `lib/hooks.ts`, `lib/prompts/`, `lib/commands/`, `lib/ui/`)
  and the now-redundant tests once the kernel path is validated in production.
- Deploy locally (`scripts/dev-deploy.sh`) and smoke-test the live plugin end to
  end before the next release.
- Align nudge cadence / protected-tools / notification UX to the old engine's
  behaviour where users depend on it (tuning, not structural).
