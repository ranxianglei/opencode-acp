import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Logger } from "../lib/logger"
import { PromptStore } from "../lib/prompts/store"
import { buildSystemPrompt } from "../lib/prompts/system"
import { buildCompressRangePrompt } from "../lib/prompts/compress-range"
import {
    PROMPT_PACK_IDS,
    LEAN_HOW_TO_COMPRESS,
    LEAN_DECOMPRESS_DESCRIPTION,
    LEAN_SEARCH_CONTEXT_DESCRIPTION,
    LEAN_ACP_STATUS_DESCRIPTION,
    LEAN_ACP_CONTEXT_RECAP_DESCRIPTION,
    DEFAULT_DECOMPRESS_DESCRIPTION,
    DEFAULT_SEARCH_CONTEXT_DESCRIPTION,
    DEFAULT_ACP_STATUS_DESCRIPTION,
    DEFAULT_ACP_CONTEXT_RECAP_DESCRIPTION,
    buildLeanSystemPrompt,
    buildLeanCompressRangePrompt,
    buildPackSystemPrompt,
    buildPackCompressRangePrompt,
    getToolDescriptions,
} from "../lib/prompts/packs"
import { validateConfigTypes, getInvalidConfigKeys } from "../lib/config-validation"
import { mergeCompress } from "../lib/config"
import type { PluginConfig } from "../lib/config"

// Constructed programmatically so this line stays greppable despite the
// environment's display filter stripping raw tag names from tool output.
const MSG_ID_TAG = ["<", "dcp-message-id", ">"].join("")

test("PROMPT_PACK_IDS lists both packs", () => {
    assert.deepEqual([...PROMPT_PACK_IDS], ["default", "lean"])
})

test("lean system prompt is materially shorter than default (both modes)", () => {
    for (const candidates of [false, true]) {
        const lean = buildLeanSystemPrompt(candidates)
        const full = buildSystemPrompt(candidates)
        assert.ok(
            lean.length > 0 && lean.length < full.length * 0.8,
            `candidates=${candidates}: lean ${lean.length} chars should be < 80% of full ${full.length}`,
        )
    }
})

test("lean system prompt keeps the load-bearing contract elements", () => {
    const lean = buildLeanSystemPrompt(false)
    for (const fragment of [
        "HOW TO COMPRESS",
        "KEEP VERBATIM",
        "DROP",
        "PRIORITY",
        "INTEGRITY",
        "COMPRESSION SUMMARIES IN CONTEXT",
        MSG_ID_TAG,
        "[Tier 2 Trigger]",
        "CONTEXT BREAKDOWN",
        "m000123",
    ]) {
        assert.ok(
            lean.includes(fragment),
            `lean system prompt must contain ${JSON.stringify(fragment)}`,
        )
    }
})

test("lean candidates variant adds candidate guidance; ranges variant omits it", () => {
    const withCandidates = buildLeanSystemPrompt(true)
    const withoutCandidates = buildLeanSystemPrompt(false)
    assert.match(withCandidates, /COMPRESSION CANDIDATES/)
    assert.match(withCandidates, /MICRO/)
    assert.match(withCandidates, /EPISODE/)
    assert.doesNotMatch(withoutCandidates, /COMPRESSION CANDIDATES/)
})

test("lean HWC keeps every KEEP VERBATIM class and the integrity rule", () => {
    for (const fragment of [
        "File paths",
        "signature",
        "Error messages",
        "Decisions with rationale",
        "Exact values",
        "User intent",
        "goal and its evolution",
        "Purpose behind",
        "Open questions",
        "Message refs",
        "PENDING",
        "simulated transcript",
    ]) {
        assert.ok(
            LEAN_HOW_TO_COMPRESS.includes(fragment),
            `LEAN_HOW_TO_COMPRESS must keep ${JSON.stringify(fragment)}`,
        )
    }
})

