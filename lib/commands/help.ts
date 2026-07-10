/**
 * ACP Help command handler.
 * Shows available ACP commands and their descriptions.
 */

import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { SessionState, WithParts } from "../state"
import { compressPermission } from "../compress-permission"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"

export interface HelpCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
}

const BASE_COMMANDS: [string, string][] = [
    ["/acp context", "Show token usage breakdown for current session"],
    ["/acp stats", "Show ACP pruning statistics"],
    ["/acp sweep [n]", "Prune tools since last user message, or last n tools"],
    ["/acp manual [on|off]", "Toggle manual mode or set explicit state"],
]

const TOOL_COMMANDS: Record<string, [string, string]> = {
    compress: ["/acp compress [focus]", "Trigger manual compress tool execution"],
    decompress: ["/acp decompress <n>", "Restore selected compression"],
    recompress: ["/acp recompress <n>", "Re-apply a user-decompressed compression"],
}

function getVisibleCommands(state: SessionState, config: PluginConfig): [string, string][] {
    const commands = [...BASE_COMMANDS]

    if (compressPermission(state, config) !== "deny") {
        commands.push(TOOL_COMMANDS.compress)
        commands.push(TOOL_COMMANDS.decompress)
        commands.push(TOOL_COMMANDS.recompress)
    }

    return commands
}

function formatHelpMessage(state: SessionState, config: PluginConfig): string {
    const commands = getVisibleCommands(state, config)
    const colWidth = Math.max(...commands.map(([cmd]) => cmd.length)) + 4
    const lines: string[] = []

    lines.push("╭─────────────────────────────────────────────────────────────────────────╮")
    lines.push("│                              ACP Commands                               │")
    lines.push("╰─────────────────────────────────────────────────────────────────────────╯")
    lines.push("")
    lines.push(`  ${"Manual mode:".padEnd(colWidth)}${state.manualMode ? "ON" : "OFF"}`)
    lines.push("")
    for (const [cmd, desc] of commands) {
        lines.push(`  ${cmd.padEnd(colWidth)}${desc}`)
    }
    lines.push("")

    return lines.join("\n")
}

export async function handleHelpCommand(ctx: HelpCommandContext): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx

    const { config } = ctx
    const message = formatHelpMessage(state, config)

    const params = getCurrentParams(state, messages, logger)
    await sendIgnoredMessage(client, sessionId, message, params, logger, config)

    logger.info("Help command executed")
}
