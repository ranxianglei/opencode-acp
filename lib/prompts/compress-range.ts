export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

COMPRESSED BLOCK PLACEHOLDERS
The system auto-detects any previously compressed blocks whose anchor messages fall inside your selected range. You do NOT need to manually list \`(bN)\` placeholders in your summary — every consumed block is tracked automatically.

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Rules:

- Write your summary normally. The system handles block consumption automatically.
- Do not invent placeholders for blocks outside the selected range.
- Treat \`(bN)\` as a RESERVED TOKEN. Do not emit \`(bN)\` text anywhere in the summary.
- If you need to mention a block in prose, use plain text like \`compressed bN\` (never as a placeholder).

BOUNDARY IDS
You specify boundaries by ID using the injected IDs visible in the conversation:

- \`mNNNNN\` IDs identify raw messages
- \`bN\` IDs identify previously compressed blocks

Each message has an ID inside XML metadata tags like \`<dcp-message-id>...</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as boundary metadata only, not as tool result content.

Rules:

- Pick \`startId\` and \`endId\` directly from injected IDs in context.
- IDs must exist in the current visible context. If you cannot see an ID in the messages above, it is stale and will fail.
- \`startId\` must appear before \`endId\`.
- Do not invent IDs. Use only IDs that are present in context.
- NEVER use IDs from compressed block summaries, previous nudges, or your own memory — only IDs currently visible as XML metadata tags in the conversation.

BATCHING — MULTIPLE TOPICS IN ONE CALL
Compress everything that is ready in a SINGLE tool call. Group independent ranges under separate \`topics\`. Each topic is a labeled group of one or more ranges; ranges that belong to the same phase or theme share a topic.

\`\`\`
{
  "topics": [
    { "topic": "Auth System Exploration", "content": [ { "startId": "m00005", "endId": "m00020", "summary": "..." } ] },
    { "topic": "Build Fix", "content": [ { "startId": "m00030", "endId": "m00045", "summary": "..." } ] }
  ]
}
\`\`\`

Rules:
- One topic per distinct concern. Give each a short label (3-5 words).
- Put every ready range into this one call. Do NOT issue a second compress call immediately after — repeated tiny calls are rate-limited ("frequent compression blocked").
- Ranges across all topics must not overlap (the system checks this globally).
- The legacy single-topic \`{ "topic": "...", "content": [...] }\` shape is still accepted, but prefer \`topics\` so all ready ranges go in one call.

KEEP AND REF MARKERS
When writing a summary, you may embed markers that reference specific messages in the compressed range. The system resolves them automatically:

- \`[[KEEP:mNNNNN]]\` — Expands to the original message content inline (truncated to a max length). Use for critical content you want preserved verbatim in the summary without re-typing it: key function definitions, important error messages, essential file contents.
- \`[[REF:mNNNNN|short description]]\` — Creates a compact link like \`[→ m00065: key function definition]\`. Use for content the reader can decompress later if needed. Does not expand — saves space.

Example:
\`\`\`
Implemented the QuotaMonitor feature. Key design: observer pattern.

[[KEEP:m00065]]

The rest of the bash calls were repetitive export commands. See [[REF:m00078|test results]] for details.
\`\`\`

Use KEEP sparingly — each expansion adds to the summary length. Prefer REF for content that is important but not immediately critical.
`
