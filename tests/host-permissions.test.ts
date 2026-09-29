import assert from "node:assert/strict"
import test from "node:test"
import {
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
