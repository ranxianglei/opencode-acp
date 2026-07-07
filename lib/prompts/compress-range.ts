export const COMPRESS_RANGE = `Collapse a range in the conversation into a detailed summary.

THE SUMMARY
Your summary must be EXHAUSTIVE. Capture file paths, function signatures, decisions made, constraints discovered, key findings... EVERYTHING that maintains context integrity. This is not a brief note - it is an authoritative record so faithful that the original conversation adds no value.

USER INTENT FIDELITY
When the compressed range includes user messages, preserve the user's intent with extra care. Do not change scope, constraints, priorities, acceptance criteria, or requested outcomes.
Directly quote user messages when they are short enough to include safely. Direct quotes are preferred when they best preserve exact meaning.

Yet be LEAN. Strip away the noise: failed attempts that led nowhere, verbose tool outputs, back-and-forth exploration. What remains should be pure signal - golden nuggets of detail that preserve full understanding with zero ambiguity.

SUMMARY STRUCTURE
Organize what remains around three points. Omit any point that has no content for this range — do not invent material to fill the template. Match depth to what is actually there: a range with no critical content yields a lean summary; a range carrying a key decision or result yields a verbatim record.

- What this range covers: describe the phase, task, or exploration in semantic terms (e.g. "the debugging phase that located the off-by-one in search.ts"), not raw message IDs.
- Critical content, transcribed: when the range contains important code, error text, report output, commands, or exact values, copy the content itself into the summary — not a pointer to where it lives. If it is critical, transcribe it verbatim.
- What is recoverable, and when: name the kind of detail you trimmed (full diffs, long logs, complete reads) and the situations in which a later step might want it back. Do not invent a block ID — you do not know this block's eventual ID. The reader locates it via acp_status or search_context when needed.

COMPRESSED BLOCK PLACEHOLDERS
The system auto-detects any previously compressed blocks whose anchor messages fall inside your selected range. You do NOT need to manually list \`(bN)\` placeholders in your summary — every consumed block is tracked automatically.

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Rules:

- Write a short prose summary. The system handles block consumption automatically.
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

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call. Each entry should have its own \`startId\`, \`endId\`, and \`summary\`.
`
