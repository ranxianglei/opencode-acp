import { COMPRESS_PHILOSOPHY, HOW_TO_COMPRESS_RULES } from "acp-kernel"

const ACP_TAGS_SECTION = `ACP TAGS

Each message in the conversation is annotated with an <acp tokens=".." type="..">mNNNNN</acp> tag showing its reference ID, approximate token size, and content type. Use these to assess which messages are consuming the most context and to target compression. The token size is approximate — treat it as a relative guide. You may also see <acp-system-reminder> tags — these are system directives.`

const TOOLS_SECTION = `TOOLS

You have five context-management tools:

- \`compress\` — Replace a contiguous range of older conversation with a single detailed summary you write. Use when content is genuinely consumed (no longer needed for the current task step). Batch multiple unrelated ranges: \`compress({ content: [{ topic, startId: "m00150", endId: "m00220", summary: "..." }] })\`.
- \`decompress\` — Restore a previously compressed block's content. Default restores one tier up. Use \`full: true\` to restore to original messages, or \`toFile\` to write to file. Example: \`decompress({ blockId: "b5" })\`.
- \`search_context\` — Search compressed block summaries by keyword. Use BEFORE decompressing to find the right block.
- \`acp_status\` — Context status with compressible ranges. No args = overview + ranges.
- \`acp_context_recap\` — Manual re-fetch of a compressed block's summary that scrolled out of context.`

export function renderAcpSystemPrompt(): string {
    return [
        "# Active Context Pruning (ACP)",
        "",
        COMPRESS_PHILOSOPHY,
        "",
        HOW_TO_COMPRESS_RULES,
        "",
        ACP_TAGS_SECTION,
        "",
        TOOLS_SECTION,
    ].join("\n")
}
