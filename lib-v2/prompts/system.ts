export interface PromptContext {
    compressMode: "range" | "message"
    showCompression: boolean
    manualMode: boolean
    isSubAgent: boolean
    protectedTools: string[]
}

export function renderSystemPrompt(ctx: PromptContext): string {
    const parts: string[] = []

    parts.push(BASE_SYSTEM_PROMPT)

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

const BASE_SYSTEM_PROMPT = `You have access to a compress tool for context management.

The compress tool lets you proactively manage context by summarizing completed sections of the conversation into high-fidelity summaries. This replaces the original messages with a compact recap that preserves all essential information.

When to compress:
- When context is getting large and earlier messages are no longer immediately relevant
- After completing a multi-step task (compress the process, keep the result)
- When verbose tool outputs have been consumed and are no longer needed

What to preserve in summaries:
- Key decisions and their rationale
- File paths, function signatures, API names
- Error messages and their resolutions
- User requirements and constraints
- Critical code snippets or configurations

What NOT to compress:
- User instructions that are still being followed
- Pending or in-progress tool calls
- Content referenced by current work`

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
