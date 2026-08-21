import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import assert from "node:assert/strict"
import { isAutoUpdatableSpec, isVersionNewer, specUpdateTag, updateRemoveDir, updateTarget } from "../lib/update"

test("isVersionNewer compares semver versions", () => {
    assert.equal(isVersionNewer("3.2.0", "3.1.9"), true)
    assert.equal(isVersionNewer("3.1.9", "3.1.9"), false)
    assert.equal(isVersionNewer("3.1.9", "3.2.0"), false)
    assert.equal(isVersionNewer("3.1.9", "3.1.9-beta.1"), true)
})

test("isAutoUpdatableSpec allows latest and ranges", () => {
    assert.equal(isAutoUpdatableSpec("latest"), true)
    assert.equal(isAutoUpdatableSpec("*"), true)
    assert.equal(isAutoUpdatableSpec("^3.1.9"), true)
    assert.equal(isAutoUpdatableSpec(">=3.1.9"), true)
})

test("isAutoUpdatableSpec rejects pinned and non-registry specs", () => {
    assert.equal(isAutoUpdatableSpec("3.1.9"), false)
    assert.equal(isAutoUpdatableSpec("file:../opencode-dcp"), false)
    assert.equal(isAutoUpdatableSpec("github:user/repo"), false)
})

test("updateRemoveDir removes opencode npm wrapper for latest installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@latest")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.10" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), wrapperDir)
})

test("updateRemoveDir skips version-locked opencode installs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "dcp-update-"))
    const wrapperDir = join(rootDir, "@tarquinen", "opencode-dcp@3.1.9")
    const packageDir = join(wrapperDir, "node_modules", "@tarquinen", "opencode-dcp")
    await writePackageJson(wrapperDir, {
        dependencies: { "@tarquinen/opencode-dcp": "3.1.9" },
    })
    await writePackageJson(packageDir, {
        name: "@tarquinen/opencode-dcp",
        version: "3.1.9",
    })

    assert.equal(await updateRemoveDir(packageDir, "@tarquinen/opencode-dcp"), undefined)
})

test("isAutoUpdatableSpec accepts registry dist-tags", () => {
    assert.equal(isAutoUpdatableSpec("stable"), true)
    assert.equal(isAutoUpdatableSpec("dev"), true)
    assert.equal(isAutoUpdatableSpec("next"), true)
    assert.equal(isAutoUpdatableSpec("pr-327"), true)
})

test("isAutoUpdatableSpec still rejects exact pins and non-registry specs", () => {
    assert.equal(isAutoUpdatableSpec("1.14.22"), false)
    assert.equal(isAutoUpdatableSpec("v1.14.22"), false)
    assert.equal(isAutoUpdatableSpec("1.14.22-beta.1"), false)
    assert.equal(isAutoUpdatableSpec("file:../opencode-acp"), false)
    assert.equal(isAutoUpdatableSpec("github:user/repo"), false)
    assert.equal(isAutoUpdatableSpec("git+https://example.com/repo.git"), false)
})

test("isVersionNewer updates within dev and pr-N preview channels", () => {
    // Same PR, new CI preview build: numeric pre-release identifiers compare numerically
    assert.equal(isVersionNewer("1.14.22-pr.327.47", "1.14.22-pr.327.46"), true)
    assert.equal(isVersionNewer("1.14.22-pr.327.46", "1.14.22-pr.327.47"), false)
    assert.equal(isVersionNewer("1.14.22-pr.327.46", "1.14.22-pr.327.46"), false)
    // dev track moves forward
    assert.equal(isVersionNewer("1.14.23-dev.0", "1.14.14-dev.1"), true)
    // release outranks preview of the same version (semver precedence) — but channel
    // pinning means an @pr-327 install is only ever compared against the pr-327 tag,
    // never against latest/stable releases
    assert.equal(isVersionNewer("1.14.22", "1.14.22-pr.327.46"), true)
})

test("specUpdateTag tracks installed dist-tag; ranges fall back to latest", () => {
    assert.equal(specUpdateTag("stable"), "stable")
    assert.equal(specUpdateTag("pr-327"), "pr-327")
    assert.equal(specUpdateTag("latest"), "latest")
    assert.equal(specUpdateTag("*"), "latest")
    assert.equal(specUpdateTag("^1.14.0"), "latest")
    assert.equal(specUpdateTag("~1.14.0"), "latest")
    assert.equal(specUpdateTag(">=1.0.0"), "latest")
    assert.equal(specUpdateTag("1.14.22"), undefined)
    assert.equal(specUpdateTag("file:../opencode-acp"), undefined)
})

test("updateRemoveDir removes wrapper for README tag installs (opencode-acp@stable)", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "acp-update-"))
    const wrapperDir = join(rootDir, "opencode-acp@stable")
    const packageDir = join(wrapperDir, "node_modules", "opencode-acp")
    // opencode pins exact resolved versions in the wrapper package.json (savePrefix: "")
    await writePackageJson(wrapperDir, {
        dependencies: { "opencode-acp": "1.14.19" },
    })
    await writePackageJson(packageDir, {
        name: "opencode-acp",
        version: "1.14.19",
    })

    assert.equal(await updateRemoveDir(packageDir, "opencode-acp"), wrapperDir)
})

test("updateTarget exposes the installed spec for tag-aware version fetch", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "acp-update-"))
    const wrapperDir = join(rootDir, "opencode-acp@pr-327")
    const packageDir = join(wrapperDir, "node_modules", "opencode-acp")
    await writePackageJson(wrapperDir, {
        dependencies: { "opencode-acp": "1.14.22-pr.327.46" },
    })
    await writePackageJson(packageDir, {
        name: "opencode-acp",
        version: "1.14.22-pr.327.46",
    })

    const target = await updateTarget(packageDir, "opencode-acp")
    assert.equal(target?.removeDir, wrapperDir)
    assert.equal(target?.spec, "pr-327")
    assert.equal(specUpdateTag(target?.spec ?? ""), "pr-327")
})

async function writePackageJson(dir: string, data: Record<string, unknown>) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "package.json"), `${JSON.stringify(data)}\n`, "utf-8")
}
