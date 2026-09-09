import "./test-env"
import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "fs/promises"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { cwd } from "process"
import { homedir, tmpdir } from "os"
import type { PluginInput } from "@opencode-ai/plugin"
import { Logger } from "../lib/logger"
import { getConfig, type PluginConfig } from "../lib/config"
import { validateConfigTypes } from "../lib/config-validation"
import {
    getDefaultStorageDir,
    loadAllSessionStats,
    loadSessionState,
    resolveStorageDir,
    saveSessionState,
} from "../lib/state/persistence"
import {
    SessionStateRegistry,
    createSessionState,
    ensureSessionInitialized,
    resetSessionState,
} from "../lib/state"

const logger = new Logger(false)

function buildConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
    return {
        enabled: true,
        autoUpdate: false,
        debug: false,
        logLevel: "info",
        allowSubAgents: true,
        pruneNotification: "off",
        pruneNotificationType: "chat",
        commands: {
            enabled: true,
            protectedTools: [],
        },
        experimental: {
            customPrompts: false,
        },
        protectedFilePatterns: [],
        compress: {
            permission: "allow",
            showCompression: false,
            summaryBuffer: false,
            maxContextLimit: "80%",
            minContextLimit: "80%",
            nudgeFrequency: 5,
            minNudgeContextPercent: 5,
            iterationNudgeThreshold: 15,
            nudgeForce: "soft",
            protectedTools: [],
            protectTags: false,
            protectUserMessages: false,
            maxSummaryLengthHard: 20000,
            minCompressRange: 5000,
            minNudgeGrowthRatio: 0.45,
            minNudgeGrowthFloor: 5000,
            nudgeGrowthTokens: 50000,
            emergencyThresholdPercent: "98%",
            maxVisibleSegments: 50,
            keepEmbedMaxChars: 2000,
            lastSegmentSoftBlock: true,
            preserveRecentMessages: 5,
            preserveRecentTokens: 5000,
            preserveLastUserMessage: true,
        },
        gc: {
            algorithm: "truncate",
            promotionThreshold: 5,
            maxBlockAge: 15,
            maxOldGenSummaryLength: 3000,
            majorGcThresholdPercent: "100%",
            batchCleanup: { lowThreshold: "55%", highThreshold: "75%", forceThreshold: "90%" },
        },
        qualityGate: {
            enabled: false,
            algorithm: "rouge-recall-v1",
            algorithms: {
                "rouge-recall-v1": {
                    layer1MinChars: 200,
                    layer1MinRetentionPct: 5.0,
                    layer2MaxRougeF1: 0.05,
                    layer2MaxTop20Recall: 0.2,
                },
            },
        },
        messageFilters: {
            enabled: true,
            filters: {},
        },
        ...overrides,
    }
}

function makeCustomDir(): string {
    return mkdtempSync(join(tmpdir(), "acp-storage-test-"))
}

function makeSpyLogger(warnings: string[]): Logger {
    return {
        info: () => {},
        warn: (msg: string) => {
            warnings.push(msg)
        },
        error: () => {},
        debug: () => {},
    } as unknown as Logger
}

test("resolveStorageDir: unset/empty falls back to the default XDG location", () => {
    assert.equal(resolveStorageDir(undefined, "/some/project"), getDefaultStorageDir())
    assert.equal(resolveStorageDir("", "/some/project"), getDefaultStorageDir())
    assert.equal(resolveStorageDir("   ", "/some/project"), getDefaultStorageDir())
})

test("resolveStorageDir: absolute paths are used as-is", () => {
    const abs = join(tmpdir(), "acp-custom-abs")
    assert.equal(resolveStorageDir(abs, "/some/project"), abs)
})

test("resolveStorageDir: ~ and ~/... expand against the home directory", () => {
    assert.equal(resolveStorageDir("~", "/some/project"), homedir())
    assert.equal(resolveStorageDir("~/acp-data", "/some/project"), join(homedir(), "acp-data"))
})

test("resolveStorageDir: relative paths resolve against the project directory", () => {
    assert.equal(resolveStorageDir("data/acp", "/some/project"), "/some/project/data/acp")
    assert.equal(resolveStorageDir("acp", "/some/project"), "/some/project/acp")
})

