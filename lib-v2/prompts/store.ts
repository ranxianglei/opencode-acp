import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Logger } from "../infra/logger"
import { COMPRESS_RANGE_PROMPT } from "./compress-range"
import { COMPRESS_MESSAGE_PROMPT } from "./compress-message"

export type PromptKey =
    | "system"
    | "compress-range"
    | "compress-message"
    | "context-limit-nudge"
    | "turn-nudge"
    | "iteration-nudge"

const FILE_MAP: Record<PromptKey, string> = {
    system: "system.md",
    "compress-range": "compress-range.md",
    "compress-message": "compress-message.md",
    "context-limit-nudge": "context-limit-nudge.md",
    "turn-nudge": "turn-nudge.md",
    "iteration-nudge": "iteration-nudge.md",
}

export interface RuntimePrompts {
    system: string
    compressRange: string
    compressMessage: string
    contextLimitNudge: string
    turnNudge: string
    iterationNudge: string
}

function getConfigHome(): string {
    return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

const DEFAULT_SYSTEM_PROMPT = [
    "You operate in a context-constrained environment.",
    "Context management helps preserve retrieval quality.",
    "The `<dcp-message-id>` and `<dcp-system-reminder>` tags are environment-injected metadata.",
    "Do not output them.",
    "",
    "You have access to a `compress` tool for context management.",
    "Use it to proactively summarize completed sections into high-fidelity summaries.",
].join("\n")

const DEFAULT_CONTEXT_LIMIT_NUDGE = `[Context pressure rising] Consider using the compress tool to free context.`
const DEFAULT_TURN_NUDGE = `[Context management reminder] Consider compressing completed work.`
const DEFAULT_ITERATION_NUDGE = `[Many messages since last user input] Consider compressing completed work.`

export class PromptStore {
    private overrides = new Map<PromptKey, string>()

    constructor(
        private logger: Logger,
        private workspaceDir?: string,
        private isProject?: boolean,
    ) {
        this.loadSync()
    }

    private loadSync(): void {
        for (const key of Object.keys(FILE_MAP) as PromptKey[]) {
            const content = this.findOverrideSync(key)
            if (content !== null) {
                this.overrides.set(key, content)
            }
        }
    }

    private findOverrideSync(key: PromptKey): string | null {
        const filename = FILE_MAP[key]

        if (this.workspaceDir && this.isProject) {
            const projectPath = join(this.workspaceDir, ".opencode", "acp-prompts", filename)
            const content = this.tryRead(projectPath)
            if (content !== null) return content
        }

        const configHome = getConfigHome()
        const dirs = [
            join(configHome, "opencode", "dcp-prompts", "overrides"),
            join(configHome, "opencode", "acp-prompts"),
            join(configHome, "opencode", "dcp-prompts"),
        ]

        for (const dir of dirs) {
            const content = this.tryRead(join(dir, filename))
            if (content !== null) return content
        }

        return null
    }

    private tryRead(path: string): string | null {
        try {
            if (!existsSync(path)) return null
            const content = readFileSync(path, "utf-8")
            this.logger.debug("Loaded prompt override", { path })
            return content
        } catch {
            return null
        }
    }

    get(key: PromptKey): string | undefined {
        return this.overrides.get(key)
    }

    has(key: PromptKey): boolean {
        return this.overrides.has(key)
    }

    set(key: PromptKey, content: string): void {
        this.overrides.set(key, content)
    }

    clear(key: PromptKey): void {
        this.overrides.delete(key)
    }

    keys(): PromptKey[] {
        return [...this.overrides.keys()]
    }

    getRuntimePrompts(): RuntimePrompts {
        return {
            system: this.overrides.get("system") ?? DEFAULT_SYSTEM_PROMPT,
            compressRange: this.overrides.get("compress-range") ?? COMPRESS_RANGE_PROMPT,
            compressMessage: this.overrides.get("compress-message") ?? COMPRESS_MESSAGE_PROMPT,
            contextLimitNudge: this.overrides.get("context-limit-nudge") ?? DEFAULT_CONTEXT_LIMIT_NUDGE,
            turnNudge: this.overrides.get("turn-nudge") ?? DEFAULT_TURN_NUDGE,
            iterationNudge: this.overrides.get("iteration-nudge") ?? DEFAULT_ITERATION_NUDGE,
        }
    }
}
