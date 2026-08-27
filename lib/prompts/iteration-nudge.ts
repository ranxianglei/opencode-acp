export const ITERATION_NUDGE = `
<system-reminder>
You've been iterating for a while. Before continuing another iteration, compress one clearly completed candidate when available. Things that are still active and information you need can stay, but be sure to clean up content no longer needed when available.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from  tags visible above. Do NOT invent or copy example IDs.

MICRO candidates are complete large messages or tool transactions. EPISODE candidates are contiguous historical segments. They are independent suggestions and may be batched, but preserve anything still needed for the current task. Do not compress active work or every candidate.
</system-reminder>
`
