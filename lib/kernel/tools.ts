import { tool } from "@opencode-ai/plugin"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import type { AcpCoreRuntime } from "./runtime"
import type { SessionModelLimits } from "./hooks"
import { countTokens } from "../token-utils"

export interface KernelToolContext {
    client: any
    runtime: AcpCoreRuntime
    config: PluginConfig
    logger: Logger
    modelLimits: SessionModelLimits
}

async function loadSessionMessages(client: any, sessionId: string) {
    const response = await client.session.messages({ path: { id: sessionId } })
    return (response.data || response) as import("../state").WithParts[]
}

export function createCompressTool(ctx: KernelToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Compress one or more ranges of older conversation into detailed summaries you write. Each range replaces its original messages with a short block reference. Use when content is genuinely consumed (no longer needed for the current step).",
        args: {
            topic: tool.schema.string().optional().describe("Fallback topic for entries without their own."),
            content: tool.schema
                .array(
                    tool.schema.object({
                        topic: tool.schema.string().optional().describe("Short label (3-5 words) for THIS range."),
                        startId: tool.schema.string().describe("Message or block ID at range start (e.g. m00001, b2)."),
                        endId: tool.schema.string().describe("Message or block ID at range end (e.g. m00012, b5)."),
                        summary: tool.schema.string().describe("Complete technical summary replacing the range."),
                    }),
                )
                .describe("One or more ranges to compress."),
            summaryMaxChars: tool.schema.number().optional().describe("Override max summary length for all entries."),
        },
        async execute(args, toolCtx) {
            const sessionId = toolCtx.sessionID
            const callID = (toolCtx as { callID?: string }).callID
            const messages = await loadSessionMessages(ctx.client, sessionId)
            const release = await ctx.runtime.acquireLock(sessionId)
            try {
                const { state, coreMessages } = await ctx.runtime.stateFor(sessionId, messages)
                const kernelConfig = ctx.runtime.configFor(ctx.config, ctx.modelLimits.get(sessionId))
                const ranges = (args.content as Array<{ topic?: string; startId: string; endId: string; summary: string; summaryMaxChars?: number }>).map((entry) => ({
                    startRef: entry.startId,
                    endRef: entry.endId,
                    summary: entry.summary,
                    topic: entry.topic ?? (args.topic as string | undefined),
                    compressCallId: callID,
                    summaryMaxChars: entry.summaryMaxChars ?? (args.summaryMaxChars as number | undefined),
                }))
                const result = ctx.runtime.core.applyCompression({ ranges, messages: coreMessages, state, config: kernelConfig })
                await ctx.runtime.save(result.state, sessionId)
                if (result.result.errors.length > 0) {
                    throw new Error(result.result.errors.join("; "))
                }
                ctx.logger.info("Compress applied", { blocksCreated: result.result.blocksCreated, tokensCompressed: result.result.tokensCompressed })
                return {
                    output: `Compressed ${result.result.blocksCreated} range(s); ~${result.result.tokensCompressed} tokens captured in summary blocks.`,
                    metadata: {
                        blocksCreated: result.result.blocksCreated,
                        tokensCompressed: result.result.tokensCompressed,
                        warnings: result.result.warnings,
                    },
                }
            } finally {
                release()
            }
        },
    })
}

export function createDecompressTool(ctx: KernelToolContext): ReturnType<typeof tool> {
    return tool({
        description:
            "Restore a previously compressed block's summary so you can re-read what was compressed. Pass blockId (e.g. \"b5\"). Returns the block's topic, summary, and the message range it covered.",
        args: {
            blockId: tool.schema.string().optional().describe("Block ID to restore (e.g. b5). Omit to list all blocks."),
        },
        async execute(args, toolCtx) {
            const sessionId = toolCtx.sessionID
            const blockId = args.blockId as string | undefined
            const { state } = await ctx.runtime.stateFor(sessionId, [])
            if (!blockId) {
                const blocks = state.blocks
                const output = blocks.length === 0 ? "No compressed blocks." : `Compressed blocks: ${blocks.map((b) => `${b.blockId} (${b.topic ?? "untitled"})`).join(", ")}`
                return {
                    output,
                    metadata: { blocks: blocks.map((b) => ({ blockId: b.blockId, topic: b.topic, tier: b.tier })) },
                }
            }
            const block = state.blocks.find((b) => b.blockId === blockId)
            if (!block) {
                throw new Error(`Block ${blockId} not found. Call decompress without a blockId to list available blocks.`)
            }
            return {
                output: block.summary ?? `(block ${blockId} has no summary text)`,
                metadata: {
                    blockId: block.blockId,
                    topic: block.topic,
                    tier: block.tier,
                    coveredMessageCount: block.effectiveMessageIds.length,
                },
            }
        },
    })
}

export function createSearchContextTool(ctx: KernelToolContext): ReturnType<typeof tool> {
    return tool({
        description: "Search compressed block summaries by keyword. Use before decompress to find the right block.",
        args: {
            query: tool.schema.string().describe("Keywords to search for in compressed summaries."),
        },
        async execute(args, toolCtx) {
            const sessionId = toolCtx.sessionID
            const { state } = await ctx.runtime.stateFor(sessionId, [])
            const matches = ctx.runtime.core.search(args.query as string, state)
            return {
                output: matches.length === 0 ? "No matching blocks." : `${matches.length} matching block(s): ${matches.map((b) => b.blockId).join(", ")}`,
                metadata: {
                    results: matches.map((b) => ({ blockId: b.blockId, topic: b.topic, tier: b.tier, preview: (b.summary ?? "").slice(0, 200) })),
                },
            }
        },
    })
}

export function createAcpStatusTool(ctx: KernelToolContext): ReturnType<typeof tool> {
    return tool({
        description: "Show context usage and compressible ranges. No args = overview.",
        args: {
            scope: tool.schema.string().optional().describe("Optional: 'uncompressed' for compressible ranges, 'compressed' for block list."),
        },
        async execute(args, toolCtx) {
            const sessionId = toolCtx.sessionID
            const messages = await loadSessionMessages(ctx.client, sessionId)
            const { state, coreMessages } = await ctx.runtime.stateFor(sessionId, messages)
            const modelContextLimit = ctx.modelLimits.get(sessionId)
            const kernelConfig = ctx.runtime.configFor(ctx.config, modelContextLimit)
            const tokenCount = coreMessages.reduce((sum, c) => sum + countTokens(c.text ?? ""), 0)
            const report = ctx.runtime.core.status(state, tokenCount, kernelConfig)
            const scope = args.scope as string | undefined
            const blocks = scope === "compressed" ? state.blocks.map((b) => ({ blockId: b.blockId, tier: b.tier, active: b.active, topic: b.topic, tokens: b.compressedTokens })) : undefined
            return {
                output: `Context: ${Math.round(report.contextUsage * 100)}% used (${tokenCount} / ${kernelConfig.modelContextLimit} tokens). Active blocks: ${state.blocks.filter((b) => b.active).length}.`,
                metadata: { ...report, ...(blocks ? { blocks } : {}) },
            }
        },
    })
}
