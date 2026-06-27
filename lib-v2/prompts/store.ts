import { promises as fs } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { Logger } from "../infra/logger"

const PROMPT_DIRS = [
    join(homedir(), ".config", "opencode", "acp-prompts"),
    join(homedir(), ".config", "opencode", "dcp-prompts"),
]

const PROJECT_PROMPT_DIR = ".opencode/acp-prompts"

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

export class PromptStore {
    private overrides = new Map<PromptKey, string>()
    private loaded = false

    constructor(private logger: Logger) {}

    async load(): Promise<void> {
        if (this.loaded) return
        this.loaded = true

        for (const key of Object.keys(FILE_MAP) as PromptKey[]) {
            const content = await this.findOverride(key)
            if (content !== null) {
                this.overrides.set(key, content)
            }
        }
    }

    private async findOverride(key: PromptKey): Promise<string | null> {
        const filename = FILE_MAP[key]

        const projectPath = join(process.cwd(), PROJECT_PROMPT_DIR, filename)
        try {
            const content = await fs.readFile(projectPath, "utf-8")
            this.logger.debug("Loaded project prompt override", { key, path: projectPath })
            return content
        } catch {}

        for (const dir of PROMPT_DIRS) {
            const filePath = join(dir, filename)
            try {
                const content = await fs.readFile(filePath, "utf-8")
                this.logger.debug("Loaded prompt override", { key, path: filePath })
                return content
            } catch {}
        }

        return null
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
}
