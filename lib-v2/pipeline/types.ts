import type { SessionState, WithParts } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export interface PipelineContext {
    messages: WithParts[]
    state: SessionState
    config: PluginConfig
    logger: Logger
    shouldSkip: boolean
}

export interface PipelineStage {
    name: string
    run(ctx: PipelineContext): Promise<void> | void
}

export interface PipelineDeps {
    state: SessionState
    config: PluginConfig
    logger: Logger
    client: unknown
    prompts: unknown
}
