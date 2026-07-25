import { tool } from "@opencode-ai/plugin"
import { type ToolContext, type ToolFactoryContext, resolveToolContext } from "./types"
import type { CompressionTarget } from "../commands/compression-targets"
import type { CompressionBlock } from "../state/types"
import type { SessionState, WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { syncCompressionBlocks } from "../messages"
import { getCurrentTokenUsage } from "../token-utils"
import {
    fetchSessionMessages,
    buildSearchContext,
    resolveBoundaryIds,
    resolveSelection,
} from "./search"
import { resolveCompressionTarget } from "../commands/compression-targets"
import {
    parseBlockIdArg,
    resolveDecompressMode,
    findActiveAncestorBlockId,
    findActiveBlocksOverlappingMessages,
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
): Promise<{ rawMessages: WithParts[] }> {
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
        ctx.config,
    )

    assignMessageRefs(ctx.state, rawMessages)

    return { rawMessages }
}

async function finalizeDecompressSession(ctx: ToolContext): Promise<void> {
    await saveSessionState(ctx.state, ctx.logger)
}

type ResolveResult =
    | { ok: true; targets: CompressionTarget[] }
    | { ok: false; error: string }

function resolveTargets(
    args: Record<string, unknown>,
    state: SessionState,
    rawMessages: WithParts[],
    logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): ResolveResult {
    const mode = resolveDecompressMode(args)
    if (!mode.ok) {
        return { ok: false, error: `Error: ${mode.error}` }
    }

    const messagesState = state.prune.messages

    if (mode.mode === "block") {
        return resolveSingleBlockTarget(messagesState, args.blockId as string)
    }

    return resolveRangeTarget(state, rawMessages, args.startId as string, args.endId as string, logger)
}

function resolveSingleBlockTarget(
    messagesState: SessionState["prune"]["messages"],
    blockIdArg: string,
): ResolveResult {
    const targetBlockId = parseBlockIdArg(blockIdArg)
    if (targetBlockId === null) {
        return {
            ok: false,
            error: `Error: Invalid block ID "${blockIdArg}". Use format "b0", "b1", etc.`,
        }
    }

    const target = resolveCompressionTarget(messagesState, targetBlockId)
    if (!target) {
        return {
            ok: false,
            error: `Error: Block ${targetBlockId} does not exist. No compression found with that ID.`,
        }
    }

    const activeBlocks = target.blocks.filter((block) => block.active)
    if (activeBlocks.length === 0) {
        const activeAncestorBlockId = findActiveAncestorBlockId(messagesState, target)
        if (activeAncestorBlockId !== null) {
            return {
                ok: false,
                error: `Error: Block ${target.displayId} is nested inside active block ${activeAncestorBlockId}. Decompress block ${activeAncestorBlockId} first.`,
            }
        }
        return {
            ok: false,
            error: `Error: Block ${target.displayId} is not active. It may have already been decompressed.`,
        }
    }

    return { ok: true, targets: [target] }
}

function resolveRangeTarget(
    state: SessionState,
    rawMessages: WithParts[],
    startId: string,
    endId: string,
    logger: { info: (msg: string, meta?: Record<string, unknown>) => void },
): ResolveResult {
    const searchContext = buildSearchContext(state, rawMessages)

    let startReference
    let endReference
    try {
        const resolved = resolveBoundaryIds(searchContext, state, startId, endId)
        startReference = resolved.startReference
        endReference = resolved.endReference
    } catch (err) {
        return { ok: false, error: `Error: ${(err as Error).message}` }
    }

    let selection
    try {
        selection = resolveSelection(searchContext, startReference, endReference)
    } catch (err) {
        return { ok: false, error: `Error: ${(err as Error).message}` }
    }
    if (selection.messageIds.length === 0) {
        return {
            ok: false,
            error: `Error: No messages found in range ${startId}..${endId}.`,
        }
    }

    const messageIdSet = new Set(selection.messageIds)
    const messagesState = state.prune.messages
    const overlappingBlocks = findActiveBlocksOverlappingMessages(messagesState, messageIdSet)
    if (overlappingBlocks.length === 0) {
        return {
            ok: false,
            error: `Error: No active compression blocks overlap the range ${startId}..${endId}. The content may already be fully visible. Use acp_status to review block coverage.`,
        }
    }

    const targetMap = new Map<number, CompressionTarget>()
    for (const block of overlappingBlocks) {
        const target = resolveCompressionTarget(messagesState, block.blockId)
        if (target) {
            targetMap.set(target.displayId, target)
        }
    }
    const targets = Array.from(targetMap.values())

    logger.info("range decompress resolved", {
        range: `${startId}..${endId}`,
        matchedBlocks: overlappingBlocks.map((b) => b.blockId),
        targets: targets.map((t) => t.displayId),
    })

    return { ok: true, targets }
}

