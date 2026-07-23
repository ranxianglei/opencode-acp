import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "../compress/types"
import { recordMemory } from "./state"

const MEMORY_TOOL_DESCRIPTION = `Record a durable fact that must survive for the rest of the task, even after compression.

Memories are permanent — compression cannot remove them, and only an explicit forget clears them. Record sparingly: each memory consumes context forever until forgotten. See the MEMORY section of your system prompt for when to record vs. when to use a compression summary.

Args:
- topic: short label for the memory (e.g., "auth constraint", "API base URL")
- content: the load-bearing fact, with enough context to act on without the original conversation`

export function createMemoryTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: MEMORY_TOOL_DESCRIPTION,
        args: {
            topic: tool.schema.string().describe("Short label for the memory category"),
            content: tool.schema.string().describe("The durable fact to record"),
        },
        async execute(args, toolCtx) {
            const entry = recordMemory(
                ctx.state,
                toolCtx.messageID,
                args.topic,
                ctx.logger,
            )
            return `Recorded ${entry.id} [${entry.topic}]: ${args.content}\n\nThis memory is protected from compression. It will persist until explicitly forgotten via /acp memory forget ${entry.id}.`
        },
    })
}
