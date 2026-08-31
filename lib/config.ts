import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { parse } from "jsonc-parser/lib/esm/main.js"
import type { PluginInput } from "@opencode-ai/plugin"
import { VALID_CONFIG_KEYS, getInvalidConfigKeys, validateConfigTypes, type ValidationError } from "./config-validation"
import type { LogLevel } from "./logger"


type Permission = "ask" | "allow" | "deny"

/**
 * The subset of `CompressConfig` fields that can be overridden per provider /
 * per model via `compress.providers` (resolved field-by-field:
 * model > provider > global).
 *
 * Excluded:
 * - `permission` — resolved at tool registration time, before any model info exists
 * - `minContextLimit` / `modelMinLimits` — deprecated (see CONFIGURATION.md)
 * - `modelMaxLimits`, `modelMinLimits`, `providers` — structural (maps themselves)
 */
export type CompressOverridableConfig = Omit<
    CompressConfig,
    "permission" | "minContextLimit" | "modelMaxLimits" | "modelMinLimits" | "providers"
>

/** Per-model / per-provider override object (all overridable fields optional). */
export type CompressModelOverrides = Partial<CompressOverridableConfig>

/**
 * Per-provider overrides inside `compress.providers.<provider>`. Provider-level
 * fields apply to every model of that provider unless narrowed by a
 * `models.<modelId>` entry (which wins field-by-field).
 */
export interface CompressProviderOverrides extends CompressModelOverrides {
    models?: Record<string, CompressModelOverrides>
}

export interface CompressConfig {
    permission: Permission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | `${number}%`
    /**
     * @deprecated Soft lower bound for turn/iteration reminder nudges. Scheduled
     * for removal in a future version — growth nudges (`minNudgeContextPercent` +
     * `nudgeGrowthTokens`) are the maintained nudge mechanism. Still honored
     * until removed; removing it will retire the lower-bound gating for
     * turn/iteration reminder nudges.
     */
    minContextLimit: number | `${number}%`
    modelMaxLimits?: Record<string, number | `${number}%`>
    /**
     * @deprecated Per-model override for the deprecated `minContextLimit`.
     * Still honored until removed alongside `minContextLimit`.
     */
    modelMinLimits?: Record<string, number | `${number}%`>
    /** Nested per-provider / per-model overrides (billion-context-pi style). Resolved field-by-field: model > provider > global. */
    providers?: Record<string, CompressProviderOverrides>
    nudgeFrequency: number
    minNudgeContextPercent: number
    nudgeGrowthTokens?: number
    toolOutputNudgeThreshold?: number
    iterationNudgeThreshold: number
    nudgeForce: "strong" | "soft"
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
    maxSummaryLengthHard: number
    minCompressRange: number
    minNudgeGrowthRatio: number
    minNudgeGrowthFloor: number
    emergencyThresholdPercent: number | `${number}%`
    maxVisibleSegments: number
    keepEmbedMaxChars: number
    lastSegmentSoftBlock?: boolean
    /** Protect the last N visible messages from compression (default: 20). */
    preserveRecentMessages?: number
    /** Protect the last ~N tokens of visible messages (default: 20000). */
    preserveRecentTokens?: number
    /** Always protect the most recent user message (default: true). */
    preserveLastUserMessage?: boolean
    /**
     * Tokens reserved for the model's completion when enforcing the context
     * budget guard (default: 32768 — covers opencode's 32000 max_tokens
     * fallback for models with no declared limit.output).
     */
    completionReserveTokens?: number
}

export interface Commands {
    enabled: boolean
    protectedTools: string[]
}

export interface ExperimentalConfig {
    customPrompts: boolean
}

export interface BatchCleanupConfig {
    lowThreshold: number | `${number}%`
    highThreshold: number | `${number}%`
    forceThreshold: number | `${number}%`
}

export interface GCConfig {
    algorithm: "truncate"
    promotionThreshold: number
    maxBlockAge: number
    maxOldGenSummaryLength: number
    majorGcThresholdPercent: number | `${number}%`
    batchCleanup: BatchCleanupConfig
}

export interface QualityGateAlgorithmConfigs {
    [gateName: string]: unknown
}

export interface QualityGateConfig {
    enabled: boolean
    algorithm: string
    algorithms: QualityGateAlgorithmConfigs
}

