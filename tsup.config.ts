import { defineConfig } from "tsup"

export default defineConfig({
    entry: ["index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    // Bundle both:
    //   - jsonc-parser: broken ESM imports when external
    //   - context-compress-algorithms: published tarball must be self-contained (file: dep does not survive pack)
    noExternal: ["jsonc-parser", "context-compress-algorithms"],
})
