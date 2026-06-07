import type { RuntimePrompts } from "./store"
export type { PromptStore, RuntimePrompts } from "./store"

export function renderSystemPrompt(
    prompts: RuntimePrompts,
    protectedToolsExtension?: string,
    manual?: boolean,
    subagent?: boolean,
): string {
    const extensions: string[] = []

    if (protectedToolsExtension) {
        extensions.push(protectedToolsExtension.trim())
    }

    if (manual) {
        extensions.push(prompts.manualExtension.trim())
    }

    if (subagent) {
        extensions.push(prompts.subagentExtension.trim())
    }

    // decompress extension is always included when compress is not denied
    // (the caller guards on permission === "deny" before reaching renderSystemPrompt)
    extensions.push(prompts.decompressExtension.trim())

    return [prompts.system.trim(), ...extensions]
        .filter(Boolean)
        .join("\n\n")
        .replace(/\n([ \t]*\n)+/g, "\n\n")
        .trim()
}
