import type { Logger } from "../../logger"
import type { PluginConfig } from "../../config"
import type { SessionState, WithParts } from "../../state/types"
import type { CompressionBlock } from "../../state/types"
import type { Part } from "@opencode-ai/sdk/v2"
import type {
    QualityGateContext,
    QualityGateResult,
    QualityReport,
} from "./types"
import type { NotificationEntry } from "../pipeline"
import { ensureBuiltinGatesRegistered } from "./algorithms"
import { getQualityGate } from "./registry"

const CHARS_PER_TOKEN_ESTIMATE = 4
const TOOL_OUTPUT_MAX_CHARS = 1500
const TOOL_INPUT_MAX_CHARS = 500

function extractMessageText(parts: Part[] | undefined): string {
    if (!parts || !Array.isArray(parts)) return ""
    let text = ""
    for (const part of parts) {
        if (!part || typeof part !== "object") continue
        if (part.type === "text") {
            text += part.text + "\n"
        } else if (part.type === "tool") {
            const state = part.state
            const input = state.status === "completed" && typeof state.input === "object"
                ? JSON.stringify(state.input).slice(0, TOOL_INPUT_MAX_CHARS)
                : ""
            const output = state.status === "completed" && typeof state.output === "string"
                ? state.output.slice(0, TOOL_OUTPUT_MAX_CHARS)
                : state.status === "completed" && typeof state.output === "object"
                  ? JSON.stringify(state.output).slice(0, TOOL_OUTPUT_MAX_CHARS)
                  : ""
            text += `[tool:${part.tool}] ${input}\n${output}\n`
        }
    }
    return text
}

function buildContext(
    block: CompressionBlock,
    rawMessages: WithParts[],
): QualityGateContext | null {
    const directIds = block.directMessageIds
    if (!directIds || directIds.length === 0) return null

    const idToMsg = new Map<string, WithParts>()
    for (const m of rawMessages) {
        const id = m?.info?.id
        if (typeof id === "string") idToMsg.set(id, m)
    }

    const chunks: string[] = []
    for (const id of directIds) {
        const m = idToMsg.get(id)
        if (!m) continue
        chunks.push(extractMessageText(m.parts))
    }
    if (chunks.length === 0) return null

    const originalText = chunks.join("\n")
    return {
        block,
        summary: block.summary ?? "",
        originalChunks: chunks,
        originalText,
        originalTokens: Math.ceil(originalText.length / CHARS_PER_TOKEN_ESTIMATE),
    }
}

export function evaluateBlockQuality(
    state: SessionState,
    rawMessages: WithParts[],
    entry: NotificationEntry,
    config: PluginConfig,
    logger: Logger,
): QualityGateResult | null {
    const qg = config.qualityGate
    if (!qg || qg.enabled !== true) return null

    ensureBuiltinGatesRegistered()
    const algoName = qg.algorithm
    if (!algoName) {
        logger.warn("Quality gate enabled but no algorithm specified", {})
        return null
    }
    const gate = getQualityGate(algoName)
    if (!gate) {
        logger.warn("Quality gate algorithm not found in registry", { algorithm: algoName })
        return null
    }

    const block = state.prune.messages.blocksById.get(entry.blockId)
    if (!block) {
        logger.warn("Quality gate: block not found", { blockId: entry.blockId })
        return null
    }

    const ctx = buildContext(block, rawMessages)
    if (!ctx) return null

    const algoConfig = (qg.algorithms && qg.algorithms[algoName]) ?? {}
    try {
        return gate.evaluate(ctx, algoConfig)
    } catch (err) {
        logger.warn("Quality gate threw — treating as pass", {
            gate: gate.name,
            blockId: entry.blockId,
            error: err instanceof Error ? err.message : String(err),
        })
        return { passed: true, metrics: [] }
    }
}

export function evaluateBatchQuality(
    state: SessionState,
    rawMessages: WithParts[],
    entries: NotificationEntry[],
    config: PluginConfig,
    logger: Logger,
): QualityReport {
    const failures: QualityReport["failures"] = []
    for (const entry of entries) {
        const result = evaluateBlockQuality(state, rawMessages, entry, config, logger)
        if (result && !result.passed) {
            failures.push({ blockId: entry.blockId, result })
        }
    }
    return {
        total: entries.length,
        passed: entries.length - failures.length,
        failures,
    }
}
