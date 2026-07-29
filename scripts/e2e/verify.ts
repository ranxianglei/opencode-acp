#!/usr/bin/env node

import { readFileSync, readdirSync, existsSync } from "fs"

interface VerifyExpectations {
    blockCount?: number
    maxBlockCount?: number
    minBlockCount?: number
    qualityGateRetryPending?: boolean
    summaryContains?: string
    childBlockCount?: number
    nudgeBaselineSet?: boolean
    tier2BaselineSet?: boolean
    activeBlockCount?: number
    compressedCount?: number
    minCompressedCount?: number
    maxCompressedCount?: number
    maxCompressCallsVisible?: number
    lastRequestCompressCalls?: number
    maxNudgeCount?: number
}

interface VerifyScenario {
    verify: VerifyExpectations
}

interface RequestObservation {
    turn: number
    inputTokens: number
    messageCount: number
    compressCallCount: number
    nudgeDetected: boolean
    isChild: boolean
}

const statePath = process.argv[2]
const scenarioPath = process.argv[3]
const acpDir = process.argv[4]
const observationsPath = process.env.OBSERVATIONS ?? "/tmp/acp-e2e-observations.json"

if (!statePath || !scenarioPath) {
    process.stderr.write("Usage: verify.ts <state-file> <scenario-file> [acp-dir]\n")
    process.exit(2)
}

function readJson(path: string): any {
    try {
        return JSON.parse(readFileSync(path, "utf-8"))
    } catch (e) {
        console.error(`FAIL: cannot read ${path}: ${(e as Error).message}`)
        process.exit(1)
    }
}

function readObservations(): RequestObservation[] {
    if (!existsSync(observationsPath)) return []
    try {
        const data = JSON.parse(readFileSync(observationsPath, "utf-8"))
        return Array.isArray(data?.requests) ? data.requests : []
    } catch {
        return []
    }
}

const state = readJson(statePath)
const scenario = readJson(scenarioPath) as VerifyScenario
const expect = scenario.verify
const observations = readObservations()

let passed = 0
let failed = 0

