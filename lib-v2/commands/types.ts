import type { SessionState } from "../state/types"
import type { PluginConfig } from "../config/types"
import type { Logger } from "../infra/logger"

export interface CommandContext {
    state: SessionState
    config: PluginConfig
    logger: Logger
    args: string[]
}

export interface CommandResult {
    output: string
    isError?: boolean
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult> | CommandResult
