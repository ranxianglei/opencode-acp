/**
 * Message Filter — pluggable system for stripping/deduplicating third-party
 * plugin injections (OMO system-reminders, background task notifications, etc.)
 * from the visible context before ACP processes them.
 *
 * Filters run BEFORE assignMessageRefs, so filtered content never gets message
 * refs and is never counted toward context usage or compression triggers.
 */

/**
 * Context passed to each registered filter for a single text part.
 */
export interface MessageFilterContext {
    /** The text content of this part. */
    text: string
    /** Role of the containing message ("user" | "assistant" | "system"). */
    role: string
    /** Session ID (may be empty for ephemeral state). */
    sessionId: string
    /** Whether this is a subagent session. */
    isSubAgent: boolean
    /** 0-based index of this message in the visible messages array. */
    messageIndex: number
    /** Total number of visible messages. */
    totalMessages: number
    /** Tool name if this part is a tool call (e.g. "bash", "read"). */
    toolName?: string
    /** Model context limit (for threshold-based filtering). */
    modelContextLimit?: number
}

/**
 * Result returned by a filter for a single text part.
 */
export interface FilterResult {
    /** What to do with this text part. */
    action: "keep" | "modify" | "drop"
    /** Replacement text when action is "modify". Ignored for "keep" and "drop". */
    text?: string
    /** Human-readable reason for logging/auditing. */
    reason?: string
}

/**
 * A pluggable message filter. Filters are registered via {@link registerMessageFilter}
 * and called by {@link applyMessageFilters} during the message transform pipeline.
 *
 * Filters MUST be pure and side-effect-free: they receive a snapshot of the
 * text and return a decision. They MUST NOT mutate the input context.
 *
 * If a filter returns "drop", the text part is emptied (set to ""). If ALL
 * text parts in a message become empty after filtering, the message itself
 * is not removed (ACP's existing dropEmptyMessages handles that downstream).
 */
export interface MessageFilter {
    /** Unique name (used in config to enable/disable). */
    name: string
    /** Semver version (for breaking-change detection). */
    version: string
    /** Human-readable description. */
    description: string
    /**
     * Evaluate whether to keep, modify, or drop this text part.
     * Called once per text part per message.
     */
    filter(ctx: MessageFilterContext): FilterResult
    /**
     * When true, applyMessageFilters keeps only the most recent N matching
     * messages and drops all earlier matches. Useful for repeating directives
     * (e.g., TODO CONTINUATION) where only the latest is relevant.
     * The filter() function still runs per-part to identify matches;
     * the dedup pass then empties earlier occurrences.
     */
    keepLastOnly?: boolean
    /**
     * How many of the most recent matches to keep when keepLastOnly is true.
     * Default: 1. Set to 2+ to preserve recent notifications (e.g., background
     * task results) while still cleaning up historical accumulation.
     */
    keepLast?: number
}

/**
 * Per-filter configuration: whether the filter is enabled.
 */
export type MessageFilterConfig = Record<string, { enabled: boolean; keepLast?: number }>

/**
 * Top-level configuration for the message filter subsystem.
 */
export interface MessageFiltersConfig {
    /** Master switch. When false, no filters run. */
    enabled: boolean
    /** Per-filter enable/disable. Keys are filter names. */
    filters: MessageFilterConfig
}
