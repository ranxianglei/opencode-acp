import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Logger } from "../lib/logger"

const TODAY = new Date().toISOString().split("T")[0]

// Point the Logger at a throwaway XDG_CONFIG_HOME so daily logs land in a temp dir.
function setup(): { configHome: string; logFile: string } {
    const configHome = mkdtempSync(join(tmpdir(), "acp-logger-test-"))
    const logFile = join(configHome, "opencode", "logs", "acp", "daily", `${TODAY}.log`)
    return { configHome, logFile }
}

function readLines(logFile: string): string[] {
    if (!existsSync(logFile)) return []
    return readFileSync(logFile, "utf-8").trimEnd().split("\n")
}

test("disabled logger: ERROR and WARN still write to the daily log", async () => {
    const { configHome, logFile } = setup()
    process.env.XDG_CONFIG_HOME = configHome
    try {
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
    } finally {
        delete process.env.XDG_CONFIG_HOME
    }
})

test("disabled logger: no log file exists before any error/warn", async () => {
    const { configHome, logFile } = setup()
    process.env.XDG_CONFIG_HOME = configHome
    try {
        const logger = new Logger(false)

        await logger.info("gated")
        await logger.debug("gated")
        assert.equal(readLines(logFile).length, 0)
        assert.equal(existsSync(logFile), false)

        await logger.warn("now a warn")
        const lines = readLines(logFile)
        assert.equal(lines.length, 1)
        assert.match(lines[0], /\bWARN\s+[\w:/.]+: now a warn \| v=(dev|\d+\.\d+\.\d+)/)
    } finally {
        delete process.env.XDG_CONFIG_HOME
    }
})

test("enabled logger: all levels write to the daily log", async () => {
    const { configHome, logFile } = setup()
    process.env.XDG_CONFIG_HOME = configHome
    try {
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
    } finally {
        delete process.env.XDG_CONFIG_HOME
    }
})

test("log line format: timestamp, padded level, component, message, version", async () => {
    const { configHome, logFile } = setup()
    process.env.XDG_CONFIG_HOME = configHome
    try {
        const logger = new Logger(false)
        await logger.error("boom")
        const [line] = readLines(logFile)
        assert.ok(line, "expected one log line")

        const [ts, level, component] = line.split(" ")
        assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
        assert.equal(level, "ERROR")
        assert.match(component, /^[\w:/.]+:$/)
        assert.match(line, /: boom \| v=(dev|\d+\.\d+\.\d+)$/)
    } finally {
        delete process.env.XDG_CONFIG_HOME
    }
})