const TOOL_DESCRIPTION = `Restores previously compressed content.

Use this tool when you need exact details from compressed content that the summary cannot provide.
The tool returns a condensed preview of the restored content so you can reason about it immediately.

TWO MODES:

1. Block mode (default): decompress a single block by ID.
   - blockId: block reference to decompress (e.g., "b0", "b2")

2. Range mode: decompress ALL blocks overlapping a message range. Use this to restore
   content across multiple blocks without calling acp_status + decompress repeatedly.
   - startId: starting message or block ref (e.g., "m00150")
   - endId: ending message or block ref (e.g., "m00200")

   Range mode finds every active block whose effectiveMessageIds touch the range and
   batch-restores them. Partial overlap decompresses the whole block (content cannot be
   partially restored). Nested blocks are handled automatically.

ARGUMENTS:
- blockId?: string — use this OR startId+endId (mutually exclusive)
- startId?: string — range start (message or block ref)
- endId?: string — range end (message or block ref)
- toFile?: string — if provided, writes restored content to this file path (must be under
  /tmp or ~/.cache/opencode/) instead of inflating context. Block(s) stay compressed.

IMPORTANT:
- Decompressing inflates context. Check context usage before decompressing.
- Message-mode blocks from the same batch (same runId) are restored together.
- After decompression, the restored messages will appear in full in your next context window.
- Do NOT call this tool in parallel with compress — their state mutations may conflict.`

function buildSchema() {
    return {
        blockId: tool.schema
            .string()
            .optional()
            .describe('Block reference to decompress (e.g., "b0", "b2"). Mutually exclusive with startId/endId.'),
        startId: tool.schema
            .string()
            .optional()
            .describe('Range start: message ref (e.g., "m00150") or block ref (e.g., "b2"). Used with endId.'),
        endId: tool.schema
            .string()
            .optional()
            .describe('Range end: message ref (e.g., "m00200") or block ref (e.g., "b5"). Used with startId.'),
        toFile: tool.schema
            .string()
            .optional()
            .describe("If provided, writes restored content to this file path instead of inflating context. Block stays compressed. Path must be under /tmp or ~/.cache/opencode/. Example: '/tmp/block52.txt'"),
    }
}

function extractMessageId(m: WithParts): string {
    return (m as { id?: string }).id ?? (m as { messageId?: string }).messageId ?? ""
}

function extractMessageText(m: WithParts): string {
    const msg = m as { role?: string; type?: string; content?: unknown; text?: string }
    const role = msg.role || msg.type || "unknown"
    const content =
        typeof msg.content === "string"
            ? msg.content
            : typeof msg.text === "string"
              ? msg.text
              : JSON.stringify(msg.content || msg.text || "")
    return `[${role}]\n${content}`
}

export function createDecompressTool(factoryCtx: ToolFactoryContext): ReturnType<typeof tool> {
    return tool({
        description: TOOL_DESCRIPTION,
        args: buildSchema(),
        async execute(args, toolCtx) {
            const ctx = resolveToolContext(factoryCtx, toolCtx.sessionID)
            const { rawMessages } = await prepareDecompressSession(ctx, toolCtx)

            const contextUsageBefore = ctx.state.modelContextLimit
                ? Math.round(
                      (getCurrentTokenUsage(ctx.state, rawMessages) /
                          ctx.state.modelContextLimit) *
                          100,
                  )
                : undefined

            const resolved = resolveTargets(args as Record<string, unknown>, ctx.state, rawMessages, ctx.logger)
            if (!resolved.ok) {
                return resolved.error
            }
            const targets = resolved.targets

            const messagesState = ctx.state.prune.messages
            const activeBlocks: CompressionBlock[] = []
            for (const target of targets) {
                for (const block of target.blocks) {
                    if (block.active) {
                        activeBlocks.push(block)
                    }
                }
            }

            if (args.toFile) {
                const targetPath = args.toFile as string
                const os = await import("os")
                const path = await import("path")
                const allowedDirs = [
                    os.tmpdir() + "/",
                    path.join(os.homedir(), ".cache", "opencode") + "/",
                ]
                const resolvedPath = path.resolve(targetPath)
                const isAllowed = allowedDirs.some((dir) => {
                    const rel = path.relative(dir, resolvedPath)
                    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
                })
                if (!isAllowed) {
                    return `Error: toFile path must be under ${os.tmpdir()} or ~/.cache/opencode/. Got: ${targetPath}`
                }

                const msgIdSet = new Set<string>()
                for (const block of activeBlocks) {
                    for (const id of block.effectiveMessageIds ?? []) {
                        msgIdSet.add(id)
                    }
                }
                const blockMessages = rawMessages.filter((m) => msgIdSet.has(extractMessageId(m)))
                const lines = blockMessages.map(extractMessageText)
                const { writeFile } = await import("fs/promises")
                const fileContent =
                    lines.length > 0
                        ? lines.join("\n\n---\n\n")
                        : (activeBlocks[0]?.summary ?? "(no content available)")
                await writeFile(targetPath, fileContent, "utf-8")

                const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
                return `Block(s) ${displayIds} content (${blockMessages.length} messages, ${fileContent.length} chars) written to ${targetPath}. Block(s) stay compressed — context unchanged. Use read tool to access specific parts.`
            }

            const activeMessagesBefore = snapshotActiveMessages(messagesState)
            const activeBlockIdsBefore = new Set(messagesState.activeBlockIds)

            for (const target of targets) {
                deactivateCompressionTarget(messagesState, target)
            }

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

            const displayIds = targets.map((t) => `b${t.displayId}`).join(", ")
            const lines: string[] = []
            const headerNoun = targets.length === 1 ? "block" : "blocks"
            lines.push(
                `Decompressed ${headerNoun} ${displayIds}. Restored ${restoredMessageCount} message(s) (~${formatTokenCount(restoredTokens)}).`,
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
                mode: typeof args.startId === "string" ? "range" : "block",
                targetBlockIds: targets.map((t) => t.displayId),
                restoredMessageCount,
                restoredTokens,
                reactivatedBlockIds,
            })

            return lines.join("\n")
        },
    })
}
