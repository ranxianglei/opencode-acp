import type { WithParts } from "../state"
import type { PluginConfig } from "../config"
import type { Logger } from "../logger"
import { countTokens } from "../token-utils"
import type { AcpCoreRuntime } from "./runtime"
import type { SessionModelLimits } from "./hooks"

export interface AcpCommandContext {
    subcommand: string
    messages: WithParts[]
    runtime: AcpCoreRuntime
    config: PluginConfig
    modelLimits: SessionModelLimits
    sessionId: string
    client: any
    logger: Logger
}

async function sendIgnored(ctx: AcpCommandContext, text: string): Promise<void> {
    const lastUser = ctx.messages.find((m) => m.info.role === "user")
    const info = lastUser?.info as { model?: { providerID?: string; modelID?: string }; agent?: string; variant?: string } | undefined
    const model = info?.model?.providerID && info?.model?.modelID ? { providerID: info.model.providerID, modelID: info.model.modelID } : undefined
    try {
        await ctx.client.session.prompt({
            path: { id: ctx.sessionId },
            body: {
                noReply: true,
                agent: info?.agent,
                model,
                variant: info?.variant,
                parts: [{ type: "text", text, ignored: true }],
            },
        })
    } catch (error) {
        ctx.logger.error("ACP command render failed", { error: (error as Error).message })
    }
}

function formatK(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return `${n}`
}

export async function handleAcpCommand(ctx: AcpCommandContext): Promise<boolean> {
    const sub = ctx.subcommand

    if (sub === "help" || sub === "") {
        await sendIgnored(
            ctx,
            [
                "ACP commands:",
                "  /acp          show this help",
                "  /acp context  show context usage + compressible ranges",
                "  /acp stats    show compression statistics",
            ].join("\n"),
        )
        return true
    }

    const { state, coreMessages } = await ctx.runtime.stateFor(ctx.sessionId, ctx.messages)
    const modelContextLimit = ctx.modelLimits.get(ctx.sessionId)
    const kernelConfig = ctx.runtime.configFor(ctx.config, modelContextLimit)
    const tokenCount = coreMessages.reduce((sum, c) => sum + countTokens(c.text ?? ""), 0)
    const report = ctx.runtime.core.status(state, tokenCount, kernelConfig)

    if (sub === "stats" || sub === "status") {
        const active = state.blocks.filter((b) => b.active)
        const lines = [
            `ACP stats — session ${ctx.sessionId}`,
            `Context: ${formatK(tokenCount)} / ${formatK(kernelConfig.modelContextLimit)} tokens (${Math.round(report.contextUsage * 100)}%)`,
            `Blocks: ${state.blocks.length} total, ${active.length} active`,
            `Tokens compressed (cumulative): ${formatK(state.stats.tokensCompressed)} across ${state.stats.compressionCount} compression(s)`,
        ]
        await sendIgnored(ctx, lines.join("\n"))
        return true
    }

    if (sub === "context") {
        const active = state.blocks.filter((b) => b.active)
        const lines = [
            `ACP context — ${formatK(tokenCount)} / ${formatK(kernelConfig.modelContextLimit)} tokens (${Math.round(report.contextUsage * 100)}%)`,
            `Active compressed blocks: ${active.length}` + (active.length ? ` (${active.map((b) => b.blockId).join(", ")})` : ""),
        ]
        await sendIgnored(ctx, lines.join("\n"))
        return true
    }

    await sendIgnored(ctx, `Unknown /acp subcommand: "${sub}". Try /acp help.`)
    return true
}
