import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse as parseJSONC } from "jsonc-parser"

const ACP_BASENAMES = ["acp.jsonc", "acp.json"]
const DCP_BASENAMES = ["dcp.jsonc", "dcp.json"]

export interface ConfigLayer {
    path: string
    layer: "global" | "config-dir" | "project"
}

/**
 * Read and parse a JSONC config file.
 * @returns the parsed object, or null if the file is missing, unreadable, or
 *          does not parse to a plain object.
 */
export function readConfigFile(filePath: string): Record<string, unknown> | null {
    let text: string
    try {
        text = readFileSync(filePath, "utf-8")
    } catch {
        return null
    }

    const parsed = parseJSONC(text)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null
    }
    return parsed as Record<string, unknown>
}

function firstExistingFile(dir: string): string | null {
    for (const base of [...ACP_BASENAMES, ...DCP_BASENAMES]) {
        const candidate = join(dir, base)
        if (existsSync(candidate)) {
            return candidate
        }
    }
    return null
}

function buildLayers(): ConfigLayer[] {
    const layers: ConfigLayer[] = []

    const globalDir = join(homedir(), ".config", "opencode")
    layers.push({ path: globalDir, layer: "global" })

    const configDir = process.env.OPENCODE_CONFIG_DIR
    if (configDir) {
        layers.push({ path: configDir, layer: "config-dir" })
    }

    layers.push({ path: join(process.cwd(), ".opencode"), layer: "project" })

    return layers
}

/**
 * Locate existing config files across the three-layer search path
 * (global → config-dir → project), preferring `acp.jsonc`/`acp.json` and
 * falling back to the legacy `dcp.jsonc`/`dcp.json` per layer.
 *
 * @returns the list of existing files in priority order (lowest first; later
 *          layers override earlier ones when merged).
 */
export function findConfigFiles(): ConfigLayer[] {
    const found: ConfigLayer[] = []
    for (const layer of buildLayers()) {
        const file = firstExistingFile(layer.path)
        if (file) {
            found.push({ path: file, layer: layer.layer })
        }
    }
    return found
}
