// Class B — migrated from v1 lib/compress/decompress.ts with interface adaptation.
// Registered tool name: "decompress".

import { tool } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext } from "../types"
import { saveSessionState } from "../../state/persistence"
import { formatBlockRef } from "../../infra/message-refs"
import { formatTokenCount } from "../../ui/utils"
import {
    parseBlockIdArg,
    resolveCompressionTarget,
    findActiveAncestorBlockId,
    snapshotActiveMessages,
    deactivateCompressionTarget,
    computeRestoredMessages,
    computeReactivatedBlockIds,
    buildRestoredContentPreview,
} from "./decompress-logic"

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
    }
}

export function createDecompressTool(ctx: ToolContext): ToolDefinition {
    return tool({
        description: TOOL_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            await toolCtx.ask({
                permission: "compress",
                patterns: ["*"],
                always: ["*"],
                metadata: {},
            })

            toolCtx.metadata({ title: "Decompress" })

            const messagesState = ctx.state.prune.messages

            const targetBlockId = parseBlockIdArg(args.blockId)
            if (targetBlockId === null) {
                return `Error: Invalid block ID "${args.blockId}". Use format "b0", "b1", etc.`
            }

            const target = resolveCompressionTarget(messagesState, targetBlockId)
            if (!target) {
                return `Error: Block ${targetBlockId} does not exist. No compression found with that ID.`
            }

            const activeBlocks = target.blocks.filter((block) => block.active)
            if (activeBlocks.length === 0) {
                const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
                if (activeAncestorBlockId !== null) {
                    return `Error: Block ${formatBlockRef(target.displayId)} is nested inside active block ${activeAncestorBlockId}. Decompress block ${activeAncestorBlockId} first.`
                }
                return `Error: Block ${formatBlockRef(target.displayId)} is not active. It may have already been decompressed.`
            }

            const activeMessagesBefore = snapshotActiveMessages(messagesState)
            const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

            deactivateCompressionTarget(messagesState, target)

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

            await saveSessionState(ctx.state, ctx.logger)

            const restoredContentPreview = buildRestoredContentPreview(
                ctx.messages,
                activeMessagesBefore,
                messagesState,
            )

            const lines: string[] = []
            lines.push(
                `Decompressed block ${formatBlockRef(target.displayId)}. Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
            )

            if (reactivatedBlockIds.length > 0) {
                const refs = reactivatedBlockIds.map((id) => formatBlockRef(id)).join(", ")
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
