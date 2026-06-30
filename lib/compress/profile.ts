import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "./types"
import * as fs from "fs"
import * as path from "path"

export type CompressionProfile = "aggressive" | "balanced" | "conservative"

export const PROFILES: Record<CompressionProfile, {
    normalHint: string
    summaryLimit: number
    protectedItems: string
    compressFrequency: number
    largeOutputThreshold: number
}> = {
    aggressive: {
        normalHint: "Compress frequently — keep only final outcomes and key results. Context is disposable for short tasks.",
        summaryLimit: 100,
        protectedItems: "Protect only user instructions.",
        compressFrequency: 4,
        largeOutputThreshold: 2000,
    },
    balanced: {
        normalHint: "After completing a task or sub-task, compress its tool outputs into summaries. Do NOT compress content you're actively using for an ongoing task.",
        summaryLimit: 200,
        protectedItems: "Protect user instructions, key decisions, file paths, and important findings.",
        compressFrequency: 6,
        largeOutputThreshold: 5000,
    },
    conservative: {
        normalHint: "Compress ONLY verbose logs and obvious duplicates. NEVER compress experiment results, metrics, architectural decisions, code structure, or file paths.",
        summaryLimit: 400,
        protectedItems: "Protect everything in balanced PLUS: experiment results (PPL, accuracy, loss), metrics, code structure, previous experiment comparisons.",
        compressFrequency: 10,
        largeOutputThreshold: 10000,
    },
}

export function getSessionConfigPath(sessionId: string): string {
    const configDir = path.join(process.env.HOME || "~", ".config", "opencode", "acp-status")
    return path.join(configDir, `${sessionId}.json`)
}

export function getSessionProfile(sessionId: string, defaultProfile: CompressionProfile): CompressionProfile {
    try {
        const filePath = getSessionConfigPath(sessionId)
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, "utf-8"))
            if (data.compressionProfile && data.compressionProfile in PROFILES) {
                return data.compressionProfile as CompressionProfile
            }
        }
    } catch {}
    return defaultProfile
}

export function setSessionProfile(sessionId: string, profile: CompressionProfile): void {
    const filePath = getSessionConfigPath(sessionId)
    const configDir = path.dirname(filePath)
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
    }

    let existing: Record<string, unknown> = {}
    try {
        if (fs.existsSync(filePath)) {
            existing = JSON.parse(fs.readFileSync(filePath, "utf-8"))
        }
    } catch {}

    existing.compressionProfile = profile
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8")
}

export function createSetCompressionProfileTool(ctx: ToolContext): ReturnType<typeof tool> {
    return tool({
        description: "Set the compression profile for this session. Use 'conservative' for long experiments, 'aggressive' for short tasks, 'balanced' for general development.",
        args: {
            profile: tool.schema
                .string()
                .describe("Compression profile: 'aggressive' (short tasks), 'balanced' (default), 'conservative' (long experiments)")
                .optional(),
        },
        async execute(args, toolCtx) {
            const sessionId = ctx.state.sessionId || toolCtx?.sessionID || "unknown"

            if (!args.profile) {
                const current = getSessionProfile(sessionId, "balanced")
                const config = PROFILES[current]
                return `Current compression profile: ${current}\n` +
                    `Summary limit: ${config.summaryLimit} chars\n` +
                    `Compress frequency: every ${config.compressFrequency} turns\n` +
                    `Available: aggressive, balanced, conservative`
            }

            const profile = args.profile as CompressionProfile
            if (!(profile in PROFILES)) {
                throw new Error(`Invalid profile: ${profile}. Use: aggressive, balanced, or conservative`)
            }

            setSessionProfile(sessionId, profile)
            const config = PROFILES[profile]

            return `✅ Compression profile set to: ${profile}\n` +
                `Summary limit: ${config.summaryLimit} chars\n` +
                `Compress frequency: every ${config.compressFrequency} turns\n` +
                `Large output threshold: ${config.largeOutputThreshold} chars\n` +
                `${config.normalHint}`
        },
    })
}
