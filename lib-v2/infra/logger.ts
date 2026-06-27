type LogLevel = "debug" | "info" | "warn" | "error"

interface LogEntry {
    level: LogLevel
    message: string
    data?: Record<string, unknown>
    timestamp: number
}

export class Logger {
    private enabled: boolean
    private sessionId: string | null = null
    private logs: LogEntry[] = []

    constructor(enabled: boolean) {
        this.enabled = enabled
    }

    private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
        if (!this.enabled) return
        const entry: LogEntry = { level, message, data, timestamp: Date.now() }
        this.logs.push(entry)
        if (level === "error") {
            console.error(`[ACP] ${message}`, data ?? "")
        } else if (level === "warn") {
            console.warn(`[ACP] ${message}`, data ?? "")
        }
    }

    debug(message: string, data?: Record<string, unknown>): void {
        this.log("debug", message, data)
    }

    info(message: string, data?: Record<string, unknown>): void {
        this.log("info", message, data)
    }

    warn(message: string, data?: Record<string, unknown>): void {
        this.log("warn", message, data)
    }

    error(message: string, data?: Record<string, unknown>): void {
        this.log("error", message, data)
    }

    setSessionId(sessionId: string): void {
        this.sessionId = sessionId
    }

    async saveContext(sessionId: string | null, _messages: unknown): Promise<void> {
        if (!this.enabled || !sessionId) return
    }
}