export interface MessageFiltersConfig {
    enabled: boolean
    filters: Record<string, { enabled: boolean }>
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    /** Log verbosity when `debug` is false; `debug: true` forces full debug logging. Default: "info". */
    logLevel: LogLevel
    allowSubAgents: boolean
    pruneNotification: "off" | "minimal" | "detailed"
    pruneNotificationType: "chat" | "toast"
    commands: Commands
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    gc: GCConfig
    qualityGate: QualityGateConfig
    messageFilters: MessageFiltersConfig
}

type CompressOverride = Partial<CompressConfig>

const DEFAULT_PROTECTED_TOOLS = [
    "task",
    "skill",
    "todowrite",
    "todoread",
    "compress",
    "decompress",
    "batch",
    "plan_enter",
    "plan_exit",
    "write",
    "edit",
]

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["skill", "compress"]

/**
 * Tools that are ALWAYS protected from compression, regardless of user config.
 * "compress" must never be compressed away — its `summary` parameter is the
 * sole record of compressed conversation. Losing it causes irreversible data
 * loss. Even if a user explicitly sets `compress.protectedTools: []`, these
 * tools are force-appended after the override.
 */
const FORCE_COMPRESS_PROTECTED: readonly string[] = ["compress"]

export { VALID_CONFIG_KEYS, getInvalidConfigKeys, validateConfigTypes, type ValidationError } from "./config-validation"

function showConfigWarnings(
    ctx: PluginInput,
    configPath: string,
    configData: Record<string, any>,
    isProject: boolean,
): void {
    const invalidKeys = getInvalidConfigKeys(configData)
    const typeErrors = validateConfigTypes(configData)

    if (invalidKeys.length === 0 && typeErrors.length === 0) {
        return
    }

    const configType = isProject ? "project config" : "config"
    const messages: string[] = []

    if (invalidKeys.length > 0) {
        const keyList = invalidKeys.slice(0, 3).join(", ")
        const suffix = invalidKeys.length > 3 ? ` (+${invalidKeys.length - 3} more)` : ""
        messages.push(`Unknown keys: ${keyList}${suffix}`)
    }

    if (typeErrors.length > 0) {
        for (const err of typeErrors.slice(0, 2)) {
            messages.push(`${err.key}: expected ${err.expected}, got ${err.actual}`)
        }
        if (typeErrors.length > 2) {
            messages.push(`(+${typeErrors.length - 2} more type errors)`)
        }
    }

    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title: `ACP: ${configType} warning`,
                    message: `${configPath}\n${messages.join("\n")}`,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

const defaultConfig: PluginConfig = {
    enabled: true,
    autoUpdate: true,
    debug: false,
    logLevel: "info",
    allowSubAgents: true,
    pruneNotification: "off",
    // [FIX #20] Default to toast — chat-mode notifications inject an empty
    // user message that freezes the session on providers that reject empty
    // messages (zhipuai-lb code 1214). See lib/ui/notification.ts.
    pruneNotificationType: "toast",
    commands: {
        enabled: true,
        protectedTools: [...DEFAULT_PROTECTED_TOOLS],
    },
    experimental: {
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        permission: "allow",
        showCompression: true,
        summaryBuffer: true,
        maxContextLimit: "80%",
        minContextLimit: "80%",
        nudgeFrequency: 5,
        minNudgeContextPercent: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
        protectTags: false,
        protectUserMessages: false,
        maxSummaryLengthHard: 20000,
        minCompressRange: 5000,
        minNudgeGrowthRatio: 0.45,
        minNudgeGrowthFloor: 5000,
        nudgeGrowthTokens: 50000,
        emergencyThresholdPercent: "98%",
        maxVisibleSegments: 50,
        keepEmbedMaxChars: 2000,
        lastSegmentSoftBlock: true,
        preserveRecentMessages: 5,
        preserveRecentTokens: 5000,
        preserveLastUserMessage: true,
    },
    gc: {
        algorithm: "truncate",
        promotionThreshold: 5,
        maxBlockAge: Number.MAX_SAFE_INTEGER, // no-op: age-based deactivation removed (memory-loss fix)
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        batchCleanup: {
            lowThreshold: "55%",
            highThreshold: "75%",
            forceThreshold: "90%",
        },
    },
    qualityGate: {
        enabled: false,
        algorithm: "rouge-recall-v1",
        algorithms: {
            "rouge-recall-v1": {
                layer1MinChars: 200,
                layer1MinRetentionPct: 5.0,
                layer2MaxRougeF1: 0.05,
                layer2MaxTop20Recall: 0.20,
            },
        },
    },
    messageFilters: {
        enabled: true,
        filters: {
            "omo-system-reminder": { enabled: true },
            "omo-todo-continuation": { enabled: true },
            "omo-context": { enabled: true },
            "omo-task-directive": { enabled: true },
            "omo-mode-injection": { enabled: true },
        },
    },
}

const GLOBAL_CONFIG_DIR = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode")
const GLOBAL_CONFIG_PATH_JSONC = join(GLOBAL_CONFIG_DIR, "acp.jsonc")
const GLOBAL_CONFIG_PATH_JSON = join(GLOBAL_CONFIG_DIR, "acp.json")

function findOpencodeDir(startDir: string): string | null {
    let current = startDir
    while (current !== "/") {
        const candidate = join(current, ".opencode")
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
            return candidate
        }
        const parent = dirname(current)
        if (parent === current) {
            break
        }
        current = parent
    }
    return null
}

