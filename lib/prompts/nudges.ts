export interface NudgeContext {
    contextUsagePercent: number
    messagesSinceLastUser: number
    currentTurn: number
    lastNudgeTurn: number
    nudgeFrequency: number
    force: "soft" | "strong"
}

export function shouldNudgeContextLimit(ctx: NudgeContext): boolean {
    return ctx.contextUsagePercent >= 55
}

export function renderContextLimitNudge(ctx: NudgeContext): string {
    const urgency = ctx.force === "strong" ? "URGENT" : "consider"
    return `[Context usage at ${ctx.contextUsagePercent}%] ${urgency} using the compress tool to free context. ` +
        `Identify completed sections of the conversation and compress them into summaries. ` +
        `Prioritize the largest uncompressed content first — compressing a 5000-token tool output frees far more than re-summarizing a 300-token block.`
}

export function shouldNudgeTurn(ctx: NudgeContext): boolean {
    return ctx.currentTurn - ctx.lastNudgeTurn >= ctx.nudgeFrequency
}

export function renderTurnNudge(ctx: NudgeContext): string {
    return `[Turn ${ctx.currentTurn}] Context management reminder: ` +
        `If earlier conversation sections are complete, consider using compress to free context for upcoming work.`
}

export function shouldNudgeIteration(ctx: NudgeContext, threshold: number): boolean {
    return ctx.messagesSinceLastUser >= threshold
}

export function renderIterationNudge(ctx: NudgeContext): string {
    return `[${ctx.messagesSinceLastUser} messages since last user input] ` +
        `The conversation is getting long. Consider compressing completed work to maintain context quality.`
}
