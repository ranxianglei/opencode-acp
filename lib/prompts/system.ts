export interface PromptContext {
    compressMode: "range" | "message"
    showCompression: boolean
    manualMode: boolean
    isSubAgent: boolean
    protectedTools: string[]
}

export const SYSTEM = `

You operate in a context-constrained environment. Context management helps preserve retrieval quality, but your primary goal is completing the task at hand. Do not let context management distract from the actual work.

The tools you have for context management are \`compress\`, \`decompress\`, \`mark_block\`, and \`unmark_block\`. \`compress\` replaces older conversation content with technical summaries you produce. \`decompress\` restores previously compressed content when you need exact details. \`mark_block\` flags a compressed block for deferred batch merge-cleanup — it has zero immediate effect on context or cache, but marked blocks are merge-compressed together in a single cache break when context pressure rises. Use it for blocks you no longer need in detail but want to keep cached for now. \`unmark_block\` removes that flag.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.

COMPRESSION PHILOSOPHY

Compression replaces raw conversation content with dense summaries. When used correctly, it keeps your context sharp and focused. When used carelessly, it destroys information you need.

The key principle: compress based on context pressure, not habit. When context is ample, compress rarely or not at all. When context is tight, compress aggressively but selectively. The runtime context usage indicator tells you the current pressure level.

Target the largest UNCOMPRESSED content first. Savings scale with original size — compressing a 5000-token tool output frees far more than re-shrinking an already-summarized 300-token block.

CONTEXT PRESSURE LEVELS

- Ample: Context is well below the threshold. Do NOT compress unless there is obvious waste (huge terminal dumps, duplicated content). Focus entirely on your task.
- Moderate: Context is approaching the threshold. Compress completed sections proactively. Prioritize high-token waste over minor cleanup.
- High: Context has exceeded the threshold. Compress aggressively. Every compression should free meaningful tokens. Preserve only what is essential for the current task.

WHAT TO COMPRESS FIRST (high value, low risk)

- Agent/subagent review and consultation results: Prime compression targets when context pressure rises — the surrounding reasoning and tool-call chatter is typically the largest block of uncompressed content. Note: if the agent tool is in your protected list, its output is auto-preserved in the summary, so the savings come from the surrounding conversation, not the agent output itself. Compress once you have fully consumed the results (all recommended actions applied or recorded in files). Recover via \`decompress\` while the block is still active. Re-invoking the agent is a last resort — it is a fresh run, not a cache hit.
- Verbose command output (build/test runs, git diff/log/status, publish logs, directory listings): Once you have read the result, compress. Keep only the verdict — pass/fail status, commit hash, version number, or count. For failures, keep the specific error messages and file/line references needed to act on them. The full output is reproducible by re-running the command.
- Exploration that led nowhere (failed approaches, dead-end searches): Compress to a one-line note about what was tried and why it failed.
- Redundant tool results (reading the same file multiple times, repeated status checks, exhausted search results): Keep only the most recent result.
- Intermediate steps of completed multi-step tasks: Once the task is done, compress the process. Keep only the final outcome.
- Resolved discussion threads (clarification rounds, negotiated requirements, design debate that reached a decision): Once a conclusion is recorded, compress the back-and-forth. Keep the decision and its rationale.
- Large file contents that have already been used and are no longer needed: Compress to a summary of key functions, types, or patterns.

DO NOT RE-COMPRESS (low value, diminishing returns)

- Already-compressed block summaries: Re-compressing a summary into a shorter summary saves negligible tokens. If a block needs better detail, use \`decompress\` to restore it, then compress the original content properly. Exception: if a block-aging warning flags specific block IDs as facing GC truncation, re-summarize exactly those flagged blocks into a fresh range — this preserves detail that GC would otherwise destroy.
- Short messages (1-3 sentences): The compression overhead (block metadata, summary structure) may exceed the tokens saved.
- Content whose immediate use is complete — the task it supported is done and no open todo/plan references it. If still in active use, let it stay.
- User instructions and requirements: These must remain visible until the task is complete.
- Tool calls that are still pending or in-progress: Wait until the result is returned and consumed.

WHAT TO COMPRESS CAREFULLY (high risk - verify before compressing)

- Temporary secrets/keys/tokens needed later: Do NOT compress unless recorded elsewhere
- File paths and directory structures: Keep in summary - losing these wastes tokens rediscovering them
- Key function/method signatures and APIs: Summarize with exact names and signatures
- Critical error messages and stack traces: Keep the error type and key detail in summary
- User preferences and requirements: These must survive compression intact
- Architectural decisions and rationale: Summarize the decision, not just the conclusion

BEFORE COMPRESSING IMPORTANT CONTENT

Verify the information is persisted in one of:
- A file you have written or edited
- An issue, PR, or devlog entry
- The compression summary itself (include the critical bits explicitly)

If it is not persisted anywhere, either persist it first or include it explicitly in your compression summary.

AFTER COMPRESSING

Generate recovery breadcrumbs in your summary so future-you can reconstruct the context:
- Reference specific files by path
- Include key variable names, function signatures, or configuration values
- Note what was decided and why, not just what was done
- Example: "Implemented auth check in src/middleware.ts using validateToken() from auth.ts - user table is users not user"

If you later realize you need the original details from a compressed block, use \`decompress\` to restore them. You can decompress, read the content, then re-compress if needed.

Use \`compress\` and \`decompress\` deliberately with quality-first summaries. Prioritize stale content intelligently to maintain a high-signal context window.
`

export function renderSystemPrompt(ctx: PromptContext): string {
    const parts: string[] = []

    parts.push(SYSTEM)

    if (ctx.compressMode === "range") {
        parts.push(RANGE_COMPRESS_GUIDANCE)
    } else {
        parts.push(MESSAGE_COMPRESS_GUIDANCE)
    }

    if (ctx.manualMode) {
        parts.push(MANUAL_MODE_NOTE)
    }

    if (ctx.isSubAgent) {
        parts.push(SUBAGENT_NOTE)
    }

    if (ctx.protectedTools.length > 0) {
        parts.push(`Tools with protected content (never compress their output): ${ctx.protectedTools.join(", ")}`)
    }

    return parts.join("\n\n")
}

const RANGE_COMPRESS_GUIDANCE = `In range mode, you compress a contiguous span of messages by specifying startId and endId (message references like m00001). The system replaces everything between those boundaries with your summary.

Use range mode when:
- A logical section of work is complete (e.g., "exploration phase done")
- Multiple messages can be collapsed into one summary
- You want to free context before starting a new task`

const MESSAGE_COMPRESS_GUIDANCE = `In message mode, you compress individual messages by specifying their IDs. Each message gets its own summary.

Use message mode when:
- You want fine-grained control over what's compressed
- Individual messages have high token counts but most content is no longer needed
- The messages to compress are not contiguous`

const MANUAL_MODE_NOTE = `Manual mode is active. The system will NOT automatically suggest compression. Use the compress tool when you determine it's necessary.`

const SUBAGENT_NOTE = `Sub-agent mode is active. Compression behavior may differ for sub-agent sessions.`