function getConfigPaths(ctx?: PluginInput): {
    global: string | null
    configDir: string | null
    project: string | null
} {
    const global = existsSync(GLOBAL_CONFIG_PATH_JSONC)
        ? GLOBAL_CONFIG_PATH_JSONC
        : existsSync(GLOBAL_CONFIG_PATH_JSON)
          ? GLOBAL_CONFIG_PATH_JSON
          : null

    let configDir: string | null = null
    const opencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    if (opencodeConfigDir) {
        const configJsonc = join(opencodeConfigDir, "acp.jsonc")
        const configJson = join(opencodeConfigDir, "acp.json")
        configDir = existsSync(configJsonc)
            ? configJsonc
            : existsSync(configJson)
              ? configJson
              : null
    }

    let project: string | null = null
    if (ctx?.directory) {
        const opencodeDir = findOpencodeDir(ctx.directory)
        if (opencodeDir) {
            const projectJsonc = join(opencodeDir, "acp.jsonc")
            const projectJson = join(opencodeDir, "acp.json")
            project = existsSync(projectJsonc)
                ? projectJsonc
                : existsSync(projectJson)
                  ? projectJson
                  : null
        }
    }

    return { global, configDir, project }
}

function createDefaultConfig(): void {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
        mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true })
    }

    if (!existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        const configContent = `{
  "$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json"
}
`
        writeFileSync(GLOBAL_CONFIG_PATH_JSONC, configContent, "utf-8")
    }
}

interface ConfigLoadResult {
    data: Record<string, any> | null
    parseError?: string
}

function loadConfigFile(configPath: string): ConfigLoadResult {
    let fileContent = ""
    try {
        fileContent = readFileSync(configPath, "utf-8")
    } catch {
        return { data: null }
    }

    try {
        const parsed = parse(fileContent, undefined, { allowTrailingComma: true })
        if (parsed === undefined || parsed === null) {
            return { data: null, parseError: "Config file is empty or invalid" }
        }
        return { data: parsed }
    } catch (error: any) {
        return { data: null, parseError: error.message || "Failed to parse config" }
    }
}

/** Strip undefined-valued keys so a partial override never clears inherited fields. */
function stripUndefined<T extends object>(value: T): T {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry
        }
    }
    return result as T
}

/**
 * Merge model-level override maps across config layers, per model id,
 * field-by-field: an explicitly-set field in the override layer wins; unset
 * fields inherit from the base layer.
 */
function mergeModelOverrides(
    base: Record<string, CompressModelOverrides> | undefined,
    override: Record<string, CompressModelOverrides> | undefined
): Record<string, CompressModelOverrides> | undefined {
    if (base === undefined) return override
    if (override === undefined) return base
    const merged: Record<string, CompressModelOverrides> = { ...base }
    for (const [modelId, model] of Object.entries(override)) {
        merged[modelId] = { ...base[modelId], ...stripUndefined(model) }
    }
    return merged
}

/**
 * Merge provider override maps across config layers, per provider id, then per
 * model id, field-by-field. Unlike the flat modelMaxLimits/modelMinLimits maps
 * (replace-inherited), the nested providers structure deep-merges: a project
 * layer can narrow one provider without wiping the other providers configured
 * in lower layers.
 */
