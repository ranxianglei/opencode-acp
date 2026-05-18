export const TURN_NUDGE = `
<system-reminder>
Context is getting full. Compress closed/older conversation ranges now.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from <dcp-message-id> tags visible above. Do NOT invent or copy example IDs.
</system-reminder>
`
