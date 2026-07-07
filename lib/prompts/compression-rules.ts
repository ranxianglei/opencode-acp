/**
 * Condensed compression rules — the "just-in-time" version of HOW TO COMPRESS.
 *
 * The full rules live in the system prompt (system.ts HOW TO COMPRESS section).
 * But the system prompt is far from the action — by the time the model actually
 * compresses (dozens of turns later), the rules may have faded from attention.
 *
 * This constant is injected into compress nudges (context-limit, turn, iteration)
 * so the model sees the rules at the exact moment it's told to compress.
 * This closes the gap between "when to compress" (nudge) and "how to compress" (rules).
 */
export const COMPRESSION_RULES = `COMPRESSION FORMAT — your summary becomes the only record. Make it self-contained.
KEEP VERBATIM: file paths+lines, function signatures + critical code lines, error messages (exact text), decisions + rationale ("chose X because Y" — the "because" is load-bearing), constraints, exact values, user intent (quote short messages), open TODOs, message refs of key anchors.
DROP: verbose logs (keep error/result line only), duplicate reads, consumed tool outputs, dead-ends (but preserve lesson: "tried X, failed because Y"), back-and-forth (keep outcome only).
PRIORITY when tight: 1) user intent + constraints 2) decisions + rationale 3) exact artifacts 4) conclusions 5) lessons.
Write dense, scannable bullets — not prose.`
