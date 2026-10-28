const CANDIDATE_GUIDANCE_SECTION = `CANDIDATE GUIDANCE
ACP may display a \`COMPRESSION CANDIDATES\` list in a nudge or \`acp_status\` report. A \`MICRO\` entry targets one large message or complete tool transaction; an \`EPISODE\` entry targets a contiguous historical segment. Displayed candidates are independent and non-overlapping, so they may be batched, but they are advisory: compress only entries whose content is no longer needed. When a nudge lists a clearly stale candidate, use its exact IDs and call \`compress\` before continuing. Keep current intent and active work visible, and use \`acp_status\` when the candidate list is stale.`

/**
 * Build the range-mode compress tool prompt.
 *
 * candidatesEnabled mirrors `compress.candidates`: false omits the CANDIDATE
 * GUIDANCE section (behavior identical to pre-candidate master), true includes it.
 */
export function buildCompressRangePrompt(candidatesEnabled: boolean): string {
    const candidateGuidanceBlock = candidatesEnabled ? `${CANDIDATE_GUIDANCE_SECTION}\n\n` : ""

    return `Collapse a range in the conversation into a detailed summary.

COMPRESSED BLOCK PLACEHOLDERS
The system auto-detects any previously compressed blocks whose anchor messages fall inside your selected range. You do NOT need to manually list \`(bN)\` placeholders in your summary — every consumed block is tracked automatically.

Compressed block sections in context are clearly marked with a header:

- \`[Compressed conversation section]\`

Rules:

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

- IDs must exist in the current visible context. If you cannot see an ID in the messages above, it is stale and will fail.
- Prefer \`startId\` before \`endId\` in conversation order. ACP can normalize reversed boundaries, but do not rely on that behavior.
- NEVER use IDs from compressed block summaries, previous nudges, or your own memory — only IDs currently visible as XML metadata tags in the conversation.

BATCHING
When multiple independent ranges are ready and their boundaries do not overlap, include all of them as separate entries in the \`content\` array of a single tool call, each with its own \`startId\`, \`endId\`, and \`summary\`. Give each entry its own \`topic\` when the ranges cover unrelated topics; otherwise omit per-entry topics and set the top-level \`topic\` once.

${candidateGuidanceBlock}KEEP AND REF MARKERS
When writing a summary, you may embed markers that reference specific messages in the compressed range. The system resolves them automatically:

- \`[[KEEP:mNNNNN]]\` — Expands to the original message content inline (truncated to a max length). Use sparingly for critical content you want preserved verbatim without re-typing it: key definitions, important errors, essential file contents.
- \`[[REF:mNNNNN|short description]]\` — Creates a compact link like \`[→ m00065: key function definition]\`. Does not expand — use for content the reader can decompress later if needed.

Prefer REF over KEEP: each KEEP expansion adds to the summary length.
`
}

/** Bundled range-mode compress prompt with candidate guidance enabled. */
export const COMPRESS_RANGE = buildCompressRangePrompt(true)
