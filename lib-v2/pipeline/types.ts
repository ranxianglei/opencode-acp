import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export type InjectFn = (
    state: SessionState,
    config: PluginConfig,
    loggerOrMessages: Logger | WithParts[],
    messages?: WithParts[],
) => void

export interface PipelineDeps {
    state: SessionState
    config: PluginConfig
    logger: Logger
    client: unknown
    prompts: unknown
    assignMessageRefs?: (
        state: SessionState,
        messages: WithParts[],
    ) => void
    injectCompressNudges?: (
        state: SessionState,
        config: PluginConfig,
        logger: Logger | WithParts[],
        messages?: WithParts[],
        prompts?: unknown,
    ) => void
    injectMessageIds?: (
        state: SessionState,
        config: PluginConfig,
        loggerOrMessages: Logger | WithParts[],
        messages?: WithParts[],
    ) => void
    applyAnchoredNudges?: (
        state: SessionState,
        config: PluginConfig,
        logger: Logger,
        messages: WithParts[],
    ) => void
}

export interface PipelineContext {
    messages: WithParts[]
    deps: PipelineDeps
    shouldSkip: boolean
}

export interface PipelineStage {
    name: string
    run(ctx: PipelineContext): Promise<void> | void
}
