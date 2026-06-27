/**
 * Compression priority level assigned to a message.
 *
 * - `"critical"` — must never be compressed (protected tool results, system content)
 * - `"high"` — substantial content the model should avoid compressing
 * - `"medium"` — moderate content, compressible under pressure
 * - `"low"` — cheap to compress, first candidate when context is tight
 */
export type Priority = "critical" | "high" | "medium" | "low"
