#!/usr/bin/env node

import { readFileSync, readdirSync } from "fs"

interface VerifyExpectations {
    blockCount?: number
    qualityGateRetryPending?: boolean
    minBlockCount?: number
    summaryContains?: string
    childBlockCount?: number
}

interface VerifyScenario {
    verify: VerifyExpectations
}

const statePath = process.argv[2]
const scenarioPath = process.argv[3]
const acpDir = process.argv[4]

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

const state = readJson(statePath)
const scenario = readJson(scenarioPath) as VerifyScenario
const expect = scenario.verify

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

const actualBlockCount = countBlocks(state)
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

console.log(`\nVerifying: ${scenarioPath}`)
console.log(`  state file: ${statePath}`)
console.log(`  blocks: ${actualBlockCount}`)
console.log(`  qualityGateRetryPending: ${actualPending}`)
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

console.log()
if (failed > 0) {
    console.error(`FAIL: ${failed} assertion(s) failed, ${passed} passed`)
    process.exit(1)
}
console.log(`PASS: ${passed} assertion(s) passed`)
