import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { syncCompressionBlocks } from "../messages"
import { getCurrentTokenUsage } from "../token-utils"
import { fetchSessionMessages } from "./search"
import { resolveCompressionTarget } from "../commands/compression-targets"
import {
    parseBlockIdArg,
    findActiveAncestorBlockId,
    snapshotActiveMessages,
    deactivateCompressionTarget,
    computeRestoredMessages,
    computeReactivatedBlockIds,
    buildRestoredContentPreview,
} from "./decompress-logic"
import { formatTokenCount } from "../ui/utils"

interface RunContext {
    ask(input: {
        permission: string
        patterns: string[]
        always: string[]
        metadata: Record<string, unknown>
    }): Promise<void>
    metadata(input: { title: string }): void
    sessionID: string
}

async function prepareDecompressSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<{ rawMessages: import("../state").WithParts[] }> {
    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title: "Decompress" })

    const rawMessages = await fetchSessionMessages(ctx.client, toolCtx.sessionID)

    await ensureSessionInitialized(
        ctx.client,
        ctx.state,
        toolCtx.sessionID,
        ctx.logger,
        rawMessages,
        ctx.config.manualMode.enabled,
    )

    assignMessageRefs(ctx.state, rawMessages)

    return { rawMessages }
}

async function finalizeDecompressSession(
    ctx: ToolContext,
): Promise<void> {
    await saveSessionState(ctx.state, ctx.logger)
}

const TOOL_DESCRIPTION = `Restores previously compressed content identified by a block ID.

Use this tool when you need exact details from a compressed block that the summary cannot provide.
The tool returns a condensed preview of the restored content so you can reason about it immediately.

Argument: blockId — the block reference to decompress (e.g., "b0", "b2")

IMPORTANT:
- Decompressing inflates context. Check context usage before decompressing.
- Message-mode blocks from the same batch (same runId) are restored together.
- After decompression, the restored messages will appear in full in your next context window.
- Do NOT call this tool in parallel with compress — their state mutations may conflict.`

function buildSchema() {
    return {
        blockId: tool.schema
            .string()
            .describe('Block reference to decompress (e.g., "b0", "b2")'),
        toFile: tool.schema
            .string()
            .optional()
            .describe("If provided, writes restored content to this file path instead of inflating context. Block stays compressed. Use read tool to access specific parts. Example: '/tmp/block52.txt'"),
    }
}

export function createDecompressTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const { rawMessages } = await prepareDecompressSession(ctx, toolCtx)

            const contextUsageBefore = ctx.state.modelContextLimit
                ? Math.round(
                      (getCurrentTokenUsage(ctx.state, rawMessages) /
                          ctx.state.modelContextLimit) *
                          100,
                  )
                : undefined

            const targetBlockId = parseBlockIdArg(args.blockId as string)
            if (targetBlockId === null) {
                return `Error: Invalid block ID "${args.blockId}". Use format "b0", "b1", etc.`
            }

            const messagesState = ctx.state.prune.messages

            const target = resolveCompressionTarget(messagesState, targetBlockId)
            if (!target) {
                return `Error: Block ${targetBlockId} does not exist. No compression found with that ID.`
            }

            const activeBlocks = target.blocks.filter((block) => block.active)
            if (activeBlocks.length === 0) {
                const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
                if (activeAncestorBlockId !== null) {
                    return `Error: Block ${target.displayId} is nested inside active block ${activeAncestorBlockId}. Decompress block ${activeAncestorBlockId} first.`
                }
                return `Error: Block ${target.displayId} is not active. It may have already been decompressed.`
            }

            if (args.toFile) {
                const block = activeBlocks[0]
                const msgIds = new Set(block.effectiveMessageIds ?? [])
                const blockMessages = rawMessages.filter((m) => {
                    const id = (m as { id?: string }).id ?? (m as { messageId?: string }).messageId ?? ""
                    return msgIds.has(id)
                })
                const lines = blockMessages.map((m) => {
                    const msg = m as { role?: string; type?: string; content?: unknown; text?: string }
                    const role = msg.role || msg.type || "unknown"
                    const content =
                        typeof msg.content === "string"
                            ? msg.content
                            : typeof msg.text === "string"
                              ? msg.text
                              : JSON.stringify(msg.content || msg.text || "")
                    return `[${role}]\n${content}`
                })
                const { writeFile } = await import("fs/promises")
                const fileContent =
                    lines.length > 0
                        ? lines.join("\n\n---\n\n")
                        : (block.summary ?? "(no content available)")
                await writeFile(args.toFile as string, fileContent, "utf-8")
                return `Block b${target.displayId} content (${blockMessages.length} messages, ${fileContent.length} chars) written to ${args.toFile}. Block stays compressed — context unchanged. Use read tool to access specific parts.`
            }

            const activeMessagesBefore = snapshotActiveMessages(messagesState)
            const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

            deactivateCompressionTarget(messagesState, target)

            syncCompressionBlocks(ctx.state, ctx.logger, rawMessages)

            const { restoredMessageCount, restoredTokens } = computeRestoredMessages(
                messagesState,
                activeMessagesBefore,
            )
            const reactivatedBlockIds = computeReactivatedBlockIds(
                messagesState,
                activeBlockIdsBefore,
            )

            ctx.state.stats.totalPruneTokens = Math.max(
                0,
                ctx.state.stats.totalPruneTokens - restoredTokens,
            )

            const contextUsageAfter = ctx.state.modelContextLimit
                ? Math.round(
                      (getCurrentTokenUsage(ctx.state, rawMessages) /
                          ctx.state.modelContextLimit) *
                          100,
                  )
                : undefined

            await finalizeDecompressSession(ctx)

            const restoredContentPreview = buildRestoredContentPreview(
                rawMessages,
                activeMessagesBefore,
                messagesState,
            )

            const lines: string[] = []
            lines.push(
                `Decompressed block b${target.displayId}. Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
            )

            if (contextUsageBefore !== undefined && contextUsageAfter !== undefined) {
                lines.push(`Context usage: ${contextUsageBefore}% → ${contextUsageAfter}%.`)
            }

            if (reactivatedBlockIds.length > 0) {
                const refs = reactivatedBlockIds.map((id) => `b${id}`).join(", ")
                lines.push(`Also restored nested block(s): ${refs}.`)
            }

            if (restoredContentPreview) {
                lines.push("")
                lines.push("RESTORED CONTENT (condensed):")
                lines.push(restoredContentPreview)
            }

            ctx.logger.info("Decompress tool completed", {
                targetBlockId: target.displayId,
                targetRunId: target.runId,
                restoredMessageCount,
                restoredTokens,
                reactivatedBlockIds,
            })

            return lines.join("\n")
        },
    })
}
