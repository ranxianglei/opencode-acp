/**
 * Full compression rules — the single source of truth for HOW TO COMPRESS.
 *
 * Imported and interpolated into:
 * - system.ts (system prompt)
 * - compress-range.ts (range-mode compress tool description)
 * - compress-message.ts (message-mode compress tool description)
 *
 * This ensures all three injection points show identical rules without
 * duplication. Users who override these prompts via custom files replace
 * the entire string, losing the interpolation — that's intentional (full
 * control for advanced users).
 */
export const HOW_TO_COMPRESS_RULES = `HOW TO COMPRESS

When you call \`compress\`, the summary you write becomes the only record of the replaced conversation. Make it self-contained and complete: every user request, experiment purpose, and work task in the range must be accurately captured. A later reader (or you, after decompressing) should be able to continue the task WITHOUT needing the original.

KEEP VERBATIM — never paraphrase or abbreviate these:
- Full file paths with line numbers, directory prefix on every mention (\`lib/hooks.ts:347\`, \`src/index.ts:12-18\`, \`gatenet_v3/model.py:45\`). Never abbreviate to a bare filename (\`hooks.ts\`, \`model.py\`) — they are ambiguous and cannot be grepped or decompressed-to later.
- Function, class, and type signatures (exact names, params, return types) AND critical code lines that encode logic — the line that IS the finding, not just the function name (e.g. \`kv_keys += define_gate * a_key[i](emb)\` is more useful than "see model_kvnet.py").
- Error messages and stack traces (exact text — you need the literal string to grep for it later).
- Key details from reports and analyses — not just the conclusion. Keep the comparison numbers and the mechanism, not "X is worse" alone (write "1.76× PPL gap because KV store is static", not "KVNet underperforms").
- Decisions and their rationale ("chose X over Y because Z" — the "because" is load-bearing; without it the decision looks arbitrary).
- Constraints discovered ("must support Node 22", "no new dependencies", "AGENTS.md forbids \`as any\`").
- Exact values: versions, config keys, thresholds, magic numbers.
- User intent — quote short user messages verbatim. When the message is too long to quote, preserve intent with extra care: do not change scope, constraints, priorities, acceptance criteria, or requested outcomes. Mark them clearly as past quotes (e.g., "User said: ..."), not as current directives. Losing these changes the task itself.
- The user's overall goal and any changes to it — the big-picture objective plus how it evolved during the compressed range. Each summary must reflect the goal as it stood at the end of the range, including pivots (e.g., "initially: fix bug X → pivoted to: refactor module Y after discovering root cause"). Losing the goal or its evolution makes all subsequent work appear unmotivated.
- Purpose behind each significant action — preserve not just what was done but why: the hypothesis behind each experiment, the question behind each exploration, the task goal behind each work action. Without purpose, the summary reads as disconnected technical steps with no through-line.
- Open questions and unresolved TODOs — losing these changes what work appears to remain.
- Message refs of key anchors (\`m00420\`, \`m00510-00520\`) — they let you or a later reader jump back via decompress to the exact original.

DROP — extract the signal, discard the vessel:
- Verbose logs (build/test/\`npm\` output) once you have captured the error line or the result.
- Duplicate file reads once the needed content is recorded.
- Consumed exploration — search hits, agent return values, successful tool outputs — once you have extracted the facts you need (same rule as dead-ends, but nothing went wrong; the content is simply spent).
- Dead-end exploration — but PRESERVE the lesson in one line: "tried X, failed because Y".
- Back-and-forth discussion and self-corrections once the final position is captured (keep the outcome, drop the journey to it).
- Repeated status checks (\`git status\`, \`ls\`) once state is known.

For each significant item you DROP (scripts, reports, large analyses, long tool outputs), add a one-line CONTENT description of what it covers — not where it lives. Bad: "probe script at /path/probe_kvnet.py". Good: "probe_kvnet.py: tests n-gram baseline, generation quality, long-range dependency, position sensitivity, op pipeline, QUERY attention." This lets a later decompress target the right block by relevance, not by guessing locations.

PRIORITY — when the summary must be compact, preserve in this order:
1. User's overall goal, goal evolution, intent, and hard constraints (losing these changes the task).
2. Decisions and rationale.
3. Exact technical artifacts: paths, signatures, errors, values.
4. Conclusions and key findings.
5. Lessons learned: what failed and why.

Write dense, scannable bullets — not narrative prose. If the range spans distinct concerns (request → findings → decision), group bullets under short thematic headers so a reader can scan to the part they need. Every line must earn its place. Do not mimic the style of existing summaries in context; follow these rules.`

/**
 * Condensed compression rules — the "just-in-time" nudge version.
 *
 * Used in compress nudges (context-limit, turn, iteration) where space is
 * tighter. This is a compressed paraphrase of HOW_TO_COMPRESS_RULES above.
 */
export const COMPRESSION_RULES = `COMPRESSION FORMAT — your summary becomes the only record. Make it self-contained and complete: every user request, experiment purpose, and work task must be accurately captured.
KEEP VERBATIM: full file paths with line numbers on every mention (\`dir/file.py:45\`, never bare \`file.py\`), function signatures + critical code lines, error messages (exact text), decisions + rationale ("chose X because Y" — the "because" is load-bearing), constraints, exact values, user's overall goal + any changes to it + user intent (quote short messages) + purpose behind each action (experiment hypotheses, task goals), open TODOs, message refs of key anchors.
DROP: verbose logs (keep error/result line only), duplicate reads, consumed tool outputs, dead-ends (but preserve lesson: "tried X, failed because Y"), back-and-forth (keep outcome only).
PRIORITY when tight: 1) user goals + goal evolution + intent + purpose + constraints 2) decisions + rationale 3) exact artifacts 4) conclusions 5) lessons.
Write dense, scannable bullets — not prose.`
