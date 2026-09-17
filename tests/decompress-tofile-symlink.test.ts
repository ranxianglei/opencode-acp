import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { resolveSafeToFileTarget } from "../lib/compress/tofile-target"

// Fixtures live under $TMPDIR (workspace .tmp in daemon sandboxes where /tmp is
// read-only; /tmp in CI). Allowed roots are injected so the tests never depend
// on os.tmpdir()/~/.cache/opencode being writable.
function makeFixture() {
    const base = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "acp-tofile-"))
    const allowed = path.join(base, "allowed")
    const outside = path.join(base, "outside")
    mkdirSync(allowed, { recursive: true })
    mkdirSync(outside, { recursive: true })
    return { base, allowed, outside, opts: { allowedDirs: [allowed] } }
}

async function withFixture<T>(fn: (fx: ReturnType<typeof makeFixture>) => Promise<T>): Promise<T> {
    const fx = makeFixture()
    try {
        return await fn(fx)
    } finally {
        rmSync(fx.base, { recursive: true, force: true })
    }
}

test("accepts a new file under the allowed root (missing tail dirs ok)", async () => {
    await withFixture(async ({ allowed, opts }) => {
        const result = await resolveSafeToFileTarget(path.join(allowed, "new", "sub.txt"), opts)
        assert.equal(result.ok, true)
        if (result.ok) {
            assert.equal(result.filePath, path.resolve(path.join(allowed, "new", "sub.txt")))
        }
    })
})

test("accepts an existing regular file for overwrite", async () => {
    await withFixture(async ({ allowed, opts }) => {
        const target = path.join(allowed, "existing.txt")
        writeFileSync(target, "old", "utf-8")
        const result = await resolveSafeToFileTarget(target, opts)
        assert.equal(result.ok, true)
    })
})

test("accepts a symlinked directory that stays inside the allowed root", async () => {
    await withFixture(async ({ allowed, opts }) => {
        const realDir = path.join(allowed, "real")
        mkdirSync(realDir)
        const innerLink = path.join(allowed, "inner-link")
        symlinkSync(realDir, innerLink, "dir")
        const result = await resolveSafeToFileTarget(path.join(innerLink, "ok.txt"), opts)
        assert.equal(result.ok, true)
    })
})

test("accepts targets under either of two disjoint allowed roots", async () => {
    await withFixture(async ({ base }) => {
        const rootA = path.join(base, "root-a")
        const rootB = path.join(base, "root-b")
        mkdirSync(rootA)
        mkdirSync(rootB)
        const twoRoots = { allowedDirs: [rootA, rootB] }
        const inA = await resolveSafeToFileTarget(path.join(rootA, "a.txt"), twoRoots)
        assert.equal(inA.ok, true)
        const inB = await resolveSafeToFileTarget(path.join(rootB, "b.txt"), twoRoots)
        assert.equal(inB.ok, true)
    })
})

test("handles intermediate dir symlinks under multiple allowed roots (accepts link into an allowed root, rejects link out)", async () => {
    await withFixture(async ({ base }) => {
        const rootA = path.join(base, "root-a")
        const rootB = path.join(base, "root-b")
        const escape = path.join(base, "escape")
        mkdirSync(rootA)
        mkdirSync(rootB)
        mkdirSync(escape)
        const link = path.join(rootA, "link-to-b")
        symlinkSync(rootB, link, "dir")
        // rootB is allowed, so a link into it stays legitimate...
        const legit = await resolveSafeToFileTarget(path.join(link, "ok.txt"), {
            allowedDirs: [rootA, rootB],
        })
        assert.equal(legit.ok, true)
        // ...but a link into a third, non-allowed dir must be rejected.
        const badLink = path.join(rootA, "link-to-escape")
        symlinkSync(escape, badLink, "dir")
        const bad = await resolveSafeToFileTarget(path.join(badLink, "evil.txt"), {
            allowedDirs: [rootA, rootB],
        })
        assert.equal(bad.ok, false)
    })
})

test("rejects lexical .. traversal outside the allowed root", async () => {
    await withFixture(async ({ allowed, outside, opts }) => {
        const result = await resolveSafeToFileTarget(
            path.join(allowed, "..", "outside", "x.txt"),
            opts,
        )
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.error, /must be under/)
        }
    })
})

test("rejects an absolute path outside the allowed roots", async () => {
    await withFixture(async ({ outside, opts }) => {
        const result = await resolveSafeToFileTarget(path.join(outside, "x.txt"), opts)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.error, /must be under/)
        }
    })
})

test("rejects an intermediate directory symlink that escapes the allowed root", async () => {
    await withFixture(async ({ allowed, outside, opts }) => {
        const escapeLink = path.join(allowed, "escape-link")
        symlinkSync(outside, escapeLink, "dir")
        const result = await resolveSafeToFileTarget(path.join(escapeLink, "evil.txt"), opts)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.error, /symlink/)
        }
    })
})

test("rejects a final-component symlink pointing outside", async () => {
    await withFixture(async ({ allowed, outside, opts }) => {
        const secret = path.join(outside, "secret.txt")
        writeFileSync(secret, "secret", "utf-8")
        const finalLink = path.join(allowed, "final-link")
        symlinkSync(secret, finalLink)
        const result = await resolveSafeToFileTarget(finalLink, opts)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.error, /symlink/)
        }
    })
})

test("rejects an empty target path", async () => {
    await withFixture(async ({ opts }) => {
        const result = await resolveSafeToFileTarget("", opts)
        assert.equal(result.ok, false)
        if (!result.ok) {
            assert.match(result.error, /must be under/)
        }
    })
})

test("rejects a target under an allowed root that does not exist (fail-closed)", async () => {
    await withFixture(async ({ base }) => {
        const missing = path.join(base, "missing-root")
        const result = await resolveSafeToFileTarget(path.join(missing, "x.txt"), {
            allowedDirs: [missing],
        })
        assert.equal(result.ok, false)
    })
})

test("rejects a symlink cycle (ELOOP) as unvalidatable", async () => {
    await withFixture(async ({ allowed, opts }) => {
        const loopA = path.join(allowed, "loop-a")
        const loopB = path.join(allowed, "loop-b")
        symlinkSync(loopB, loopA, "dir")
        symlinkSync(loopA, loopB, "dir")
        const result = await resolveSafeToFileTarget(path.join(loopA, "x.txt"), opts)
        assert.equal(result.ok, false)
    })
})
