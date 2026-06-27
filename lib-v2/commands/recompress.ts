import type { SessionState } from "../state/types"
import type { CommandContext, CommandResult } from "./types"
import { parseBlockIds } from "./decompress"
import { formatTokenCount } from "../ui/utils"
import type { Logger } from "../infra/logger"
import type { WithParts } from "../state/types"

export interface RecompressCommandContext {
    client: unknown
    state: SessionState
    logger: Logger
    sessionId: string
    messages: WithParts[]
    args: string[]
}

export async function handleRecompressCommand(ctx: RecompressCommandContext): Promise<void> {
    const { state, args, logger } = ctx

    if (args.length === 0) {
        logger.debug("handleRecompressCommand: no args, listing available")
        return
    }

    for (const arg of args) {
        const id = Number.parseInt(arg, 10)
        if (!Number.isInteger(id) || id <= 0) continue

        const block = state.prune.messages.blocksById.get(id)
        if (!block) continue
        if (block.active) continue
        if (!block.deactivatedByUser) continue

        reactivateUserDeactivatedBlock(state, id)
        logger.info("block recompressed by user", { blockId: id })
    }
}

export function recompressCommand(ctx: CommandContext): CommandResult {
    const { state, args, logger } = ctx

    if (args.length === 0) {
        return { output: listRecompressible(state) }
    }

    const parsed = parseBlockIds(args)
    if (parsed.invalid.length > 0) {
        return {
            output: `Invalid block id(s): ${parsed.invalid.join(", ")}. Block ids must be numbers (e.g. \`/acp recompress 3\`).`,
            isError: true,
        }
    }

    const lines: string[] = ["**Recompress**", ""]
    let succeeded = 0
    for (const id of parsed.valid) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block) {
            lines.push(`- b${id}: not found`)
            continue
        }
        if (block.active) {
            lines.push(`- b${id}: already active`)
            continue
        }
        if (!block.deactivatedByUser) {
            lines.push(`- b${id}: was consumed by another block (cannot recompress)`)
            continue
        }
        reactivateUserDeactivatedBlock(state, id)
        succeeded++
        lines.push(`- b${id}: re-applied (${formatTokenCount(block.compressedTokens)} tokens)`)
        logger.info("block recompressed by user", { blockId: id })
    }

    lines.push("")
    lines.push(`Recompressed ${succeeded} of ${parsed.valid.length} block(s).`)

    return { output: lines.join("\n") }
}

function listRecompressible(state: SessionState): string {
    const all = Array.from(state.prune.messages.blocksById.values())
    const recompressible = all.filter((b) => !b.active && b.deactivatedByUser)
    const lines: string[] = ["**User-decompressed blocks available to recompress**", ""]
    if (recompressible.length === 0) {
        lines.push("No recompressible blocks. Blocks consumed by newer compressions cannot be recompressed.")
        return lines.join("\n")
    }
    const sorted = [...recompressible].sort((a, b) => a.blockId - b.blockId)
    lines.push("id | tokens | topic")
    for (const block of sorted) {
        lines.push(`- b${block.blockId}: ${formatTokenCount(block.compressedTokens)} | ${block.topic || "untitled"}`)
    }
    lines.push("")
    lines.push("Use \`/acp recompress <id>\` to re-apply a block (accepts multiple ids).")
    return lines.join("\n")
}

function reactivateUserDeactivatedBlock(state: SessionState, blockId: number): boolean {
    const messages = state.prune.messages
    const block = messages.blocksById.get(blockId)
    if (!block) return false

    block.active = true
    block.deactivatedByUser = false
    block.deactivatedAt = undefined
    block.deactivatedByBlockId = undefined

    messages.activeBlockIds.add(blockId)
    if (block.anchorMessageId) {
        messages.activeByAnchorMessageId.set(block.anchorMessageId, blockId)
    }
    return true
}
