import type { SessionState, WithParts } from "../state"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type { RuntimePrompts } from "../prompts/store"
import type { HostPermissionSnapshot } from "../host-permissions"
import {
    buildPriorityMap,
    buildToolIdList,
    dropCompressReasoning,
    dropEmptyMessages,
    injectCompressNudges,
    injectMessageIds,
    prune,
    stripHallucinations,
    stripHallucinationsFromString,
    stripStaleMetadata,
    syncCompressionBlocks,
} from "./index"
import { applyCompressOverrides } from "./inject/utils"
import { DEFAULT_COMPRESS_REASONING } from "../config"
import { getLastUserMessage, isSyntheticMessage } from "./query"
import { OUTPUT_RESERVE_TOKENS, truncateLargeToolOutputs } from "./truncate-tools"
import { resolveEffectiveContextLimit } from "../state/utils"
import { enforceContextBudget } from "./enforce-budget"
import { syncCompressPermissionState } from "../compress-permission"
import { cacheSystemPromptTokens } from "../ui/utils"
import { runBatchCleanup } from "../gc/merge"
import { getCurrentTokenUsage } from "../token-utils"
import { DeferredMutationEffects } from "../state/transaction"
import { assignMessageRefs } from "../message-ids"
import { syncToolCache, updatePerTurnState } from "../state"
import { applyMessageFilters } from "./filter/apply"
import { hideConsumedCompressCalls } from "../compress/hide-consumed"
import { hideFailedCompressCalls } from "../compress/hide-failed"
import { isAcpOpaquePart } from "./opaque"

/** Inputs resolved by the host adapter before entering a state transaction. */
export interface MessageTransformOptions {
    requestModelLimit?: number
    modelLimitKnown?: boolean
    effects: DeferredMutationEffects
    /** Host-facing debug notification; the transform only stages its call. */
    debugNotify?: (text: string) => void | Promise<void>
    /** V2 has no post-generation hook; only historical assistant text is sanitized. */
    sanitizeAssistantTextOnly?: boolean
    /** [FIX #421] Token count of the outgoing system prompt measured on the current wire (V2). Floor for overhead calibration before any post-compaction usage exists. */
    measuredSystemTokens?: number
}

/**
 * Execute the state-mutating message pipeline against an explicit state.
 *
 * This function deliberately has no registry/client access. Host adapters own
 * session initialization and model lookup, and pass this function a ready
 * state plus deferred effects. That makes the same mutation body usable by V1
 * and by the V2 projection transaction.
 */
