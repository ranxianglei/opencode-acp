import type { CommandContext, CommandResult } from "./types"
import type { ManualModeState } from "../config/types"

export function manualCommand(ctx: CommandContext): CommandResult {
    const { state, config, args, logger } = ctx
    const configEnabled = config.manualMode.enabled

    if (args.length === 0) {
        return { output: describeManualState(state.manualMode, configEnabled) }
    }

    const arg = args[0].toLowerCase()
    if (arg !== "on" && arg !== "off") {
        return {
            output: `Unknown argument: \`${args[0]}\`. Use \`on\` or \`off\` (or no argument to show current state).`,
            isError: true,
        }
    }

    const before = state.manualMode
    if (arg === "on") {
        state.manualMode = "active"
    } else {
        state.manualMode = false
        state.pendingManualTrigger = null
    }

    logger.info("manual mode toggled", { before, after: state.manualMode })

    return { output: describeManualState(state.manualMode, configEnabled) }
}

function describeManualState(current: ManualModeState, configEnabled: boolean): string {
    const lines: string[] = ["**Manual mode**", ""]
    if (current === false) {
        lines.push("- State: off (autonomous context management)")
    } else if (current === "active") {
        lines.push("- State: active (autonomous tools suspended; only explicit /acp triggers run)")
    } else {
        lines.push(`- State: ${current} (a compress run is pending)`)
    }
    lines.push(`- Config default: ${configEnabled ? "enabled" : "disabled"}`)
    return lines.join("\n")
}
