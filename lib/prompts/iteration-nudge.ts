export const ITERATION_NUDGE = `
<system-reminder>
You've been iterating for a while. If any earlier work is closed and unlikely to be referenced, compress it now.

{
  "topic": "Short Label",
  "content": [{ "startId": "<visible message ID>", "endId": "<visible message ID>", "summary": "..." }]
}

⚠️ ONLY use IDs from  tags visible above. Do NOT invent or copy example IDs.
</system-reminder>
`

/**
 * Candidate-mode guidance appended to the iteration nudge when
 * `compress.candidates` is enabled.
 */
export const ITERATION_CANDIDATE_GUIDANCE = `
MICRO candidates are complete large messages or tool transactions. EPISODE candidates are contiguous historical segments. They are independent suggestions and may be batched, but preserve anything still needed for the current task. Do not compress active work or every candidate.
`
