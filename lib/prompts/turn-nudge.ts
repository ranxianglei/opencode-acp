export const TURN_NUDGE = `
<system-reminder>
Context is getting full. If you've finished reading tool outputs or exploration results, inspect the compression candidates below and compress completed candidates (context you no longer need) before continuing when safe; you can decompress later if needed. This keeps your focus on the current task and improves accuracy.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from  tags visible above. Do NOT invent or copy example IDs.

MICRO candidates are complete large messages or tool transactions. EPISODE candidates are contiguous historical segments. They are independent suggestions and may be batched, but compress only content no longer needed for the current task. Do not compress active work or every candidate.
</system-reminder>
`
