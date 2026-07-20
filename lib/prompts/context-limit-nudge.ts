import { HOW_TO_COMPRESS_RULES } from "context-compress-algorithms/prompts"

export const CONTEXT_LIMIT_NUDGE = `
<system-reminder>
⚠️ Context limit reached — time to compress the largest ranges you no longer need. Prioritize completed tool outputs and resolved work. You can decompress specific blocks later if you need details. Keeping context lean helps you stay accurate.

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
- startId must appear BEFORE endId in the conversation.

${HOW_TO_COMPRESS_RULES}

RANGE STRATEGY:
- Prefer one large range over multiple small ones.
- Compress OLDER resolved history first. Keep recent active work.
</system-reminder>
`
