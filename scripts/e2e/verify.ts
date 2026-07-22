#!/usr/bin/env node
/**
 * ACP state verifier for E2E tests.
 *
 * Reads the ACP state JSON file for a given session and asserts
 * that the compression state matches expected values from the scenario.
 *
 * Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node --import tsx scripts/e2e/verify.ts <state-file> <scenario-file>
 */

import { readFileSync } from "fs"

interface VerifyExpectations {
    blockCount?: number
    qualityGateRetryPending?: boolean
    minBlockCount?: number
    summaryContains?: string
}

interface VerifyScenario {
    verify: VerifyExpectations
}

const statePath = process.argv[2]
const scenarioPath = process.argv[3]

if (!statePath || !scenarioPath) {
    process.stderr.write("Usage: verify.ts <state-file> <scenario-file>\n")
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
        console.log(`  ✓ ${name}`)
        passed++
    } else {
        console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
        failed++
    }
}

const blocksById = state?.prune?.messages?.blocksById ?? {}
const actualBlockCount = Object.keys(blocksById).length
const actualPending = state?.qualityGateRetryPending ?? false

console.log(`\nVerifying: ${scenarioPath}`)
console.log(`  state file: ${statePath}`)
console.log(`  blocks: ${actualBlockCount}`)
console.log(`  qualityGateRetryPending: ${actualPending}`)
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
    for (const block of Object.values(blocksById) as any[]) {
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

console.log()
if (failed > 0) {
    console.error(`FAIL: ${failed} assertion(s) failed, ${passed} passed`)
    process.exit(1)
}
console.log(`PASS: ${passed} assertion(s) passed`)
