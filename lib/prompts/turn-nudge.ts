import { COMPRESSION_RULES } from "./compression-rules"

export const TURN_NUDGE = `
<system-reminder>
Context is getting full. If you've finished reading tool outputs or exploration results, compress them — you can decompress later if needed. This keeps your focus on the current task and improves accuracy.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from  tags visible above. Do NOT invent or copy example IDs.

${COMPRESSION_RULES}
</system-reminder>
`
