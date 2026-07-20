import { defaultTriggerPolicy } from "context-compress-algorithms/trigger"
import { registerTriggerPolicy } from "./registry"

export function ensureBuiltinTriggerPolicyRegistered(): void {
    registerTriggerPolicy(defaultTriggerPolicy)
}

export type {
    TipsVariant,
    NudgeDecision,
    NudgeDecisionInput,
    CompressionTriggerPolicy,
} from "./types"
export {
    registerTriggerPolicy,
    getTriggerPolicy,
    listTriggerPolicies,
    getDefaultTriggerPolicy,
    setDefaultTriggerPolicy,
    clearTriggerPolicyRegistryForTests,
} from "./registry"
export { defaultTriggerPolicy } from "context-compress-algorithms/trigger"
