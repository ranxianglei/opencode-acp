import assert from "node:assert/strict"
import test from "node:test"
import { versionBanner, VERSION } from "../lib/kernel"

test("versionBanner: canonical 'opencode-acp v<pkg> (engine: <engine> v<kernel>)' format", () => {
    const banner = versionBanner()
    assert.match(
        banner,
        /^opencode-acp v\S+ \(engine: \S+ v\S+\)$/,
        "banner must be 'opencode-acp v<pkg> (engine: <engine> v<kernel>)'",
    )
})

test("VERSION: exposes non-empty package, engine, kernel strings", () => {
    assert.ok(typeof VERSION.package === "string" && VERSION.package.length > 0)
    assert.ok(typeof VERSION.engine === "string" && VERSION.engine.length > 0)
    assert.ok(typeof VERSION.kernel === "string" && VERSION.kernel.length > 0)
})
