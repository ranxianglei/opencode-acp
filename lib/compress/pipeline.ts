import type { WithParts } from "../state"
import { ensureSessionInitialized } from "../state"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../message-ids"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate, purgeErrors } from "../strategies"
import { getCurrentParams, getCurrentTokenUsage } from "../token-utils"
import { sendCompressNotification } from "../ui/notification"
import type { ToolContext } from "./types"
import { buildSearchContext, fetchSessionMessages } from "./search"
import type { SearchContext } from "./types"
import { applyPendingCompressionDurations } from "./timing"

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

export interface NotificationEntry {
    blockId: number
    runId: number
    summary: string
    summaryTokens: number
}

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

export async function prepareSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    title: string,
): Promise<PreparedSession> {
    if (ctx.state.manualMode && ctx.state.manualMode !== "compress-pending") {
        throw new Error(
            "Manual mode: compress blocked. Do not retry until `<compress triggered manually>` appears in user context.",
        )
    }

    await toolCtx.ask({
        permission: "compress",
        patterns: ["*"],
        always: ["*"],
        metadata: {},
    })

    toolCtx.metadata({ title })

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

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: ToolContext,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    applyPendingCompressionDurations(ctx.state)
    await saveSessionState(ctx.state, ctx.logger)

    const params = getCurrentParams(ctx.state, rawMessages, ctx.logger)
    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    const contextTokensBefore = getCurrentTokenUsage(ctx.state, rawMessages)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        params,
        contextTokensBefore,
    )
}

function countAssistantOutputs(messages: WithParts[]): number {
    return messages.filter((m) => m.info.role === "assistant" && m.info.summary !== true).length
}

function isOverMaxContextLimit(ctx: ToolContext, rawMessages: WithParts[]): boolean {
    const limit = ctx.config.compress.maxContextLimit
    const modelLimit = ctx.state.modelContextLimit
    if (modelLimit === undefined || modelLimit <= 0) return false

    let maxLimit: number
    if (typeof limit === "number") {
        maxLimit = limit
    } else if (typeof limit === "string" && limit.endsWith("%")) {
        const pct = Math.max(0, Math.min(100, Number.parseFloat(limit)))
        if (!Number.isFinite(pct)) return false
        maxLimit = Math.round((pct / 100) * modelLimit)
    } else {
        return false
    }

    return getCurrentTokenUsage(ctx.state, rawMessages) > maxLimit
}

export function checkCompressCooldown(ctx: ToolContext, rawMessages: WithParts[]): void {
    const cooldown = ctx.config.compress.cooldownOutputs
    if (cooldown === undefined || cooldown <= 0) return
    if (ctx.state.manualMode === "compress-pending") return

    const last = ctx.state.nudges.lastCompressAssistantCount
    if (last === undefined) return
    if (isOverMaxContextLimit(ctx, rawMessages)) return

    const current = countAssistantOutputs(rawMessages)
    if (current - last < cooldown) {
        throw new Error(
            `Frequent compression blocked: only ${current - last} new assistant output(s) since your last compress (cooldownOutputs=${cooldown}). Combine everything into a single compress call with multiple \`topics\` instead of many small calls. If context is genuinely full, finish the current step and compress the largest consumed ranges together.`,
        )
    }
}

export function recordCompressSuccess(ctx: ToolContext, rawMessages: WithParts[]): void {
    ctx.state.nudges.lastCompressAssistantCount = countAssistantOutputs(rawMessages)
}
