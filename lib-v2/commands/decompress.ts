import type { CommandContext, CommandResult } from "./types"
import { deactivateBlock } from "../state/mutations/blocks"
import { getActiveBlocks } from "../state/queries"
import { formatTokenCount } from "../ui/utils"

export function decompressCommand(ctx: CommandContext): CommandResult {
    const { state, args, logger } = ctx

    if (args.length === 0) {
        return { output: listDecompressible(state) }
    }

    const parsed = parseBlockIds(args)
    if (parsed.invalid.length > 0) {
        return {
            output: `Invalid block id(s): ${parsed.invalid.join(", ")}. Block ids must be numbers (e.g. \`/acp decompress 3\`).`,
            isError: true,
        }
    }

    const lines: string[] = ["**Decompress**", ""]
    let succeeded = 0
    for (const id of parsed.valid) {
        const block = state.prune.messages.blocksById.get(id)
        if (!block) {
            lines.push(`- b${id}: not found`)
            continue
        }
        if (!block.active) {
            lines.push(`- b${id}: already inactive (decompressed or consumed)`)
            continue
        }
        const ok = deactivateBlock(state, id, { byUser: true })
        if (ok) {
            succeeded++
            lines.push(`- b${id}: restored (${formatTokenCount(block.compressedTokens)} tokens)`)
            logger.info("block decompressed by user", { blockId: id })
        } else {
            lines.push(`- b${id}: failed to deactivate`)
        }
    }

    lines.push("")
    lines.push(`Decompressed ${succeeded} of ${parsed.valid.length} block(s).`)

    return { output: lines.join("\n") }
}

function listDecompressible(state: CommandContext["state"]): string {
    const active = getActiveBlocks(state)
    const lines: string[] = ["**Available compressions to decompress**", ""]
    if (active.length === 0) {
        lines.push("No active compression blocks.")
        return lines.join("\n")
    }
    const sorted = [...active].sort((a, b) => a.blockId - b.blockId)
    lines.push("id | tokens | topic")
    for (const block of sorted) {
        lines.push(`- b${block.blockId}: ${formatTokenCount(block.compressedTokens)} | ${block.topic || "untitled"}`)
    }
    lines.push("")
    lines.push("Use \`/acp decompress <id>\` to restore a block (accepts multiple ids).")
    return lines.join("\n")
}

interface ParsedIds {
    valid: number[]
    invalid: string[]
}

function parseBlockIds(args: string[]): ParsedIds {
    const valid: number[] = []
    const invalid: string[] = []
    for (const raw of args) {
        const trimmed = raw.replace(/^b/i, "").trim()
        const id = Number.parseInt(trimmed, 10)
        if (Number.isNaN(id) || !/^\d+$/.test(trimmed)) {
            invalid.push(raw)
        } else {
            valid.push(id)
        }
    }
    return { valid, invalid }
}

export { parseBlockIds }
