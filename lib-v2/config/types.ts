export type CompressionMode = "range" | "message"

export type PruneNotification = "off" | "minimal" | "detailed"
export type PruneNotificationType = "chat" | "toast"
export type CompressPermission = "ask" | "allow" | "deny"
export type NudgeForce = "strong" | "soft"
export type GCAlgorithm = "truncate"
export type BlockGeneration = "young" | "old"
export type ManualModeState = false | "active" | "compress-pending"

export interface CommandsConfig {
    enabled: boolean
    protectedTools: string[]
}

export interface ManualModeConfig {
    enabled: boolean
    automaticStrategies: boolean
}

export interface TurnProtectionConfig {
    enabled: boolean
    turns: number
}

export interface ExperimentalConfig {
    allowSubAgents: boolean
    customPrompts: boolean
}

export interface CompressConfig {
    mode: CompressionMode
    permission: CompressPermission
    showCompression: boolean
    summaryBuffer: boolean
    maxContextLimit: number | string
    minContextLimit: number | string
    nudgeFrequency: number
    iterationNudgeThreshold: number
    nudgeForce: NudgeForce
    protectedTools: string[]
    protectTags: boolean
    protectUserMessages: boolean
    modelMaxLimits?: Record<string, number>
    modelMinLimits?: Record<string, number>
}

export interface DeduplicationConfig {
    enabled: boolean
    protectedTools: string[]
}

export interface PurgeErrorsConfig {
    enabled: boolean
    turns: number
    protectedTools: string[]
}

export interface StrategiesConfig {
    deduplication: DeduplicationConfig
    purgeErrors: PurgeErrorsConfig
}

export interface BatchCleanupConfig {
    lowThreshold: string
    highThreshold: string
    forceThreshold: string
}

export interface GCConfig {
    algorithm: GCAlgorithm
    promotionThreshold: number
    maxBlockAge: number
    maxOldGenSummaryLength: number
    majorGcThresholdPercent: string
    batchCleanup: BatchCleanupConfig
}

export interface PluginConfig {
    enabled: boolean
    autoUpdate: boolean
    debug: boolean
    pruneNotification: PruneNotification
    pruneNotificationType: PruneNotificationType
    commands: CommandsConfig
    manualMode: ManualModeConfig
    turnProtection: TurnProtectionConfig
    experimental: ExperimentalConfig
    protectedFilePatterns: string[]
    compress: CompressConfig
    strategies: StrategiesConfig
    gc: GCConfig
}
