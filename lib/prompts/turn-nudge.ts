import { HOW_TO_COMPRESS_RULES } from "./compression-rules"

export const TURN_NUDGE = `
<system-reminder>
Context is getting full. If you've finished reading tool outputs or exploration results, compress them — you can decompress later if needed. This keeps your focus on the current task and improves accuracy.

{
  "topics": [
    { "topic": "Short Label", "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }] }
  ]
}

Compress everything ready in one call (add more \`topics\` entries). Do NOT split into multiple compress calls.

⚠️ ONLY use IDs from  tags visible above. Do NOT invent or copy example IDs.

${HOW_TO_COMPRESS_RULES}
</system-reminder>
`
