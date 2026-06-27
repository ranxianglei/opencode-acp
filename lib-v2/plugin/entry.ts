import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"
import type { SessionState, WithParts } from "../state/types"
import { createSessionState } from "../state/factory"
import { createMessageTransformStages } from "../pipeline/stages"
import { runPipeline } from "../pipeline/compose"
import type { PipelineDeps } from "../pipeline/types"

export interface PluginContext {
    config: PluginConfig
    logger: Logger
    sessionId: string | null
}

export async function handleMessageTransform(
    messages: WithParts[],
    ctx: PluginContext,
): Promise<WithParts[]> {
    if (!ctx.sessionId) {
        return messages
    }

    const state = createSessionState(ctx.sessionId)
    const stages = createMessageTransformStages()

    const deps: PipelineDeps = {
        state,
        config: ctx.config,
        logger: ctx.logger,
        client: null,
        prompts: null,
    }

    await runPipeline(stages, deps, messages)

    return messages
}

export function createPluginEntry(config: PluginConfig, logger: Logger) {
    return {
        handleMessageTransform: (messages: WithParts[], sessionId: string | null) =>
            handleMessageTransform(messages, { config, logger, sessionId }),
    }
}