test("saveSessionState writes to the configured storageDir, not the default", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        state.sessionId = "sp-save-custom"
        state.storageDir = customDir
        state.stats.totalPruneTokens = 123

        await saveSessionState(state, logger)

        assert.ok(
            existsSync(join(customDir, "sp-save-custom.json")),
            "file should be in custom dir",
        )
        assert.ok(
            !existsSync(join(getDefaultStorageDir(), "sp-save-custom.json")),
            "file should NOT be in default dir",
        )
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("loadSessionState reads from the configured storageDir", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        state.sessionId = "sp-load-custom"
        state.storageDir = customDir
        state.stats.totalPruneTokens = 456
        await saveSessionState(state, logger)

        const loaded = await loadSessionState("sp-load-custom", logger, customDir)
        assert.ok(loaded, "should load from custom dir")
        assert.equal(loaded!.stats.totalPruneTokens, 456)

        // Without the storageDir argument the default location is probed → null
        assert.equal(await loadSessionState("sp-load-custom", logger), null)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("save/load without storagePath still use the default location (regression)", async () => {
    const state = createSessionState()
    state.sessionId = "sp-default-loc"
    state.stats.totalPruneTokens = 789

    await saveSessionState(state, logger)

    const filePath = join(getDefaultStorageDir(), "sp-default-loc.json")
    try {
        assert.ok(existsSync(filePath), "file should be in default dir")
        const loaded = await loadSessionState("sp-default-loc", logger)
        assert.ok(loaded, "should load from default dir")
        assert.equal(loaded!.stats.totalPruneTokens, 789)
    } finally {
        await fs.unlink(filePath).catch(() => {})
    }
})

test("loadAllSessionStats aggregates from the configured storageDir", async () => {
    const customDir = makeCustomDir()
    try {
        for (const id of ["sp-stats-a", "sp-stats-b"]) {
            const state = createSessionState()
            state.sessionId = id
            state.storageDir = customDir
            state.stats.totalPruneTokens = 100
            await saveSessionState(state, logger)
        }

        const stats = await loadAllSessionStats(logger, customDir)
        assert.equal(stats.sessionCount, 2)
        assert.equal(stats.totalTokens, 200)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized resolves storageDir from config.storagePath", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        const config = buildConfig({ storagePath: customDir })

        await ensureSessionInitialized(
            null,
            state,
            "sp-init-resolve",
            logger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, customDir)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized resolves relative storagePath against projectDir", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "acp-proj-"))
    try {
        const state = createSessionState()
        const config = buildConfig({ storagePath: "data/acp-state" })

        await ensureSessionInitialized(
            null,
            state,
            "sp-init-relative",
            logger,
            [],
            config,
            projectDir,
        )

        assert.equal(state.storageDir, join(projectDir, "data/acp-state"))
    } finally {
        rmSync(projectDir, { recursive: true, force: true })
    }
})

test("ensureSessionInitialized warns when state file exists only at the default location", async () => {
    const customDir = makeCustomDir()
    const warnings: string[] = []
    const spyLogger = makeSpyLogger(warnings)
    try {
        // Pre-seed a valid state file at the default location
        const seeded = createSessionState()
        seeded.sessionId = "sp-migrate-warn"
        seeded.stats.totalPruneTokens = 42
        await saveSessionState(seeded, logger)

        const state = createSessionState()
        const config = buildConfig({ storagePath: customDir })
        await ensureSessionInitialized(
            null,
            state,
            "sp-migrate-warn",
            spyLogger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, customDir)
        assert.ok(
            warnings.some((w) => w.includes("storagePath")),
            `expected a storagePath warning, got: ${JSON.stringify(warnings)}`,
        )
    } finally {
        rmSync(customDir, { recursive: true, force: true })
        await fs.unlink(join(getDefaultStorageDir(), "sp-migrate-warn.json")).catch(() => {})
    }
})

test("ensureSessionInitialized does not warn when storagePath is unset", async () => {
    const warnings: string[] = []
    const spyLogger = makeSpyLogger(warnings)
    try {
        const seeded = createSessionState()
        seeded.sessionId = "sp-no-warn"
        seeded.stats.totalPruneTokens = 7
        await saveSessionState(seeded, logger)

        const state = createSessionState()
        const config = buildConfig()
        await ensureSessionInitialized(
            null,
            state,
            "sp-no-warn",
            spyLogger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, undefined)
        assert.ok(
            !warnings.some((w) => w.includes("storagePath")),
            `unexpected storagePath warning: ${JSON.stringify(warnings)}`,
        )
    } finally {
        await fs.unlink(join(getDefaultStorageDir(), "sp-no-warn.json")).catch(() => {})
    }
})

test("getConfig merges storagePath across global and project config layers", async () => {
    const savedOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    const globalConfigPath = join(
        process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "opencode",
        "acp.jsonc",
    )
    const projectDir = mkdtempSync(join(tmpdir(), "acp-cfg-proj-"))
    const opencodeDir = join(projectDir, ".opencode")
    const projectConfigPath = join(opencodeDir, "acp.jsonc")
    const globalConfigBackup = existsSync(globalConfigPath)
        ? await fs.readFile(globalConfigPath, "utf-8")
        : null

    try {
        mkdirSync(join(process.env.XDG_CONFIG_HOME!, "opencode"), { recursive: true })
        await fs.writeFile(globalConfigPath, '{ "storagePath": "/global/acp" }', "utf-8")

        const fakeCtx = {
            directory: projectDir,
            client: { tui: { showToast: () => {} } },
        } as unknown as PluginInput

        // Global layer only
        let config = getConfig(fakeCtx)
        assert.equal(config.storagePath, "/global/acp", "global layer should apply")

        // Project layer overrides global
        mkdirSync(opencodeDir, { recursive: true })
        await fs.writeFile(projectConfigPath, '{ "storagePath": "/project/acp" }', "utf-8")
        config = getConfig(fakeCtx)
        assert.equal(config.storagePath, "/project/acp", "project layer should win")

        // No config anywhere → unset (default location)
        await fs.unlink(globalConfigPath)
        rmSync(opencodeDir, { recursive: true, force: true })
        config = getConfig(fakeCtx)
        assert.equal(config.storagePath, undefined, "unset by default")
    } finally {
        if (globalConfigBackup !== null) {
            await fs.writeFile(globalConfigPath, globalConfigBackup, "utf-8")
        } else {
            await fs.unlink(globalConfigPath).catch(() => {})
        }
        rmSync(projectDir, { recursive: true, force: true })
        if (savedOpenCodeConfigDir === undefined) {
            delete process.env.OPENCODE_CONFIG_DIR
        } else {
            process.env.OPENCODE_CONFIG_DIR = savedOpenCodeConfigDir
        }
    }
})

test("validateConfigTypes rejects non-string storagePath", () => {
    assert.equal(
        validateConfigTypes({ storagePath: 42 }).some((e) => e.key === "storagePath"),
        true,
        "numeric storagePath should produce a validation error",
    )
    assert.equal(
        validateConfigTypes({ storagePath: "/valid/path" }).some((e) => e.key === "storagePath"),
        false,
        "string storagePath should not produce a validation error",
    )
    assert.equal(
        validateConfigTypes({ storagePath: undefined }).some((e) => e.key === "storagePath"),
        false,
        "undefined storagePath should not produce a validation error",
    )
})

test("ensureSessionInitialized resumes state from the custom location without warning", async () => {
    const customDir = makeCustomDir()
    const warnings: string[] = []
    const spyLogger = makeSpyLogger(warnings)
    try {
        // Seed DIFFERENT values at custom and default locations
        const customSeeded = createSessionState()
        customSeeded.sessionId = "sp-resume-custom"
        customSeeded.storageDir = customDir
        customSeeded.stats.totalPruneTokens = 111
        await saveSessionState(customSeeded, logger)

        const defaultSeeded = createSessionState()
        defaultSeeded.sessionId = "sp-resume-custom"
        defaultSeeded.stats.totalPruneTokens = 222
        await saveSessionState(defaultSeeded, logger)

        const state = createSessionState()
        const config = buildConfig({ storagePath: customDir })
        await ensureSessionInitialized(
            null,
            state,
            "sp-resume-custom",
            spyLogger,
            [],
            config,
            "/some/project",
        )

        assert.equal(state.storageDir, customDir)
        assert.equal(
            state.stats.totalPruneTokens,
            111,
            "state must be restored from the custom location, not the default",
        )
        assert.equal(warnings.length, 0, `expected no warnings, got: ${JSON.stringify(warnings)}`)
    } finally {
        rmSync(customDir, { recursive: true, force: true })
        await fs.unlink(join(getDefaultStorageDir(), "sp-resume-custom.json")).catch(() => {})
    }
})

test("ensureSessionInitialized falls back to process.cwd() when projectDir is omitted", async () => {
    const state = createSessionState()
    const config = buildConfig({ storagePath: "data/acp-cwd" })

    await ensureSessionInitialized(null, state, "sp-init-cwd", logger, [], config)

    assert.equal(state.storageDir, join(cwd(), "data/acp-cwd"))
})

test("saveSessionState does not persist the transient storageDir field", async () => {
    const customDir = makeCustomDir()
    try {
        const state = createSessionState()
        state.sessionId = "sp-no-leak"
        state.storageDir = customDir
        state.stats.totalPruneTokens = 5

        await saveSessionState(state, logger)

        const raw = JSON.parse(await fs.readFile(join(customDir, "sp-no-leak.json"), "utf-8"))
        assert.equal("storageDir" in raw, false, "storageDir must not appear in the persisted JSON")
    } finally {
        rmSync(customDir, { recursive: true, force: true })
    }
})

test("SessionStateRegistry.getOrCreate passes projectDir for relative storagePath resolution", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "acp-registry-"))
    try {
        const registry = new SessionStateRegistry(logger, projectDir)
        const config = buildConfig({ storagePath: "data/acp-registry" })

        const state = await registry.getOrCreate(null, "sp-registry-proj", [], config)

        assert.equal(state.storageDir, join(projectDir, "data/acp-registry"))
    } finally {
        rmSync(projectDir, { recursive: true, force: true })
    }
})

test("resetSessionState clears the transient storageDir", () => {
    const state = createSessionState()
    state.storageDir = "/some/custom/dir"

    resetSessionState(state)

    assert.equal(state.storageDir, undefined)
})
