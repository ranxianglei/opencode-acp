import { HOW_TO_COMPRESS_RULES } from "./compression-rules"

export const ITERATION_NUDGE = `
<system-reminder>
You've been iterating for a while. If any earlier work is closed and unlikely to be referenced, compress it now.

{
  "topics": [
    { "topic": "Short Label", "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }] }
  ]
}

Compress everything ready in one call (add more \`topics\` entries). Do NOT split into multiple compress calls.

⚠️ ONLY use IDs from <dcp-message-id> tags visible above. Do NOT invent or copy example IDs.

${HOW_TO_COMPRESS_RULES}
</system-reminder>
`