test("lean compress-range prompt is shorter and keeps boundary/marker rules", () => {
    const lean = buildLeanCompressRangePrompt(false)
    const full = buildCompressRangePrompt(false)
    assert.ok(lean.length < full.length * 0.8)
    assert.match(lean, /Collapse a range in the conversation into a detailed summary/i)
    assert.match(lean, /mNNNNN/)
    assert.match(lean, /\(bN\)/)
    assert.match(lean, /\[\[KEEP:mNNNNN\]\]/)
    assert.match(lean, /\[\[REF:mNNNNN\|description\]\]/)
    assert.match(lean, /content`/)
})

test("lean candidates variant of compress-range prompt adds advisory guidance", () => {
    const withCandidates = buildLeanCompressRangePrompt(true)
    const withoutCandidates = buildLeanCompressRangePrompt(false)
    assert.match(withCandidates, /CANDIDATE GUIDANCE/)
    assert.match(withCandidates, /advisory/)
    assert.doesNotMatch(withoutCandidates, /CANDIDATE GUIDANCE/)
})

test("lean tool descriptions are shorter than defaults and keep key semantics", () => {
    const pairs: Array<[string, string, RegExp]> = [
        [LEAN_DECOMPRESS_DESCRIPTION, DEFAULT_DECOMPRESS_DESCRIPTION, /toFile/],
        [
            LEAN_SEARCH_CONTEXT_DESCRIPTION,
            DEFAULT_SEARCH_CONTEXT_DESCRIPTION,
            /before decompressing/i,
        ],
        [LEAN_ACP_STATUS_DESCRIPTION, DEFAULT_ACP_STATUS_DESCRIPTION, /scope:"uncompressed"/],
        [
            LEAN_ACP_CONTEXT_RECAP_DESCRIPTION,
            DEFAULT_ACP_CONTEXT_RECAP_DESCRIPTION,
            /lists all active blocks/,
        ],
    ]
    for (const [lean, full, semantic] of pairs) {
        // Phase 1 already trimmed the default descriptions, so lean-vs-default
        // savings are modest; assert a clear reduction rather than a fixed ratio floor.
        assert.ok(
            lean.length > 0 && lean.length < full.length * 0.8,
            `lean description (${lean.length} chars) should be < 80% of full (${full.length})`,
        )
        assert.match(lean, semantic)
    }
    // decompress lean must keep the two safety-critical warnings
    assert.match(LEAN_DECOMPRESS_DESCRIPTION, /full:true/)
    assert.match(LEAN_DECOMPRESS_DESCRIPTION, /in parallel with compress/)
})

test("default tool descriptions preserved verbatim after the move to packs.ts", () => {
    assert.ok(DEFAULT_DECOMPRESS_DESCRIPTION.startsWith("Restores previously compressed content"))
    assert.ok(
        DEFAULT_DECOMPRESS_DESCRIPTION.includes("Do NOT call this tool in parallel with compress"),
    )
    assert.ok(DEFAULT_DECOMPRESS_DESCRIPTION.includes("/tmp or ~/.cache/opencode/"))
    assert.ok(DEFAULT_SEARCH_CONTEXT_DESCRIPTION.includes("BEFORE decompressing"))
    assert.ok(DEFAULT_ACP_STATUS_DESCRIPTION.includes('scope:"compressed"'))
    assert.ok(DEFAULT_ACP_CONTEXT_RECAP_DESCRIPTION.includes("blockId optional"))
})

test("getToolDescriptions resolves per pack", () => {
    const def = getToolDescriptions("default")
    assert.equal(def.decompress, DEFAULT_DECOMPRESS_DESCRIPTION)
    assert.equal(def.searchContext, DEFAULT_SEARCH_CONTEXT_DESCRIPTION)
    assert.equal(def.acpStatus, DEFAULT_ACP_STATUS_DESCRIPTION)
    assert.equal(def.acpContextRecap, DEFAULT_ACP_CONTEXT_RECAP_DESCRIPTION)

    const lean = getToolDescriptions("lean")
    assert.equal(lean.decompress, LEAN_DECOMPRESS_DESCRIPTION)
    assert.equal(lean.searchContext, LEAN_SEARCH_CONTEXT_DESCRIPTION)
    assert.equal(lean.acpStatus, LEAN_ACP_STATUS_DESCRIPTION)
    assert.equal(lean.acpContextRecap, LEAN_ACP_CONTEXT_RECAP_DESCRIPTION)
})

test("buildPack* selectors return the bundled builders for the default pack", () => {
    for (const candidates of [false, true]) {
        assert.equal(buildPackSystemPrompt("default", candidates), buildSystemPrompt(candidates))
        assert.equal(
            buildPackCompressRangePrompt("default", candidates),
            buildCompressRangePrompt(candidates),
        )
        assert.equal(buildPackSystemPrompt("lean", candidates), buildLeanSystemPrompt(candidates))
        assert.equal(
            buildPackCompressRangePrompt("lean", candidates),
            buildLeanCompressRangePrompt(candidates),
        )
    }
})

test("config validation accepts promptPack default/lean and rejects other values", () => {
    // getInvalidConfigKeys only flags unknown keys; value checks live in validateConfigTypes.
    assert.deepEqual(getInvalidConfigKeys({ compress: { promptPack: "lean" } }), [])
    assert.deepEqual(getInvalidConfigKeys({ compress: { promptPack: "default" } }), [])

    const okErrors = validateConfigTypes({ compress: { promptPack: "lean" } })
    assert.ok(!okErrors.some((e) => e.key === "compress.promptPack"))

    const badErrors = validateConfigTypes({ compress: { promptPack: "bogus" } })
    const bad = badErrors.find((e) => e.key === "compress.promptPack")
    assert.ok(bad, "expected a validation error for compress.promptPack")
    assert.equal(bad?.expected, '"default" | "lean"')
})

function makeCompress(overrides: Partial<PluginConfig["compress"]> = {}): PluginConfig["compress"] {
    return {
        permission: "allow",
        showCompression: true,
        summaryBuffer: true,
        candidates: false,
        promptPack: "default",
        maxContextLimit: "80%",
        minContextLimit: "80%",
        contextLimitFallback: 128000,
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
        completionReserveTokens: 32768,
        ...overrides,
    }
}

test("mergeCompress propagates promptPack (override wins, base fallback)", () => {
    assert.equal(
        mergeCompress(makeCompress(), makeCompress({ promptPack: "lean" })).promptPack,
        "lean",
    )
    // explicit override value always wins, even when it differs from base
    assert.equal(
        mergeCompress(makeCompress({ promptPack: "lean" }), makeCompress()).promptPack,
        "default",
    )
    // omitted override field falls back to base
    const leanBase = makeCompress({ promptPack: "lean" })
    const sparseOverride = { ...makeCompress() }
    delete sparseOverride.promptPack
    assert.equal(mergeCompress(leanBase, sparseOverride).promptPack, "lean")
    assert.equal(mergeCompress(makeCompress(), undefined).promptPack, "default")
})

const REMINDER_OPEN = ["<", "dcp-system-reminder", ">"].join("")
const REMINDER_CLOSE = ["</", "dcp-system-reminder", ">"].join("")

// The store wraps every editable prompt except compress-range in reminder tags
// (wrapRuntimePromptContent); strip the wrapper so tests compare prompt bodies.
function unwrapSystem(content: string): string {
    const trimmed = content.trim()
    if (trimmed.startsWith(REMINDER_OPEN) && trimmed.endsWith(REMINDER_CLOSE)) {
        return trimmed.slice(REMINDER_OPEN.length, -REMINDER_CLOSE.length).trim()
    }
    return trimmed
}

interface StoreFixture {
    store: PromptStore
    cleanup: () => void
}

function createStoreFixture(options: {
    customPrompts?: boolean
    candidatesEnabled?: boolean
    promptPack?: "default" | "lean"
    systemOverride?: string
}): StoreFixture {
    const rootDir = mkdtempSync(join(tmpdir(), "opencode-acp-packs-"))
    const configHome = join(rootDir, "config")
    const workspaceDir = join(rootDir, "workspace")
    mkdirSync(configHome, { recursive: true })
    mkdirSync(workspaceDir, { recursive: true })

    const previousConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = configHome
    delete process.env.OPENCODE_CONFIG_DIR

    if (options.systemOverride !== undefined) {
        const overrideDir = join(configHome, "opencode", "acp-prompts", "overrides")
        mkdirSync(overrideDir, { recursive: true })
        writeFileSync(join(overrideDir, "system.md"), options.systemOverride, "utf-8")
    }

    const store = new PromptStore(
        new Logger(false),
        workspaceDir,
        options.customPrompts ?? true,
        options.candidatesEnabled ?? false,
        options.promptPack ?? "default",
    )

    return {
        store,
        cleanup() {
            if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
            else process.env.XDG_CONFIG_HOME = previousConfigHome
            if (previousOpencodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
            else process.env.OPENCODE_CONFIG_DIR = previousOpencodeConfigDir
            rmSync(rootDir, { recursive: true, force: true })
        },
    }
}

test("PromptStore with lean pack serves lean system prompt and tool descriptions", () => {
    const fixture = createStoreFixture({ promptPack: "lean" })
    try {
        const prompts = fixture.store.getRuntimePrompts()
        // The store trims bundled/override content before wrapping (toEditablePromptText +
        // wrapRuntimePromptContent), so compare against the trimmed builder output.
        assert.equal(unwrapSystem(prompts.system), buildLeanSystemPrompt(false).trim())
        assert.ok(prompts.system.startsWith(REMINDER_OPEN))
        assert.equal(prompts.compressRange, buildLeanCompressRangePrompt(false).trim())
        assert.equal(prompts.decompressDescription, LEAN_DECOMPRESS_DESCRIPTION)
        assert.equal(prompts.searchContextDescription, LEAN_SEARCH_CONTEXT_DESCRIPTION)
        assert.equal(prompts.acpStatusDescription, LEAN_ACP_STATUS_DESCRIPTION)
        assert.equal(prompts.acpContextRecapDescription, LEAN_ACP_CONTEXT_RECAP_DESCRIPTION)
    } finally {
        fixture.cleanup()
    }
})

test("PromptStore with default pack stays byte-identical to the bundled builders", () => {
    const fixture = createStoreFixture({ promptPack: "default", candidatesEnabled: true })
    try {
        const prompts = fixture.store.getRuntimePrompts()
        // Same store-side trimming contract as the lean-pack test above.
        assert.equal(unwrapSystem(prompts.system), buildSystemPrompt(true).trim())
        assert.ok(prompts.system.startsWith(REMINDER_OPEN))
        assert.equal(prompts.compressRange, buildCompressRangePrompt(true).trim())
        assert.equal(prompts.decompressDescription, DEFAULT_DECOMPRESS_DESCRIPTION)
        assert.equal(prompts.acpStatusDescription, DEFAULT_ACP_STATUS_DESCRIPTION)
    } finally {
        fixture.cleanup()
    }
})

test("file override beats the lean pack (override > lean > bundled)", () => {
    const marker = "OVERRIDE-WINS-OVER-LEAN-PACK-MARKER"
    const fixture = createStoreFixture({
        promptPack: "lean",
        customPrompts: true,
        systemOverride: `${marker}\nCustom system body.`,
    })
    try {
        const prompts = fixture.store.getRuntimePrompts()
        assert.ok(prompts.system.includes(marker), "override content should win")
        assert.notEqual(prompts.system, buildLeanSystemPrompt(false))
        // non-overridden surfaces still come from the lean pack
        assert.equal(prompts.decompressDescription, LEAN_DECOMPRESS_DESCRIPTION)
    } finally {
        fixture.cleanup()
    }
})
