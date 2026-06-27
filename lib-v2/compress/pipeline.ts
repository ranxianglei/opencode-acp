import type { WithParts } from "../state/types"
import { createSessionState } from "../state/factory"
import { saveSessionState } from "../state/persistence"
import { assignMessageRefs } from "../messages/inject/inject"
import { isIgnoredUserMessage } from "../messages/query"
import { deduplicate } from "../strategies/deduplication"
import { purgeErrors } from "../strategies/purge-errors"
import { buildSearchContext, fetchSessionMessages } from "./search"
import { sendCompressNotification } from "../ui/notification"
import type { NotificationEntry, ToolContext, SearchContext } from "./types"

export type { NotificationEntry }

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

export interface PreparedSession {
    rawMessages: WithParts[]
    searchContext: SearchContext
}

function ensureSessionInitialized(
    state: any,
    client: any,
    sessionId: string,
    logger: any,
    rawMessages: WithParts[],
    manualModeEnabled: boolean,
): void {
    if (state.sessionId === sessionId) {
        return
    }

    const fresh = createSessionState()
    fresh.sessionId = sessionId
    fresh.manualMode = manualModeEnabled ? "active" : false
    fresh.isSubAgent = false

    Object.assign(state, fresh)

    try {
        const result = client?.session?.getSync?.()
        if (result?.data) {
            const data = result.data
            if (data.parentID) {
                state.isSubAgent = true
            }
        }
    } catch {
        void 0
    }
}

export async function prepareSession(
    ctx: any,
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

    let sessionGetResult: any = null
    try {
        sessionGetResult = await ctx.client?.session?.get?.({ path: { id: toolCtx.sessionID } })
    } catch {
        sessionGetResult = null
    }

    const isSubAgent = !!(sessionGetResult?.data?.parentID)

    if (ctx.state.sessionId !== toolCtx.sessionID && ctx.state.sessionId !== null) {
        const fresh = createSessionState()
        fresh.sessionId = toolCtx.sessionID
        fresh.manualMode = ctx.config?.manualMode?.enabled ? "active" : false
        fresh.isSubAgent = isSubAgent
        Object.assign(ctx.state, fresh)
    } else if (ctx.state.sessionId === null) {
        ctx.state.sessionId = toolCtx.sessionID
        ctx.state.isSubAgent = isSubAgent
    } else {
        ctx.state.isSubAgent = isSubAgent
    }

    assignMessageRefs(ctx.state, rawMessages)

    deduplicate(ctx.state, ctx.logger, ctx.config, rawMessages)
    purgeErrors(ctx.state, ctx.logger, ctx.config, rawMessages)

    return {
        rawMessages,
        searchContext: buildSearchContext(ctx.state, rawMessages),
    }
}

export async function finalizeSession(
    ctx: any,
    toolCtx: RunContext,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    batchTopic: string | undefined,
): Promise<void> {
    ctx.state.manualMode = ctx.state.manualMode ? "active" : false
    await saveSessionState(ctx.state, ctx.logger)

    const sessionMessageIds = rawMessages
        .filter((msg) => !isIgnoredUserMessage(msg))
        .map((msg) => msg.info.id)

    await sendCompressNotification(
        ctx.client,
        ctx.logger,
        ctx.config,
        ctx.state,
        toolCtx.sessionID,
        entries,
        batchTopic,
        sessionMessageIds,
        {},
    )
}

export { isIgnoredUserMessage }
