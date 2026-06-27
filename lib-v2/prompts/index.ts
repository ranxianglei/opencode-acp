import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import { renderSystemPrompt, type PromptContext } from "./system"
import { PromptStore, type PromptKey } from "./store"
import { shouldShowAgingWarning, renderAgingWarning, renderPriorityGuidance } from "./extensions/nudge"
import type { Logger } from "../infra/logger"

export interface RenderOptions {
    state: SessionState
    config: PluginConfig
    messages: WithParts[]
    logger: Logger
    store?: PromptStore
}

export function renderFullSystemPrompt(opts: RenderOptions): string {
    const { state, config, messages, store } = opts

    const ctx: PromptContext = {
        compressMode: config.compress.mode,
        showCompression: config.compress.showCompression,
        manualMode: config.manualMode.enabled,
        isSubAgent: state.isSubAgent,
        protectedTools: config.compress.protectedTools,
    }

    let base = renderSystemPrompt(ctx)

    if (store) {
        const override = store.get("system")
        if (override) base = override
    }

    const extensions = renderExtensions(opts)
    if (extensions.length > 0) {
        return `${base}\n\n${extensions.join("\n\n")}`
    }

    return base
}

function renderExtensions(opts: RenderOptions): string[] {
    const { state, config, messages, logger } = opts
    const parts: string[] = []

    const priorityGuide = renderPriorityGuidance(config, messages)
    if (priorityGuide) parts.push(priorityGuide)

    if (shouldShowAgingWarning(config, state)) {
        const warning = renderAgingWarning(state, logger)
        if (warning) parts.push(warning)
    }

    return parts
}

export { PromptStore, type PromptKey }
