import { rougeRecallV1 } from "context-compress-algorithms/quality-gate"
import { registerQualityGate } from "../registry"

export function ensureBuiltinGatesRegistered(): void {
    registerQualityGate(rougeRecallV1)
}

export { rougeRecallV1 } from "context-compress-algorithms/quality-gate"
