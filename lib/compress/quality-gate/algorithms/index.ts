import { registerQualityGate } from "../registry"
import { rougeRecallV1 } from "./rouge-recall-v1"

let initialized = false

export function ensureBuiltinGatesRegistered(): void {
    if (initialized) return
    registerQualityGate(rougeRecallV1)
    initialized = true
}

export { rougeRecallV1 } from "./rouge-recall-v1"
