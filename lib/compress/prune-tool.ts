import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { fetchSessionMessages } from "./search"
import { finalizeSession, prepareSession } from "./pipeline"

const PRUNE_TOOL_DESCRIPTION = `Remove old tool outputs by tool type — frees context without compression.

Unlike compress (which creates summaries), prune directly strips tool call outputs from context. Use for disposable tool outputs where the content is no longer needed: old todowrite states, edit success echoes, repeated status checks.

Args:
- toolType: tool name to prune (e.g., "todowrite", "bash", "edit")
- keepLatest: how many recent calls to keep visible (default 3)`

export function createPruneTool(ctx: ToolContext): ReturnType<typeof tool> {
    ctx.prompts.reload()

    return tool({
        description: PRUNE_TOOL_DESCRIPTION,
        args: {
            toolType: tool.schema
                .string()
                .describe('Tool name to prune (e.g., "todowrite", "bash", "edit")'),
            keepLatest: tool.schema
                .number()
                .optional()
                .describe("How many recent calls to keep visible (default 3)"),
        },
        async execute(args, toolCtx) {
            const keepLatest = args.keepLatest ?? 3
            const { rawMessages } = await prepareSession(
                ctx,
                toolCtx,
                `Prune: ${args.toolType}`,
            )

            const matchingCalls: Array<{ callId: string; index: number; tokens: number }> = []
            for (let i = 0; i < rawMessages.length; i++) {
                const msg = rawMessages[i]
                if (!msg) continue

                for (const part of msg.parts || []) {
                    if (part.type !== "tool") continue
                    const partTool = (part as any)?.tool || ""
                    if (partTool !== args.toolType) continue

                    const callId = (part as any)?.callID
                    if (!callId || typeof callId !== "string") continue
                    if (ctx.state.prune.tools.has(callId)) continue

                    const tokens = Math.round(JSON.stringify(part).length / 4)
                    matchingCalls.push({ callId, index: i, tokens })
                }
            }

            if (matchingCalls.length <= keepLatest) {
                return `Nothing to prune — only ${matchingCalls.length} ${args.toolType} calls visible (keepLatest=${keepLatest}).`
            }

            matchingCalls.sort((a, b) => a.index - b.index)
            const toPrune = matchingCalls.slice(0, matchingCalls.length - keepLatest)

            let totalTokens = 0
            for (const item of toPrune) {
                ctx.state.prune.tools.set(item.callId, item.tokens)
                totalTokens += item.tokens
            }

            await finalizeSession(
                ctx,
                toolCtx,
                rawMessages,
                [],
                `Prune ${args.toolType}`,
            )

            return `Pruned ${toPrune.length} ${args.toolType} calls (~${totalTokens} tokens). Kept latest ${keepLatest}. Outputs will be stripped on next context refresh.\nIMPORTANT: This was an automatic context pruning. You MUST continue your previous task exactly where you left off. Do NOT ask the user what to do next.`
        },
    })
}
