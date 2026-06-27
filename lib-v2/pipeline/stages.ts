import type { PipelineStage } from "./types"
import { syncCompressionBlocks } from "../messages/sync"
import { deduplicate } from "../strategies"
import { purgeErrors } from "../strategies"
import { runMajorGC } from "../gc"
import { prune } from "../messages/prune"
import { stripStaleMetadata } from "../messages/reasoning-strip"
import { stripHallucinations } from "../messages/utils"

export function createMessageTransformStages(): PipelineStage[] {
    return [
        {
            name: "00-check-session",
            run: (ctx) => {
                if (!ctx.deps.state.sessionId) {
                    ctx.deps.logger.warn("No session ID — skipping pipeline")
                    ctx.shouldSkip = true
                }
            },
        },
        {
            name: "01-strip-hallucinations",
            run: (ctx) => {
                stripHallucinations(ctx.messages)
            },
        },
        {
            name: "02-assign-message-refs",
            run: (ctx) => {
                if (ctx.deps.assignMessageRefs) {
                    ctx.deps.assignMessageRefs(ctx.deps.state, ctx.messages)
                }
            },
        },
        {
            name: "03-sync-compression-blocks",
            run: (ctx) => {
                syncCompressionBlocks(ctx.deps.state, ctx.deps.logger, ctx.messages)
            },
        },
        {
            name: "04-deduplicate",
            run: (ctx) => {
                if (ctx.deps.config.strategies.deduplication.enabled) {
                    deduplicate(ctx.deps.state, ctx.deps.logger, ctx.deps.config, ctx.messages)
                }
            },
        },
        {
            name: "05-purge-errors",
            run: (ctx) => {
                if (ctx.deps.config.strategies.purgeErrors.enabled) {
                    purgeErrors(ctx.deps.state, ctx.deps.logger, ctx.deps.config, ctx.messages)
                }
            },
        },
        {
            name: "06-major-gc",
            run: (ctx) => {
                runMajorGC(ctx.deps.state, ctx.deps.config, ctx.deps.logger)
            },
        },
        {
            name: "07-prune",
            run: (ctx) => {
                prune(ctx.deps.state, ctx.deps.logger, ctx.deps.config, ctx.messages)
            },
        },
        {
            name: "08-inject-nudges",
            run: (ctx) => {
                if (ctx.deps.injectCompressNudges) {
                    ctx.deps.injectCompressNudges(
                        ctx.deps.state,
                        ctx.deps.config,
                        ctx.deps.logger,
                        ctx.messages,
                    )
                }
            },
        },
        {
            name: "09-inject-message-ids",
            run: (ctx) => {
                if (ctx.deps.injectMessageIds) {
                    ctx.deps.injectMessageIds(
                        ctx.deps.state,
                        ctx.deps.config,
                        ctx.deps.logger,
                        ctx.messages,
                    )
                }
            },
        },
        {
            name: "10-apply-anchored-nudges",
            run: (ctx) => {
                if (ctx.deps.applyAnchoredNudges) {
                    ctx.deps.applyAnchoredNudges(
                        ctx.deps.state,
                        ctx.deps.config,
                        ctx.deps.logger,
                        ctx.messages,
                    )
                }
            },
        },
        {
            name: "11-strip-stale-metadata",
            run: (ctx) => {
                stripStaleMetadata(ctx.messages)
            },
        },
    ]
}
