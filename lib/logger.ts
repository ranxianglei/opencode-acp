import { writeFile, mkdir } from "fs/promises"
import { join } from "path"
import { existsSync } from "fs"
import { homedir } from "os"

/** ACP version, injected at build time by tsup define */
declare const ACP_VERSION: string | undefined

const LOG_VERSION = typeof ACP_VERSION !== "undefined" ? ACP_VERSION : "dev"

/**
 * Log verbosity. Production default is `info` — decision-level events
 * (nudge tiers, compression runs, gate verdicts, config resolution) are
 * written to the daily log WITHOUT requiring `debug: true`. `debug` adds
 * per-message detail and per-request context snapshots; `warn`/`error`
 * reduce to failures only; `silent` disables file output entirely.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 99,
}

export class Logger {
    private logDir: string
    /** Resolved verbosity; replaces the old boolean `enabled` flag. */
    public readonly level: LogLevel

    /**
     * @param enabled legacy boolean toggle — `true` maps to `debug`,
     *                `false` maps to `warn` (errors + warnings only).
     * @param level   explicit verbosity; when given it wins over `enabled`.
     */
    constructor(enabled: boolean, level?: LogLevel) {
        this.level = level ?? (enabled ? "debug" : "warn")
        const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
        this.logDir = join(configHome, "opencode", "logs", "acp")
    }

    /** Back-compat view of the old flag: true only at full debug verbosity. */
    get enabled(): boolean {
        return this.level === "debug"
    }

    private shouldWrite(level: LogLevel): boolean {
        return LEVEL_RANK[level] >= LEVEL_RANK[this.level]
    }

    private async ensureLogDir() {
        if (!existsSync(this.logDir)) {
            await mkdir(this.logDir, { recursive: true })
        }
    }

    private formatData(data?: any): string {
        if (!data) return ""

        const parts: string[] = []
        for (const [key, value] of Object.entries(data)) {
            if (value === undefined || value === null) continue

            // Format arrays compactly
            if (Array.isArray(value)) {
                if (value.length === 0) continue
                parts.push(
                    `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
                )
            } else if (typeof value === "object") {
                const str = JSON.stringify(value)
                if (str.length < 50) {
                    parts.push(`${key}=${str}`)
                }
            } else {
                parts.push(`${key}=${value}`)
            }
        }
        return parts.join(" ")
    }

    private getCallerFile(skipFrames: number = 3): string {
        const originalPrepareStackTrace = Error.prepareStackTrace
        try {
            const err = new Error()
            Error.prepareStackTrace = (_, stack) => stack
            const stack = err.stack as unknown as NodeJS.CallSite[]
            Error.prepareStackTrace = originalPrepareStackTrace

            // Skip specified number of frames to get to actual caller
            for (let i = skipFrames; i < stack.length; i++) {
                const filename = stack[i]?.getFileName()
                if (filename && !filename.includes("/logger.")) {
                    // Extract just the filename without path and extension
                    const match = filename.match(/([^/\\]+)\.[tj]s$/)
                    return match ? match[1] : filename
                }
            }
            return "unknown"
        } catch {
            return "unknown"
        }
    }

    private async write(level: string, component: string, message: string, data?: unknown) {
        // Levels below the resolved verbosity are dropped here; WARN/ERROR
        // still land by default because the production default is `info`.
        if (!this.shouldWrite(level.toLowerCase() as LogLevel)) return

        try {
            await this.ensureLogDir()

            const timestamp = new Date().toISOString()
            const dataStr = this.formatData(data)

            const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""} | v=${LOG_VERSION}\n`

            const dailyLogDir = join(this.logDir, "daily")
            if (!existsSync(dailyLogDir)) {
                await mkdir(dailyLogDir, { recursive: true })
            }

            const logFile = join(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`)
            await writeFile(logFile, logLine, { flag: "a" })
        } catch (error) {}
    }

    info(message: string, data?: unknown) {
        const component = this.getCallerFile(2)
        return this.write("INFO", component, message, data)
    }

    debug(message: string, data?: unknown) {
        const component = this.getCallerFile(2)
        return this.write("DEBUG", component, message, data)
    }

    warn(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("WARN", component, message, data)
    }

    error(message: string, data?: any) {
        const component = this.getCallerFile(2)
        return this.write("ERROR", component, message, data)
    }

    /**
     * Strips unnecessary metadata from messages for cleaner debug logs.
     *
     * Removed:
     * - All IDs (id, sessionID, messageID, parentID)
     * - summary, path, cost, model, agent, mode, finish, providerID, modelID
     * - step-start and step-finish parts entirely
     * - snapshot fields
     * - ignored text parts
     *
     * Kept:
     * - role, time (created only), tokens (input, output, reasoning, cache)
     * - text, reasoning, tool parts with content
     * - tool calls with: tool, callID, input, output, metadata
     */
    private minimizeForDebug(messages: any[]): any[] {
        return messages.map((msg) => {
            const minimized: any = {
                role: msg.info?.role,
            }

            if (msg.info?.time?.created) {
                minimized.time = msg.info.time.created
            }

            if (msg.info?.tokens) {
                minimized.tokens = {
                    input: msg.info.tokens.input,
                    output: msg.info.tokens.output,
                    reasoning: msg.info.tokens.reasoning,
                    cache: msg.info.tokens.cache,
                }
            }

            if (msg.parts) {
                minimized.parts = msg.parts
                    .map((part: any) => {
                        if (part.type === "step-start" || part.type === "step-finish") {
                            return null
                        }

                        if (part.type === "text") {
                            if (part.ignored) return null
                            const textPart: any = { type: "text", text: part.text }
                            if (part.metadata) textPart.metadata = part.metadata
                            return textPart
                        }

                        if (part.type === "reasoning") {
                            const reasoningPart: any = { type: "reasoning", text: part.text }
                            if (part.metadata) reasoningPart.metadata = part.metadata
                            return reasoningPart
                        }

                        if (part.type === "tool") {
                            const toolPart: any = {
                                type: "tool",
                                tool: part.tool,
                                callID: part.callID,
                            }

                            if (part.state?.status) {
                                toolPart.status = part.state.status
                            }
                            if (part.state?.input) {
                                toolPart.input = part.state.input
                            }
                            if (part.state?.output) {
                                toolPart.output = part.state.output
                            }
                            if (part.state?.error) {
                                toolPart.error = part.state.error
                            }
                            if (part.metadata) {
                                toolPart.metadata = part.metadata
                            }
                            if (part.state?.metadata) {
                                toolPart.metadata = {
                                    ...(toolPart.metadata || {}),
                                    ...part.state.metadata,
                                }
                            }
                            if (part.state?.title) {
                                toolPart.title = part.state.title
                            }

                            return toolPart
                        }

                        return null
                    })
                    .filter(Boolean)
            }

            return minimized
        })
    }

    async saveContext(sessionId: string, messages: unknown[]) {
        if (this.level !== "debug") return

        try {
            const contextDir = join(this.logDir, "context", sessionId)
            if (!existsSync(contextDir)) {
                await mkdir(contextDir, { recursive: true })
            }

            const minimized = this.minimizeForDebug(messages).filter(
                (msg) => msg.parts && msg.parts.length > 0,
            )
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
            const contextFile = join(contextDir, `${timestamp}.json`)
            await writeFile(contextFile, JSON.stringify(minimized, null, 2))

            const versionFile = join(contextDir, "_version")
            if (!existsSync(versionFile)) {
                await writeFile(versionFile, LOG_VERSION)
            }
        } catch (error) {}
    }
}