function mergeProviderOverrides(
    base: Record<string, CompressProviderOverrides> | undefined,
    override: Record<string, CompressProviderOverrides> | undefined
): Record<string, CompressProviderOverrides> | undefined {
    if (base === undefined) return override
    if (override === undefined) return base
    const merged: Record<string, CompressProviderOverrides> = { ...base }
    for (const [providerId, provider] of Object.entries(override)) {
        const baseProvider = base[providerId]
        const mergedModels = mergeModelOverrides(baseProvider?.models, provider.models)
        merged[providerId] = {
            ...baseProvider,
            ...stripUndefined(provider),
            ...(mergedModels !== undefined ? { models: mergedModels } : {}),
        }
    }
    return merged
}

export function mergeCompress(
    base: PluginConfig["compress"],
    override?: CompressOverride,
): PluginConfig["compress"] {
    if (!override) {
        return base
    }

    return {
        permission: override.permission ?? base.permission,
        showCompression: override.showCompression ?? base.showCompression,
        summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
        maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
        minContextLimit: override.minContextLimit ?? base.minContextLimit,
        modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
        modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
        providers: mergeProviderOverrides(base.providers, override.providers),
        nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
        minNudgeContextPercent: override.minNudgeContextPercent ?? base.minNudgeContextPercent,
        nudgeGrowthTokens: override.nudgeGrowthTokens,
        toolOutputNudgeThreshold: override.toolOutputNudgeThreshold,
        iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
        nudgeForce: override.nudgeForce ?? base.nudgeForce,
        protectedTools: Array.isArray(override.protectedTools)
            ? [...new Set([...override.protectedTools, ...FORCE_COMPRESS_PROTECTED])]
            : base.protectedTools,
        protectTags: override.protectTags ?? base.protectTags,
        protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
        maxSummaryLengthHard: override.maxSummaryLengthHard ?? base.maxSummaryLengthHard,
    minCompressRange: override.minCompressRange ?? base.minCompressRange,
    minNudgeGrowthRatio: override.minNudgeGrowthRatio ?? base.minNudgeGrowthRatio,
    minNudgeGrowthFloor: override.minNudgeGrowthFloor ?? base.minNudgeGrowthFloor,
    emergencyThresholdPercent: override.emergencyThresholdPercent ?? base.emergencyThresholdPercent,
    maxVisibleSegments: override.maxVisibleSegments ?? base.maxVisibleSegments,
    keepEmbedMaxChars: override.keepEmbedMaxChars ?? base.keepEmbedMaxChars,
    lastSegmentSoftBlock: override.lastSegmentSoftBlock ?? base.lastSegmentSoftBlock,
    preserveRecentMessages: override.preserveRecentMessages ?? base.preserveRecentMessages,
    preserveRecentTokens: override.preserveRecentTokens ?? base.preserveRecentTokens,
    preserveLastUserMessage: override.preserveLastUserMessage ?? base.preserveLastUserMessage,
    completionReserveTokens: override.completionReserveTokens ?? base.completionReserveTokens,
    }
}

function mergeCommands(
    base: PluginConfig["commands"],
    override?: Partial<PluginConfig["commands"]>,
): PluginConfig["commands"] {
    if (!override) {
        return base
    }

    return {
        enabled: override.enabled ?? base.enabled,
        protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    }
}

function mergeExperimental(
    base: PluginConfig["experimental"],
    override?: Partial<PluginConfig["experimental"]>,
): PluginConfig["experimental"] {
    if (override === undefined) return base

    return {
        customPrompts: override.customPrompts ?? base.customPrompts,
    }
}

export function deepCloneConfig(config: PluginConfig): PluginConfig {
    return {
        ...config,
        commands: {
            enabled: config.commands.enabled,
            protectedTools: [...config.commands.protectedTools],
        },
        experimental: { ...config.experimental },
        protectedFilePatterns: [...config.protectedFilePatterns],
        compress: {
            ...config.compress,
            modelMaxLimits: { ...config.compress.modelMaxLimits },
            modelMinLimits: { ...config.compress.modelMinLimits },
            providers: config.compress.providers
                ? Object.fromEntries(
                      Object.entries(config.compress.providers).map(([providerId, provider]) => [
                          providerId,
                          {
                              ...provider,
                              ...(provider.models
                                  ? {
                                        models: Object.fromEntries(
                                            Object.entries(provider.models).map(([modelId, model]) => [
                                                modelId,
                                                { ...model },
                                            ])
                                        ),
                                    }
                                  : {}),
                          },
                      ])
                  )
                : undefined,
            protectedTools: [...config.compress.protectedTools],
        },
        gc: {
            ...config.gc,
            batchCleanup: { ...config.gc.batchCleanup },
        },
        qualityGate: {
            enabled: config.qualityGate.enabled,
            algorithm: config.qualityGate.algorithm,
            algorithms: { ...config.qualityGate.algorithms },
        },
        messageFilters: {
            enabled: config.messageFilters.enabled,
            filters: Object.fromEntries(
                Object.entries(config.messageFilters.filters).map(([k, v]) => [k, { ...v }]),
            ),
        },
    }
}

