import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { buildStatusReport } from "../compress/status"

export interface StatsCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    userInfo?: {
        providerId?: string
        modelId?: string
        agent?: string
        variant?: string
    }
}

export async function handleStatsCommand(ctx: StatsCommandContext): Promise<void> {
    const report = buildStatusReport(
        { state: ctx.state, config: ctx.config },
        ctx.messages,
    )

    const text = `[ACP Status]\n${report}`

    await sendIgnoredMessage(
        ctx.client,
        ctx.sessionId,
        text,
        {
            providerId: ctx.userInfo?.providerId,
            modelId: ctx.userInfo?.modelId,
            agent: ctx.userInfo?.agent,
            variant: ctx.userInfo?.variant,
        },
        ctx.logger,
    )
}
