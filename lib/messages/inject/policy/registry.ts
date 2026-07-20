import type { CompressionTriggerPolicy, NudgeDecision, NudgeDecisionInput, TipsVariant } from "./types"

const registry = new Map<string, CompressionTriggerPolicy>()
let defaultPolicy: CompressionTriggerPolicy | null = null

export function registerTriggerPolicy(policy: CompressionTriggerPolicy): void {
    if (!policy.name) {
        throw new Error("TriggerPolicy must have a name")
    }
    registry.set(policy.name, policy)
    if (!defaultPolicy) {
        defaultPolicy = policy
    }
}

export function getTriggerPolicy(name: string): CompressionTriggerPolicy | undefined {
    return registry.get(name)
}

export function listTriggerPolicies(): string[] {
    return Array.from(registry.keys())
}

export function getDefaultTriggerPolicy(): CompressionTriggerPolicy | null {
    return defaultPolicy
}

export function setDefaultTriggerPolicy(name: string): boolean {
    const policy = registry.get(name)
    if (!policy) return false
    defaultPolicy = policy
    return true
}

export function clearTriggerPolicyRegistryForTests(): void {
    registry.clear()
    defaultPolicy = null
}
