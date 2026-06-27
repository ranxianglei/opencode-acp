import type { PluginConfig } from "../../config/types"

export function renderProtectedToolsExtension(config: PluginConfig): string {
    const allProtected = new Set<string>([
        ...config.commands.protectedTools,
        ...config.compress.protectedTools,
    ])

    if (allProtected.size === 0) return ""

    const tools = [...allProtected].sort().join(", ")
    return `Protected tools (their output is never compressed): ${tools}`
}

export function renderManualModeExtension(config: PluginConfig): string {
    if (!config.manualMode.enabled) return ""

    let text = "Manual compression mode is active."

    if (!config.manualMode.automaticStrategies) {
        text += " Automatic strategies (deduplication, error purging) are disabled."
    }

    return text
}

export function renderSubAgentExtension(config: PluginConfig): string {
    if (!config.experimental.allowSubAgents) return ""

    return "Sub-agent sessions are enabled. Compression may behave differently for sub-agent contexts."
}

export function renderCustomPromptsExtension(config: PluginConfig): string {
    if (!config.experimental.customPrompts) return ""

    return "Custom prompt overrides are enabled. System prompt may differ from defaults."
}
