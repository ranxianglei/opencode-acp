# WORKLOG: search_context tool

## Changes

### Commit 82df13c — Initial implementation

- **NEW** `lib/compress/search.ts` (~120 lines): `createSearchContextTool(ctx)` — searches `state.prune.messages.blocksById` by keyword, returns ranked results with block ID, topic, preview, relevance score
- **MOD** `lib/compress/index.ts`: Added `export { createSearchContextTool }`
- **MOD** `index.ts`: Registered `search_context: createSearchContextTool(compressToolContext)` in tool section, added to `toolsToAdd`
- **MOD** `lib/prompts/system.ts`: Added search_context to tool description

### Commit 38fc2c2 — Improvements

- **MOD** `lib/compress/search.ts`: TF-based scoring (topic match ×0.15, summary match ×0.04, phrase bonus ×2), minimum relevance threshold (0.10), `deep` parameter in schema (L2 DB search deferred)
- **MOD** `lib/compress/range.ts`: Added search_context reminder to compress output (`💡 Tip: Use search_context('keyword')...`)
- **MOD** `tests/compress-range.test.ts`: Updated assertions for new compress output format

## Design Decisions

1. **L1 summary search only (L2 deferred)**: Searches block topic + summary text. Fast, in-memory. L2 (SQL full-text on original messages) deferred for future iteration.
2. **Relevance scoring**: Topic matches weighted 3.75× higher than summary matches (topic is curated, summary is verbose). Phrase (multi-word) matches get 2× bonus.
3. **Result limit**: Top 10 results, each preview ≤200 chars, total output ≤3000 chars. Prevents context bloat from search results.
4. **No external dependencies**: Pure text matching, no embedding model or vector DB needed.

## Testing

- `npm run typecheck`: clean ✅
- `npm run test`: 486 pass, 0 fail ✅
- Manual test: `search_context("代理账号 proxy account")` → found 10 relevant blocks, scores differentiated (0.55→0.12)
- Manual test: `search_context("标题不生成 title generation")` → found b2 (0.39), decompressed successfully, extracted root cause
