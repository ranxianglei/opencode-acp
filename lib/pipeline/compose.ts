import type { PipelineContext, PipelineStage, PipelineDeps } from "./types"
import type { WithParts } from "../state/types"

export async function runPipeline(
    stages: PipelineStage[],
    deps: PipelineDeps,
    messages: WithParts[],
): Promise<void> {
    const ctx: PipelineContext = {
        messages,
        deps,
        shouldSkip: false,
    }

    for (const stage of stages) {
        if (ctx.shouldSkip) {
            deps.logger.debug("Pipeline skipped after stage", { stage: stage.name })
            return
        }

        try {
            await stage.run(ctx)
        } catch (err) {
            deps.logger.error("Pipeline stage failed", {
                stage: stage.name,
                error: err instanceof Error ? err.message : String(err),
            })
        }
    }
}