function mergeGC(base: GCConfig, override?: Partial<GCConfig>): GCConfig {
    if (!override) {
        return base
    }

    return {
        ...base,
        ...override,
        batchCleanup: { ...base.batchCleanup, ...(override.batchCleanup ?? {}) },
    }
}

function mergeQualityGate(
    base: QualityGateConfig,
    override?: Partial<QualityGateConfig>,
): QualityGateConfig {
    if (!override) return base
    return {
        enabled: override.enabled ?? base.enabled,
        algorithm: override.algorithm ?? base.algorithm,
        algorithms: { ...base.algorithms, ...(override.algorithms ?? {}) },
    }
}

function mergeMessageFilters(
    base: MessageFiltersConfig,
    override?: Partial<MessageFiltersConfig>,
): MessageFiltersConfig {
    if (!override) return base
    const mergedFilters = { ...base.filters }
    if (override.filters) {
        for (const [name, fc] of Object.entries(override.filters)) {
            const existing = mergedFilters[name]
            mergedFilters[name] = existing
                ? { ...existing, ...fc }
                : { enabled: fc?.enabled ?? true }
        }
    }
    return {
        enabled: override.enabled ?? base.enabled,
        filters: mergedFilters,
    }
}

function mergeLayer(config: PluginConfig, data: Record<string, any>): PluginConfig {
    return {
        enabled: data.enabled ?? config.enabled,
        autoUpdate: data.autoUpdate ?? config.autoUpdate,
        debug: data.debug ?? config.debug,
        logLevel: data.logLevel ?? config.logLevel,
        allowSubAgents: data.allowSubAgents ?? data.experimental?.allowSubAgents ?? config.allowSubAgents,
        pruneNotification: data.pruneNotification ?? config.pruneNotification,
        pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
        commands: mergeCommands(config.commands, data.commands as any),
        experimental: mergeExperimental(config.experimental, data.experimental as any),
        protectedFilePatterns: [
            ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
        ],
        compress: mergeCompress(config.compress, data.compress as CompressOverride),
        gc: mergeGC(config.gc, data.gc as Partial<GCConfig>),
        qualityGate: mergeQualityGate(config.qualityGate, data.qualityGate as Partial<QualityGateConfig>),
        messageFilters: mergeMessageFilters(config.messageFilters, data.messageFilters as Partial<MessageFiltersConfig>),
    }
}

function scheduleParseWarning(ctx: PluginInput, title: string, message: string): void {
    setTimeout(() => {
        try {
            ctx.client.tui.showToast({
                body: {
                    title,
                    message,
                    variant: "warning",
                    duration: 7000,
                },
            })
        } catch {}
    }, 7000)
}

export function getConfig(ctx: PluginInput): PluginConfig {
    let config = deepCloneConfig(defaultConfig)
    const configPaths = getConfigPaths(ctx)

    if (!configPaths.global && !existsSync(GLOBAL_CONFIG_PATH_JSONC)) {
        createDefaultConfig()
    }

    const layers: Array<{ path: string | null; name: string; isProject: boolean }> = [
        { path: configPaths.global, name: "config", isProject: false },
        { path: configPaths.configDir, name: "configDir config", isProject: true },
        { path: configPaths.project, name: "project config", isProject: true },
    ]

    for (const layer of layers) {
        if (!layer.path) {
            continue
        }

        const result = loadConfigFile(layer.path)
        if (result.parseError) {
            scheduleParseWarning(
                ctx,
                `ACP: Invalid ${layer.name}`,
                `${layer.path}\n${result.parseError}\nUsing previous/default values`,
            )
            continue
        }

        if (!result.data) {
            continue
        }

        showConfigWarnings(ctx, layer.path, result.data, layer.isProject)
        config = mergeLayer(config, result.data)
    }

    return config
}
