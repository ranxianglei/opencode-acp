import type { PluginConfig } from "./types"
import { DEFAULT_CONFIG } from "./defaults"
import { validateConfig, validateConfigTypes } from "./schema"
import { findConfigFiles, readConfigFile } from "./parser"
import { mergeConfigs } from "./merger"
import { migrateDCPConfig, needsMigration } from "./migrator"

export { DEFAULT_CONFIG } from "./defaults"
export type {
    PluginConfig,
    CompressConfig,
    GCConfig,
    CommandsConfig,
    StrategiesConfig,
} from "./types"
export { validateConfig, validateConfigTypes, pluginConfigSchema } from "./schema"
export { readConfigFile, findConfigFiles } from "./parser"
export type { ConfigLayer } from "./parser"
export { mergeConfigs } from "./merger"
export { needsMigration, migrateDCPConfig } from "./migrator"

export function getDefaultConfig(): PluginConfig {
    return structuredClone(DEFAULT_CONFIG)
}

/**
 * Resolve the effective plugin configuration.
 *
 * Reads each layer discovered by {@link findConfigFiles}, migrates any
 * DCP-origin layer, deep-merges all layers over the defaults, then strictly
 * validates the merged result.
 *
 * @throws {z.ZodError} if the merged config violates the schema.
 */
export function getConfig(): PluginConfig {
    const layers = findConfigFiles()

    const layerObjects: Record<string, unknown>[] = []
    for (const layer of layers) {
        const raw = readConfigFile(layer.path)
        if (raw === null) {
            continue
        }
        layerObjects.push(needsMigration(raw) ? migrateDCPConfig(raw) : raw)
    }

    const merged = mergeConfigs(
        DEFAULT_CONFIG as unknown as Record<string, unknown>,
        ...layerObjects,
    )

    return validateConfig(merged)
}
