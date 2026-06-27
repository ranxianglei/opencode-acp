import type { PluginConfig } from "./types"

export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    autoUpdate: true,
    debug: false,
    pruneNotification: "detailed",
    pruneNotificationType: "chat",
    commands: {
        enabled: true,
        protectedTools: ["task", "skill", "todowrite", "todoread", "compress", "batch", "plan_enter", "plan_exit", "write", "edit"],
    },
    manualMode: {
        enabled: false,
        automaticStrategies: true,
    },
    turnProtection: {
        enabled: false,
        turns: 4,
    },
    experimental: {
        allowSubAgents: false,
        customPrompts: false,
    },
    protectedFilePatterns: [],
    compress: {
        mode: "range",
        permission: "allow",
        showCompression: true,
        summaryBuffer: true,
        maxContextLimit: "55%",
        minContextLimit: "45%",
        nudgeFrequency: 5,
        iterationNudgeThreshold: 15,
        nudgeForce: "soft",
        protectedTools: ["task", "skill", "todowrite", "todoread"],
        protectTags: false,
        protectUserMessages: false,
    },
    strategies: {
        deduplication: { enabled: true, protectedTools: [] },
        purgeErrors: { enabled: true, turns: 4, protectedTools: [] },
    },
    gc: {
        algorithm: "truncate",
        promotionThreshold: 5,
        maxBlockAge: 15,
        maxOldGenSummaryLength: 3000,
        majorGcThresholdPercent: "100%",
        batchCleanup: {
            lowThreshold: "60%",
            highThreshold: "75%",
            forceThreshold: "90%",
        },
    },
}
