export const CONTEXT_LIMIT_NUDGE = `
<system-reminder>
⚠️ CRITICAL: Context limit reached. You MUST use the \`compress\` tool NOW.

If mid-atomic-operation, finish that step first, then compress immediately.

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
- ONLY use IDs you can see in <dcp-message-id> tags in the messages ABOVE.
- Do NOT copy IDs from this example. Do NOT invent IDs.
- Do NOT use IDs from compressed block summaries — they are stale.
- startId must appear BEFORE endId in the conversation.

SUMMARY RULES:
- Capture ALL essential details: file paths, decisions, constraints, key findings.
- Preserve user intent exactly. Direct-quote short user messages.
- Prefer one large range over multiple small ones.
- Compress OLDER resolved history first. Keep recent active work.
</system-reminder>
`