function assert(name: string, condition: boolean, detail?: string) {
    if (condition) {
        console.log(`  \u2713 ${name}`)
        passed++
    } else {
        console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`)
        failed++
    }
}

function countBlocks(s: any): number {
    return Object.keys(s?.prune?.messages?.blocksById ?? {}).length
}

function getBlocks(s: any): any[] {
    return Object.values(s?.prune?.messages?.blocksById ?? {})
}

function countActiveBlocks(s: any): number {
    return getBlocks(s).filter((b: any) => b?.active !== false).length
}

const actualBlockCount = countBlocks(state)
const actualActiveBlocks = countActiveBlocks(state)
const actualPending = state?.qualityGateRetryPending ?? false

let childStateFiles: string[] = []
let childBlockCount = 0
let childBlocks: any[] = []

if (acpDir) {
    try {
        const allFiles = readdirSync(acpDir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => `${acpDir}/${f}`)
        childStateFiles = allFiles.filter((f) => f !== statePath)
        for (const f of childStateFiles) {
            try {
                const cs = readJson(f)
                childBlockCount += countBlocks(cs)
                childBlocks = childBlocks.concat(getBlocks(cs))
            } catch {}
        }
    } catch {}
}

const parentObs = observations.filter((o) => !o.isChild)
const maxCompressCalls = parentObs.length > 0
    ? Math.max(...parentObs.map((o) => o.compressCallCount))
    : 0
const lastCompressCalls = parentObs.length > 0
    ? parentObs[parentObs.length - 1].compressCallCount
    : 0
const nudgeCount = parentObs.filter((o) => o.nudgeDetected).length

console.log(`\nVerifying: ${scenarioPath}`)
console.log(`  state file: ${statePath}`)
console.log(`  blocks: ${actualBlockCount} (active: ${actualActiveBlocks})`)
console.log(`  qualityGateRetryPending: ${actualPending}`)
if (observations.length > 0) {
    console.log(`  observations: ${observations.length} requests`)
    console.log(`    maxCompressCallsVisible: ${maxCompressCalls}`)
    console.log(`    lastRequestCompressCalls: ${lastCompressCalls}`)
    console.log(`    nudgeDetections: ${nudgeCount}`)
}
if (childStateFiles.length > 0) {
    console.log(`  child state files: ${childStateFiles.length}`)
    console.log(`  child blocks: ${childBlockCount}`)
}
console.log()

if (expect.blockCount !== undefined) {
    assert(
        `blockCount === ${expect.blockCount}`,
        actualBlockCount === expect.blockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.minBlockCount !== undefined) {
    assert(
        `blockCount >= ${expect.minBlockCount}`,
        actualBlockCount >= expect.minBlockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.maxBlockCount !== undefined) {
    assert(
        `blockCount <= ${expect.maxBlockCount}`,
        actualBlockCount <= expect.maxBlockCount,
        `got ${actualBlockCount}`,
    )
}

if (expect.activeBlockCount !== undefined) {
    assert(
        `activeBlockCount === ${expect.activeBlockCount}`,
        actualActiveBlocks === expect.activeBlockCount,
        `got ${actualActiveBlocks}`,
    )
}

if (expect.qualityGateRetryPending !== undefined) {
    assert(
        `qualityGateRetryPending === ${expect.qualityGateRetryPending}`,
        actualPending === expect.qualityGateRetryPending,
        `got ${actualPending}`,
    )
}

if (expect.summaryContains !== undefined) {
    let found = false
    for (const block of getBlocks(state)) {
        if (block?.summary?.includes(expect.summaryContains)) {
            found = true
            break
        }
    }
    assert(
        `summary contains "${expect.summaryContains}"`,
        found,
        "no block summary contains the expected text",
    )
}

if (expect.childBlockCount !== undefined) {
    assert(
        `childBlockCount === ${expect.childBlockCount}`,
        childBlockCount === expect.childBlockCount,
        `got ${childBlockCount} across ${childStateFiles.length} child state file(s)`,
    )
}

const nudgeBaseline = state?.nudges?.lastPerMessageNudgeTokens

if (expect.nudgeBaselineSet !== undefined) {
    const isSet = nudgeBaseline !== null && nudgeBaseline !== undefined
    assert(
        `nudgeBaselineSet === ${expect.nudgeBaselineSet}`,
        isSet === expect.nudgeBaselineSet,
        `got ${nudgeBaseline ?? "null"}`,
    )
}

const tier2Baseline = state?.nudges?.lastTier2NudgeTokens

if (expect.tier2BaselineSet !== undefined) {
    const isSet = tier2Baseline !== null && tier2Baseline !== undefined
    assert(
        `tier2BaselineSet === ${expect.tier2BaselineSet}`,
        isSet === expect.tier2BaselineSet,
        `got ${tier2Baseline ?? "null"}`,
    )
}

function getCompressedMessageIds(s: any): string[] {
    return Object.keys(s?.prune?.messages?.byMessageId ?? {})
}

const compressedIds = getCompressedMessageIds(state)

if (expect.compressedCount !== undefined) {
    assert(
        `compressedCount === ${expect.compressedCount}`,
        compressedIds.length === expect.compressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.minCompressedCount !== undefined) {
    assert(
        `compressedCount >= ${expect.minCompressedCount}`,
        compressedIds.length >= expect.minCompressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.maxCompressedCount !== undefined) {
    assert(
        `compressedCount <= ${expect.maxCompressedCount}`,
        compressedIds.length <= expect.maxCompressedCount,
        `got ${compressedIds.length} compressed message IDs`,
    )
}

if (expect.maxCompressCallsVisible !== undefined) {
    assert(
        `maxCompressCallsVisible <= ${expect.maxCompressCallsVisible}`,
        maxCompressCalls <= expect.maxCompressCallsVisible,
        `got max ${maxCompressCalls} compress calls visible in a single request`,
    )
}

if (expect.lastRequestCompressCalls !== undefined) {
    assert(
        `lastRequestCompressCalls === ${expect.lastRequestCompressCalls}`,
        lastCompressCalls === expect.lastRequestCompressCalls,
        `got ${lastCompressCalls} compress calls in last request`,
    )
}

if (expect.maxNudgeCount !== undefined) {
    assert(
        `nudgeCount <= ${expect.maxNudgeCount}`,
        nudgeCount <= expect.maxNudgeCount,
        `got ${nudgeCount} nudge detections across ${parentObs.length} requests`,
    )
}

console.log()
if (failed > 0) {
    console.error(`FAIL: ${failed} assertion(s) failed, ${passed} passed`)
    process.exit(1)
}
console.log(`PASS: ${passed} assertion(s) passed`)
