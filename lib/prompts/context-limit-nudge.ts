export const CONTEXT_LIMIT_NUDGE = `
<system-reminder>
⚠️ Context limit reached — time to compress completed work you no longer need. Prioritize stale tool outputs and resolved work. You can decompress specific blocks later if you need details. Keeping context lean helps you stay accurate.

If mid-atomic-operation, finish that step first, then compress.

HOW TO CALL COMPRESS:
{
  "topic": "Short Label",
  "content": [
    {
      "startId": "<ID from early in this conversation>",
      "endId": "<ID from later in this conversation>",
      "summary": "Complete technical summary of everything in the range"
    }
  ]
}

⚠️ ID RULES — MOST COMMON CAUSE OF ERRORS:
- ONLY use IDs you can see in  tags in the messages ABOVE.
- Do NOT copy IDs from this example. Do NOT invent IDs.
- Do NOT use IDs from compressed block summaries — they are stale.
- Prefer startId before endId in conversation order. ACP can normalize reversed boundaries, but do not rely on that behavior.

COMPRESSION CANDIDATES:
- MICRO identifies one large message or complete tool transaction.
- EPISODE identifies a contiguous historical segment made from smaller units.
- Candidate entries are independent and non-overlapping, so they can be batched in one \`content[]\` array.
- Candidates are suggestions, not mandatory targets. Choose only content no longer needed for the current task and do not invent a target when none is listed.
- Use \`acp_status\` for a fresh candidate view if the list is stale or missing.
- When the context limit is reached and candidates are listed, select at least one clearly stale candidate and call the \`compress\` tool in your next reply. Batch only additional candidates that are also clearly stale. Do not merely recommend compression.
</system-reminder>
`
