# REQ: search_context tool

## Background & Problem Statement

When the ACP compresses content into blocks, the model loses the ability to find specific knowledge later. With hundreds of compressed blocks, the model cannot know which block contains relevant information without decompressing each one — which is impractical at scale.

The core issue: **there is no search mechanism between compression and decompression.** The model can compress (store) and decompress (retrieve), but cannot search (find).

## Solution

Add a `search_context` tool that searches through all compressed block summaries AND visible messages, returning a ranked hit list with relevance scores, previews, and retrieval instructions.

### Workflow
```
search_context("keyword") → find relevant blocks → decompress the right one
```

## Acceptance Criteria

- [x] Tool searches compressed block summaries (topic + summary text)
- [x] Tool searches visible (uncompressed) messages
- [x] Results ranked by relevance (TF-based scoring)
- [x] Results include block/message ID, topic, preview, retrieval instruction
- [x] Output limited to top N (default 10), total ≤3000 chars
- [x] Minimum relevance threshold filters weak matches
- [x] Compress output reminds model about search_context
- [ ] L2 deep search (DB full-text via SQL LIKE) — deferred
