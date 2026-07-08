import { COMPRESSION_RULES } from "./compression-rules"

export const ITERATION_NUDGE = `
<system-reminder>
You've been iterating for a while. If any earlier work is closed and unlikely to be referenced, compress it now.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from <dcp-message-id> tags visible above. Do NOT invent or copy example IDs.

${COMPRESSION_RULES}
</system-reminder>
`
