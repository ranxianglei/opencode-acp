import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { fetchSessionMessages } from "./search"
import { formatBlockRef, parseBlockRef } from "../message-ids"

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

async function prepareMarkSession(
    ctx: ToolContext,
    toolCtx: RunContext,
): Promise<void> {
    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title: "Mark block" })

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
}

const MARK_DESCRIPTION = `Marks a compressed block for batch merge-cleanup.

Use this for blocks whose detailed content you no longer need, but whose summaries
you want to keep in context for now (to preserve prompt cache). Marked blocks stay
fully active with zero immediate effect on context or cache. When context pressure
rises, all marked blocks are merge-compressed together into a single summary in one
cache break, instead of being handled one at a time.

Argument: blockId — the block reference to mark (e.g., "b1", "b3")

Use mark_block instead of compress when you want deferred cleanup: the block keeps
serving cache hits now and gets consolidated later only if context gets tight.`

const UNMARK_DESCRIPTION = `Removes the batch cleanup mark from a compressed block.

Reverses mark_block. The block returns to normal handling and will not be
auto-merged during batch cleanup.

Argument: blockId — the block reference to unmark (e.g., "b1", "b3")`

function buildSchema() {
    return {
        blockId: tool.schema
            .string()
            .describe('Block reference to mark (e.g., "b1", "b3")'),
    }
}

function buildUnmarkSchema() {
    return {
        blockId: tool.schema
            .string()
            .describe('Block reference to unmark (e.g., "b1", "b3")'),
    }
}

export function createMarkBlockTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: MARK_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            await prepareMarkSession(ctx, toolCtx)

            const targetBlockId = parseBlockRef(String(args.blockId))
            if (targetBlockId === null) {
                return `Error: Invalid block ID "${args.blockId}". Use format "b0", "b1", etc.`
            }

            const messagesState = ctx.state.prune.messages
            const block = messagesState.blocksById.get(targetBlockId)
            if (!block) {
                return `Error: Block ${formatBlockRef(targetBlockId)} does not exist.`
            }

            if (!block.active) {
                return `Error: Block ${formatBlockRef(targetBlockId)} is not active.`
            }

            messagesState.markedForCleanup.add(targetBlockId)
            await saveSessionState(ctx.state, ctx.logger)

            const ref = formatBlockRef(targetBlockId)
            const markedCount = messagesState.markedForCleanup.size

            ctx.logger.info("mark_block: block marked for cleanup", {
                blockId: targetBlockId,
                markedCount,
            })

            return `Block ${ref} marked for cleanup. It will be merge-compressed together with other marked blocks when context pressure rises. No immediate effect on context or cache. (${markedCount} block(s) currently marked.)`
        },
    })
}

export function createUnmarkBlockTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: UNMARK_DESCRIPTION,
        args: buildUnmarkSchema(),
        async execute(args, toolCtx) {
            await prepareMarkSession(ctx, toolCtx)

            const targetBlockId = parseBlockRef(String(args.blockId))
            if (targetBlockId === null) {
                return `Error: Invalid block ID "${args.blockId}". Use format "b0", "b1", etc.`
            }

            const messagesState = ctx.state.prune.messages
            if (!messagesState.markedForCleanup.has(targetBlockId)) {
                return `Block ${formatBlockRef(targetBlockId)} was not marked for cleanup.`
            }

            messagesState.markedForCleanup.delete(targetBlockId)
            await saveSessionState(ctx.state, ctx.logger)

            ctx.logger.info("unmark_block: block unmarked", {
                blockId: targetBlockId,
            })

            return `Block ${formatBlockRef(targetBlockId)} unmarked. It will no longer be auto-merged during batch cleanup.`
        },
    })
}
