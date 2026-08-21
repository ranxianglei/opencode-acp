import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger, type LogLevel } from "../lib/logger"

// Point the Logger at a throwaway XDG_CONFIG_HOME so daily logs land in a temp dir.
function setup(): { configHome: string; logFile: string } {
    const configHome = mkdtempSync(join(tmpdir(), "acp-logger-test-"))
    // Compute the daily-log date here (per test) rather than at module load, so the
    // expected path stays in sync with the date the Logger computes at write time.
    const today = new Date().toISOString().split("T")[0]
    const logFile = join(configHome, "opencode", "logs", "acp", "daily", `${today}.log`)
    return { configHome, logFile }
}

function readLines(logFile: string): string[] {
    if (!existsSync(logFile)) return []
    return readFileSync(logFile, "utf-8").trimEnd().split("\n")
}

function withConfigHome(configHome: string, fn: () => Promise<void>) {
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = configHome
    return fn().finally(() => {
        // Restore the prior value instead of unconditionally deleting it.
        if (prev === undefined) {
            delete process.env.XDG_CONFIG_HOME
        } else {
            process.env.XDG_CONFIG_HOME = prev
        }
    })
}

test("disabled logger: ERROR and WARN still write to the daily log", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(false)

        await logger.error("state load failed", { error: "EACCES" })
        await logger.warn("quality gate FAILED", { blockId: 3 })
        await logger.info("info should be gated", { a: 1 })
        await logger.debug("debug should be gated", { a: 1 })

        const lines = readLines(logFile)
        assert.equal(lines.length, 2)
        // component token is environment-dependent (bundle filename in production,
        // runner frame in tests) — assert structure, not the exact component name.
        assert.match(lines[0], /\bERROR\s+[\w:/.]+: state load failed \| error=EACCES \| v=(dev|\d+\.\d+\.\d+)/)
        assert.match(lines[1], /\bWARN\s+[\w:/.]+: quality gate FAILED \| blockId=3 \| v=(dev|\d+\.\d+\.\d+)/)
    })
})

test("disabled logger: no log file exists before any error/warn", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(false)

        await logger.info("gated")
        await logger.debug("gated")
        assert.equal(readLines(logFile).length, 0)
        assert.equal(existsSync(logFile), false)

        await logger.warn("now a warn")
        const lines = readLines(logFile)
        assert.equal(lines.length, 1)
        assert.match(lines[0], /\bWARN\s+[\w:/.]+: now a warn \| v=(dev|\d+\.\d+\.\d+)/)
    })
})

test("enabled logger: all levels write to the daily log", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(true)

        await logger.debug("debug event")
        await logger.info("info event")
        await logger.warn("warn event", { reason: "phantom" })
        await logger.error("error event")

        const lines = readLines(logFile)
        assert.equal(lines.length, 4)
        assert.match(lines[0], /\bDEBUG\s+[\w:/.]+: debug event \| v=(dev|\d+\.\d+\.\d+)/)
        assert.match(lines[1], /\bINFO\s+[\w:/.]+: info event \| v=(dev|\d+\.\d+\.\d+)/)
        assert.match(lines[2], /\bWARN\s+[\w:/.]+: warn event \| reason=phantom \| v=(dev|\d+\.\d+\.\d+)/)
        assert.match(lines[3], /\bERROR\s+[\w:/.]+: error event \| v=(dev|\d+\.\d+\.\d+)/)
    })
})

test("log line format: timestamp, padded level, component, message, version", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(false)
        await logger.error("boom")
        const [line] = readLines(logFile)
        assert.ok(line, "expected one log line")

        const [ts, level, component] = line.split(" ")
        assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        assert.equal(level, "ERROR")
        assert.match(component, /^[\w:/.]+:$/)
        assert.match(line, /: boom \| v=(dev|\d+\.\d+\.\d+)$/)
    })
})

test("explicit info level: INFO/WARN/ERROR write, DEBUG gated (default-on logging)", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(false, "info")

        await logger.info("decision event", { tier: 1 })
        await logger.warn("warn event")
        await logger.error("error event")
        await logger.debug("debug gated")

        const lines = readLines(logFile)
        assert.equal(lines.length, 3)
        assert.match(lines[0], /\bINFO\s+[\w:/.]+: decision event \| tier=1 \| v=/)
        assert.match(lines[1], /\bWARN\s+/)
        assert.match(lines[2], /\bERROR\s+/)
    })
})

test("explicit silent level: nothing writes, even errors", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(true, "silent")

        await logger.error("swallowed")
        assert.equal(existsSync(logFile), false)
    })
})

test("error level: only ERROR writes", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        const logger = new Logger(false, "error")

        await logger.warn("gated")
        await logger.error("kept")

        const lines = readLines(logFile)
        assert.equal(lines.length, 1)
        assert.match(lines[0], /\bERROR\s+[\w:/.]+: kept \| v=/)
    })
})

test("enabled getter reflects explicit level, not the boolean flag", async () => {
    const { configHome } = setup()
    await withConfigHome(configHome, async () => {
        assert.equal(new Logger(false).enabled, false)
        assert.equal(new Logger(true).enabled, true)
        assert.equal(new Logger(false, "info").enabled, false)
        assert.equal(new Logger(true, "info").enabled, false)
        assert.equal(new Logger(false, "debug").enabled, true)
    })
})

test("invalid explicit level falls back to legacy mapping instead of silencing all logs", async () => {
    const { configHome, logFile } = setup()
    await withConfigHome(configHome, async () => {
        // Config validation is warn-only: a typo like "verbose" reaches the
        // constructor at runtime. It must degrade to the boolean mapping
        // (false → warn), never to "every gate fails → nothing writes".
        const logger = new Logger(false, "verbose" as LogLevel)
        await logger.error("even errors must survive a bad level")
        assert.equal(readLines(logFile).length, 1)

        const logger2 = new Logger(true, "verbose" as LogLevel)
        assert.equal(logger2.level, "debug")
    })
})