export async function runMessageTransform(
    messages: WithParts[],
    state: SessionState,
    config: PluginConfig,
    prompts: RuntimePrompts,
    logger: Logger,
    hostPermissions: HostPermissionSnapshot,
    options: MessageTransformOptions,
): Promise<void> {
    const lastUserMessage = getLastUserMessage(messages)
    const requestModel = (
        lastUserMessage?.info as { model?: { providerID?: string; modelID?: string } } | undefined
    )?.model

    const prevModelID = state.modelID
    if (options.requestModelLimit !== undefined) {
        state.modelContextLimit = options.requestModelLimit
        state.modelProviderID = requestModel?.providerID
        state.modelID = requestModel?.modelID
    } else if (
        requestModel?.providerID &&
        requestModel?.modelID &&
        state.modelContextLimit !== undefined &&
        (state.modelProviderID !== requestModel.providerID ||
            state.modelID !== requestModel.modelID)
    ) {
        state.modelContextLimit = undefined
        state.modelProviderID = requestModel.providerID
        state.modelID = requestModel.modelID
    }
    if (requestModel?.modelID && requestModel.modelID !== prevModelID) {
        logger.info("Model switched mid-session", {
            session: state.sessionId,
            from: prevModelID,
            to: requestModel.modelID,
            contextLimit: state.modelContextLimit,
        })
        // [FIX #421] Overhead was calibrated against the previous model's wire;
        // recalibrate instead of reusing a stale estimate.
        state.systemPromptTokens = undefined
        state.systemPromptTokensSource = undefined
    }

    if (
        state.modelContextLimit === undefined &&
        !state.noContextLimitWarned &&
        options.modelLimitKnown === false &&
        requestModel?.providerID &&
        requestModel?.modelID
    ) {
        state.noContextLimitWarned = true
        logger.warn(
            'Model reports no context window and the catalog has no entry for it; all percentage thresholds (min/max/emergency, GC) and the context-budget guard are disabled. Set the model limit in opencode.json (e.g. "limit": {"context": 262144, "output": 16384}) to enable them (also fixes the 32000 max_tokens fallback); an absolute compress.maxContextLimit in acp.jsonc only enables proactive nudges, not the guard.',
            {
                session: state.sessionId,
                model: `${requestModel.providerID}/${requestModel.modelID}`,
            },
        )
    }

    await updatePerTurnState(state, logger, messages, options.effects)

    syncCompressPermissionState(state, config, hostPermissions, messages)

    if (state.isSubAgent && !config.allowSubAgents) {
        return
    }

    if (options.sanitizeAssistantTextOnly) {
        for (const message of messages) {
            if (message.info.role !== "assistant") continue
            for (const part of message.parts) {
                if (
                    part.type === "text" &&
                    !isAcpOpaquePart(part) &&
                    typeof part.text === "string"
                ) {
                    part.text = stripHallucinationsFromString(part.text)
                }
            }
        }
    } else {
        stripHallucinations(messages)
    }

    const dropReasoningModel = (
        lastUserMessage?.info as { model?: { providerID?: string; modelID?: string } } | undefined
    )?.model
    const reasoningConfig = applyCompressOverrides(
        config,
        dropReasoningModel?.providerID ?? state.modelProviderID,
        dropReasoningModel?.modelID ?? state.modelID,
    ).compress.reasoning
    if (reasoningConfig?.drop !== false) {
        const droppedReasoning = dropCompressReasoning(
            messages,
            reasoningConfig?.threshold ?? DEFAULT_COMPRESS_REASONING.threshold,
        )
        if (droppedReasoning > 0) {
            logger.debug("compress.reasoning: dropped oversized reasoning parts", {
                dropped: droppedReasoning,
                threshold: reasoningConfig?.threshold ?? DEFAULT_COMPRESS_REASONING.threshold,
            })
        }
    }

    const effectiveLimit = resolveEffectiveContextLimit(state, config)
    applyMessageFilters(messages, config.messageFilters, logger, {
        sessionId: state.sessionId ?? "",
        isSubAgent: state.isSubAgent,
        modelContextLimit: effectiveLimit?.limit,
    })
    cacheSystemPromptTokens(state, messages, options.measuredSystemTokens)
    assignMessageRefs(state, messages)
    const activeBlockCountBefore = state.prune.messages.activeBlockIds.size
    const compressionStateChanged = syncCompressionBlocks(state, logger, messages)
    if (
        compressionStateChanged ||
        state.prune.messages.activeBlockIds.size !== activeBlockCountBefore
    ) {
        options.effects.requestPersistence()
    }
    syncToolCache(state, config, logger, messages)
    buildToolIdList(state, messages)
    const batchResult = runBatchCleanup(state, config, logger, messages)
    if (batchResult.mergedCount > 0) {
        options.effects.requestPersistence()
    }
    const prePruneTokens = getCurrentTokenUsage(state, messages)
    const candidateMessages = config.compress.candidates === true ? messages.slice() : undefined
    prune(state, logger, config, messages)
    hideConsumedCompressCalls(state, messages)
    assignMessageRefs(state, messages)
    const compressionPriorities = buildPriorityMap(config, state, messages)
    injectCompressNudges(
        state,
        config,
        logger,
        messages,
        prompts,
        compressionPriorities,
        config.debug
            ? (text: string) => {
                  logger.debug(`[ACP Debug] Nudge injected:\n${text}`)
                  options.effects.defer(() =>
                      options.debugNotify ? options.debugNotify(text.slice(0, 500)) : undefined,
                  )
              }
            : undefined,
        prePruneTokens,
        candidateMessages,
        options.effects,
    )
    truncateLargeToolOutputs(
        state,
        config,
        logger,
        messages.filter((message) => !isSyntheticMessage(message)),
    )
    enforceContextBudget(state, config, logger, messages)
    injectMessageIds(state, config, messages, compressionPriorities)
    hideFailedCompressCalls(messages)
    stripStaleMetadata(messages)
    dropEmptyMessages(messages)
    const postTokens = getCurrentTokenUsage(state, messages)
    if (postTokens !== undefined && effectiveLimit) {
        const budget =
            effectiveLimit.limit - (state.systemPromptTokens ?? 0) - OUTPUT_RESERVE_TOKENS
        if (postTokens > budget) {
            logger.error("ACP hard guard: context exceeds model budget after in-flight reduction", {
                session: state.sessionId,
                postTokens,
                budget,
                contextLimit: effectiveLimit.limit,
                contextLimitSource: effectiveLimit.source,
                hint: "request will likely be rejected; run /compact or start a new session",
            })
        }
    }
    if (state.sessionId) {
        options.effects.defer(() => logger.saveContext(state.sessionId!, messages))
    }

    logger.info("Chat transform complete", {
        session: state.sessionId,
        model: state.modelID,
        messages: messages.length,
        prePruneTokens,
        postTokens,
        contextLimit: effectiveLimit?.limit,
        contextLimitSource: effectiveLimit?.source,
        usagePct:
            postTokens !== undefined && effectiveLimit
                ? `${((postTokens / effectiveLimit.limit) * 100).toFixed(1)}%`
                : undefined,
        nudged: state.nudges.shouldInjectThisTurn,
    })
}
