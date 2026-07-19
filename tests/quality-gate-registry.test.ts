import assert from "node:assert/strict"
import test from "node:test"

import {
    registerQualityGate,
    getQualityGate,
    listQualityGates,
    clearQualityGateRegistryForTests,
} from "../lib/compress/quality-gate/registry"
import type { QualityGate, QualityGateContext, QualityGateResult } from "../lib/compress/quality-gate/types"

function makeFakeGate(name: string, version = "1.0.0"): QualityGate {
    return {
        name,
        version,
        description: `fake gate ${name}`,
        evaluate: (_ctx: QualityGateContext, _config: unknown): QualityGateResult => ({
            passed: true,
            metrics: [],
        }),
    }
}

test("registry: getQualityGate returns undefined for unknown name", () => {
    clearQualityGateRegistryForTests()
    assert.equal(getQualityGate("does-not-exist"), undefined)
})

test("registry: registerQualityGate + getQualityGate roundtrip", () => {
    clearQualityGateRegistryForTests()
    const gate = makeFakeGate("test-1")
    registerQualityGate(gate)
    assert.equal(getQualityGate("test-1"), gate)
})

test("registry: re-registering the same gate object is a no-op", () => {
    clearQualityGateRegistryForTests()
    const gate = makeFakeGate("test-2")
    registerQualityGate(gate)
    registerQualityGate(gate)
    assert.equal(getQualityGate("test-2"), gate)
})

test("registry: re-registering same name + same version (different object) is allowed", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(makeFakeGate("test-3", "1.0.0"))
    assert.doesNotThrow(() => registerQualityGate(makeFakeGate("test-3", "1.0.0")))
})

test("registry: re-registering same name + different version throws", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(makeFakeGate("test-4", "1.0.0"))
    assert.throws(
        () => registerQualityGate(makeFakeGate("test-4", "2.0.0")),
        /already registered with version 1\.0\.0/,
    )
})

test("registry: listQualityGates returns sorted names", () => {
    clearQualityGateRegistryForTests()
    registerQualityGate(makeFakeGate("zeta"))
    registerQualityGate(makeFakeGate("alpha"))
    registerQualityGate(makeFakeGate("mike"))
    const names = listQualityGates()
    assert.deepEqual(names, ["alpha", "mike", "zeta"])
})

test("registry: listQualityGates returns empty array when registry is empty", () => {
    clearQualityGateRegistryForTests()
    assert.deepEqual(listQualityGates(), [])
})

test("registry: clearQualityGateRegistryForTests resets the registry", () => {
    registerQualityGate(makeFakeGate("temp"))
    clearQualityGateRegistryForTests()
    assert.equal(getQualityGate("temp"), undefined)
    assert.deepEqual(listQualityGates(), [])
})
