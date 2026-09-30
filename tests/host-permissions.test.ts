import assert from "node:assert/strict"
import test from "node:test"
import {
    anyRuleResolves,
    applyAcpToolPermissions,
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    resolveEffectiveCompressPermission,
} from "../lib/host-permissions"

test("wildcard deny disables compress", () => {
    assert.equal(compressDisabledByOpencode({ "*": "deny" }), true)
})

test("later explicit compress allow overrides wildcard deny", () => {
    assert.equal(
        compressDisabledByOpencode({
            "*": "deny",
            compress: "allow",
        }),
        false,
    )
})

test("agent wildcard deny disables compress even when global config allows it", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { question: "allow" },
                agents: {
                    fast: { "*": "deny", question: "allow" },
                },
            },
            "fast",
        ),
        "deny",
    )
})

test("agent explicit allow overrides global wildcard deny", () => {
    assert.equal(
        resolveEffectiveCompressPermission(
            "allow",
            {
                global: { "*": "deny" },
                agents: {
                    build: { compress: "allow" },
                },
            },
            "build",
        ),
        "allow",
    )
})

test("permission wildcards follow opencode-style matching", () => {
    assert.equal(compressDisabledByOpencode({ "c?mpress": "deny" }), true)
})

test("pattern-specific denies do not disable the whole tool", () => {
    assert.equal(
        compressDisabledByOpencode({
            compress: {
                "/tmp/*": "deny",
            },
        }),
        false,
    )
})

test("compress permission resolution works without Array.findLast", () => {
    const originalFindLast = Array.prototype.findLast

    try {
        delete (Array.prototype as Array<unknown> & { findLast?: unknown }).findLast

        assert.equal(
            compressDisabledByOpencode({
                "*": "deny",
                compress: "allow",
            }),
            false,
        )
    } finally {
        Array.prototype.findLast = originalFindLast
    }
})

test("explicit compress permissions are detected", () => {
    assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
    assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
})

test("explicit permission detection works without Object.hasOwn", () => {
    const originalHasOwn = Object.hasOwn

    try {
        delete (Object as typeof Object & { hasOwn?: unknown }).hasOwn

        assert.equal(hasExplicitToolPermission({ compress: "ask" }, "compress"), true)
        assert.equal(hasExplicitToolPermission({ "*": "deny" }, "compress"), false)
    } finally {
        Object.hasOwn = originalHasOwn
    }
})

test("applyAcpToolPermissions defaults compress and acp_status when no host map", () => {
    assert.deepEqual(applyAcpToolPermissions(undefined, "allow"), {
        compress: "allow",
        acp_status: "allow",
    })
})

test("applyAcpToolPermissions preserves unrelated host rules", () => {
    assert.deepEqual(applyAcpToolPermissions({ bash: "ask" }, "ask"), {
        bash: "ask",
        compress: "ask",
        acp_status: "allow",
    })
})

test("#457 explicit acp_status deny survives the config write", () => {
    assert.deepEqual(applyAcpToolPermissions({ acp_status: "deny" }, "allow"), {
        acp_status: "deny",
        compress: "allow",
    })
})

test("#457 explicit acp_status ask survives the config write", () => {
    assert.deepEqual(applyAcpToolPermissions({ acp_status: "ask" }, "allow"), {
        acp_status: "ask",
        compress: "allow",
    })
})

test("explicit compress rule defers fully — map returned unchanged", () => {
    const original = { compress: "deny", acp_status: "allow" }
    assert.equal(applyAcpToolPermissions(original, "allow"), original)
})

test("explicit compress rule defers fully — no acp_status injected", () => {
    assert.deepEqual(applyAcpToolPermissions({ compress: "deny" }, "allow"), {
        compress: "deny",
    })
})

test('#465 user wildcard "*" deny is not overridden by default acp_status', () => {
    assert.deepEqual(applyAcpToolPermissions({ "*": "deny" }, "allow"), {
        "*": "deny",
        compress: "allow",
    })
})

test('#465 user wildcard "acp*" deny is not overridden by default acp_status', () => {
    assert.deepEqual(applyAcpToolPermissions({ "acp*": "deny" }, "allow"), {
        "acp*": "deny",
        compress: "allow",
    })
})

test("#465 user wildcard ask resolves acp_status — no default injected", () => {
    assert.deepEqual(applyAcpToolPermissions({ "*": "ask" }, "allow"), {
        "*": "ask",
        compress: "allow",
    })
})

test("#465 user wildcard allow resolves acp_status — no redundant default injected", () => {
    assert.deepEqual(applyAcpToolPermissions({ "acp*": "allow" }, "allow"), {
        "acp*": "allow",
        compress: "allow",
    })
})

test("#465 non-matching wildcards still get the default acp_status", () => {
    assert.deepEqual(applyAcpToolPermissions({ "bash*": "deny" }, "allow"), {
        "bash*": "deny",
        compress: "allow",
        acp_status: "allow",
    })
})

test("#465 nested pattern form on acp_status counts as a user decision", () => {
    assert.deepEqual(applyAcpToolPermissions({ acp_status: { "*": "deny" } }, "allow"), {
        acp_status: { "*": "deny" },
        compress: "allow",
    })
})

test("#465 wildcard map with explicit compress still defers fully (identity)", () => {
    const original = { "*": "deny", compress: "allow" }
    assert.equal(applyAcpToolPermissions(original, "deny"), original)
})

test("anyRuleResolves matches exact keys, wildcards and nested forms; ignores others", () => {
    assert.equal(anyRuleResolves(undefined, "acp_status"), false)
    assert.equal(anyRuleResolves({ "bash*": "deny" }, "acp_status"), false)
    assert.equal(anyRuleResolves({ bash: "ask" }, "acp_status"), false)
    assert.equal(anyRuleResolves({ acp_status: "deny" }, "acp_status"), true)
    assert.equal(anyRuleResolves({ "*": "deny" }, "acp_status"), true)
    assert.equal(anyRuleResolves({ "acp*": "deny" }, "acp_status"), true)
    assert.equal(anyRuleResolves({ acp_status: { "*": "deny" } }, "acp_status"), true)
    // degenerate empty object produces no rules — key presence still wins
    assert.equal(anyRuleResolves({ acp_status: {} }, "acp_status"), true)
})
