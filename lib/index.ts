import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"
import { Logger } from "./infra/logger"
import { getConfig } from "./config"
import { createPluginEntry } from "./plugin/entry"
import { renderSystemPrompt } from "./prompts/system"
import { commands } from "./commands"
import { stripHallucinationsFromString } from "./messages/utils"
import { createSessionState } from "./state/factory"
import type { CommandContext } from "./commands/types"

const plugin: Plugin = async (_input: PluginInput) => {
    const logger = new Logger(false)
    const config = getConfig()
    const entry = createPluginEntry(config, logger)

    const hooks: Hooks = {
        "experimental.chat.messages.transform": async (_input, output) => {
            const input = _input as { sessionID?: string }
            const sessionId = input.sessionID ?? ""
            output.messages = await entry.handleMessageTransform(
                output.messages as any,
                sessionId || null,
            ) as any
        },

        "experimental.chat.system.transform": async (_input, output) => {
            const systemPrompt = renderSystemPrompt({
                compressMode: config.compress.mode,
                showCompression: config.compress.showCompression,
                manualMode: config.manualMode.enabled,
                isSubAgent: false,
                protectedTools: config.compress.protectedTools,
            })
            if (systemPrompt) {
                output.system.push(systemPrompt)
            }
        },

        "command.execute.before": async (_input, output) => {
            const input = _input as { command: string; sessionID?: string; arguments?: string }
            if (input.command !== "acp" && input.command !== "dcp") return
            const subcommand = (input.arguments ?? "").trim().split(/\s+/)[0] ?? ""
            const handler = commands[subcommand] ?? commands["help"]
            if (!handler) return
            const state = createSessionState()
            state.sessionId = input.sessionID ?? ""
            const ctx: CommandContext = {
                state,
                config,
                logger,
                args: (input.arguments ?? "").trim().split(/\s+/).slice(1),
            }
            const result = await handler(ctx)
            if (result?.output) {
                output.parts.push({
                    type: "text",
                    text: result.output,
                } as any)
            }
        },

        "experimental.text.complete": async (_input, output) => {
            output.text = stripHallucinationsFromString(output.text)
        },

        event: async (_eventInput) => {
        },

        tool: {},
    }

    return hooks
}

export default plugin
