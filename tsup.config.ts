import { defineConfig } from "tsup"
import pkg from "./package.json" with { type: "json" }
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import path from "path"

let kernelVersion = "unknown"
try {
    const entry = fileURLToPath(import.meta.resolve("acp-kernel"))
    let dir = path.dirname(entry)
    for (let i = 0; i < 10 && dir !== path.dirname(dir); i++) {
        const pj = path.join(dir, "package.json")
        let data: any
        try {
            data = JSON.parse(readFileSync(pj, "utf8"))
        } catch {
            data = null
        }
        if (data && data.name === "acp-kernel") {
            kernelVersion = data.version
            break
        }
        dir = path.dirname(dir)
    }
} catch {
    kernelVersion = "unknown"
}

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    // Bundle both:
    //   - jsonc-parser: broken ESM imports when external
    //   - context-compress-algorithms: published tarball must be self-contained (file: dep does not survive pack)
    //   - acp-kernel: published tarball must be self-contained (compression engine, inline-bundled)
    noExternal: ["jsonc-parser", "context-compress-algorithms", "acp-kernel"],
    define: {
        ACP_VERSION: JSON.stringify(pkg.version),
        ACP_ENGINE: JSON.stringify("acp-kernel"),
        KERNEL_VERSION: JSON.stringify(kernelVersion),
    },
})
