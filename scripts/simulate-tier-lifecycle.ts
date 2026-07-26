/**
 * Multi-tier compression lifecycle simulation.
 *
 * Models a session from empty → T1 triggers → T2 triggers → T3 triggers.
 * Tracks BOTH instantaneous context size AND cumulative token consumption
 * (the billing metric — sum of all API call inputs).
 *
 * Run: node --import tsx scripts/simulate-tier-lifecycle.ts
 */

const PARAMS = {
    modelContextLimit: 1_000_000,
    nudgeGrowthTokens: 50_000,
    dailyGrowthTokens: 7_300,
    t1Ratio: 45,
    t2Ratio: 10,
    t3Ratio: 3,
    maxDays: 365 * 5,
}

const TOKENS_PER_TURN = 2_000
const TURNS_PER_DAY = Math.round(PARAMS.dailyGrowthTokens / TOKENS_PER_TURN)
const SYSTEM_PROMPT_OVERHEAD = 10_000

interface SimState {
    visibleTokens: number
    cumulativeWithACP: number
    cumulativeWithoutACP: number
    withoutACPTokens: number
    t1Summaries: number
    t2Summaries: number
    t3Summaries: number
    lastT1Trigger: number
    t1Count: number
    t2Count: number
    t3Count: number
    events: { day: number; type: string; details: string }[]
}

function simulate(): SimState {
    const s: SimState = {
        visibleTokens: 0,
        cumulativeWithACP: 0,
        cumulativeWithoutACP: 0,
        withoutACPTokens: 0,
        t1Summaries: 0,
        t2Summaries: 0,
        t3Summaries: 0,
        lastT1Trigger: 0,
        t1Count: 0,
        t2Count: 0,
        t3Count: 0,
        events: [],
    }

    for (let day = 1; day <= PARAMS.maxDays; day++) {
        for (let turn = 0; turn < TURNS_PER_DAY; turn++) {
            s.cumulativeWithACP += s.visibleTokens + SYSTEM_PROMPT_OVERHEAD
            s.cumulativeWithoutACP += s.withoutACPTokens + SYSTEM_PROMPT_OVERHEAD
            s.visibleTokens += TOKENS_PER_TURN
            s.withoutACPTokens += TOKENS_PER_TURN

            const t1Growth = s.visibleTokens - s.lastT1Trigger
            if (t1Growth >= PARAMS.nudgeGrowthTokens) {
                const compressed = t1Growth
                const summary = Math.round(compressed / PARAMS.t1Ratio)
                s.visibleTokens -= compressed - summary
                s.t1Summaries += summary
                s.lastT1Trigger = s.visibleTokens
                s.t1Count++
                s.events.push({ day, type: "T1", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
            }

            if (s.t1Summaries >= PARAMS.nudgeGrowthTokens) {
                const compressed = s.t1Summaries
                const summary = Math.round(compressed / PARAMS.t2Ratio)
                s.visibleTokens -= compressed - summary
                s.t1Summaries = 0
                s.t2Summaries += summary
                s.t2Count++
                s.events.push({ day, type: "T2", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
            }

            if (s.t2Summaries >= PARAMS.nudgeGrowthTokens) {
                const compressed = s.t2Summaries
                const summary = Math.round(compressed / PARAMS.t3Ratio)
                s.visibleTokens -= compressed - summary
                s.t2Summaries = 0
                s.t3Summaries += summary
                s.t3Count++
                s.events.push({ day, type: "T3", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
            }
        }
    }

    return s
}

function fmt(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return String(n)
}

function main() {
    console.log("═".repeat(80))
    console.log("  Multi-Tier Compression Lifecycle Simulation")
    console.log("═".repeat(80))
    console.log()
    console.log("Parameters:")
    console.log(`  Model context limit:    ${fmt(PARAMS.modelContextLimit)}`)
    console.log(`  nudgeGrowthTokens:      ${fmt(PARAMS.nudgeGrowthTokens)}`)
    console.log(`  Daily growth:           ${fmt(PARAMS.dailyGrowthTokens)} tokens/day`)
    console.log(`  Tokens per turn:        ${fmt(TOKENS_PER_TURN)}`)
    console.log(`  Turns per day:          ${TURNS_PER_DAY}`)
    console.log(`  System prompt overhead: ${fmt(SYSTEM_PROMPT_OVERHEAD)}/call`)
    console.log(`  T1 ratio:               ${PARAMS.t1Ratio}x`)
    console.log(`  T2 ratio:               ${PARAMS.t2Ratio}x`)
    console.log(`  T3 ratio:               ${PARAMS.t3Ratio}x`)
    console.log(`  Simulation period:      ${PARAMS.maxDays} days (${(PARAMS.maxDays/365).toFixed(1)} years)`)
    console.log()

    const s = simulate()
    const totalTurns = PARAMS.maxDays * TURNS_PER_DAY
    const savings = s.cumulativeWithoutACP - s.cumulativeWithACP
    const savingsPct = (savings / s.cumulativeWithoutACP * 100)

    // ── Cumulative Token Consumption ────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Cumulative Token Consumption (Billing Metric)")
    console.log("─".repeat(80))
    console.log()
    console.log(`  Total API calls:          ${totalTurns}`)
    console.log()
    console.log(`  Without ACP:              ${fmt(s.cumulativeWithoutACP)} tokens`)
    console.log(`  With ACP (3-tier):        ${fmt(s.cumulativeWithACP)} tokens`)
    console.log(`  Savings:                  ${fmt(savings)} tokens (${savingsPct.toFixed(1)}%)`)
    console.log()

    // ── Milestone Table ─────────────────────────────────────────────────
    console.log("  Milestone savings over time:")
    console.log()
    console.log("  " + "Period".padEnd(12) + "Without ACP".padStart(14) + "With ACP".padStart(14) + "Savings".padStart(10) + "%".padStart(7))
    console.log("  " + "─".repeat(57))

    const milestones = [
        { label: "1 day", days: 1 },
        { label: "1 week", days: 7 },
        { label: "1 month", days: 30 },
        { label: "3 months", days: 90 },
        { label: "6 months", days: 180 },
        { label: "1 year", days: 365 },
        { label: "2 years", days: 730 },
        { label: "5 years", days: 1825 },
    ]

    for (const m of milestones) {
        if (m.days > PARAMS.maxDays) continue
        const turns = m.days * TURNS_PER_DAY
        let cumACP = 0
        let cumNoACP = 0
        let visTok = 0
        let noACP = 0
        let lastT1 = 0
        let t1Sum = 0
        for (let d = 1; d <= m.days; d++) {
            for (let t = 0; t < TURNS_PER_DAY; t++) {
                cumACP += visTok + SYSTEM_PROMPT_OVERHEAD
                cumNoACP += noACP + SYSTEM_PROMPT_OVERHEAD
                visTok += TOKENS_PER_TURN
                noACP += TOKENS_PER_TURN
                const growth = visTok - lastT1
                if (growth >= PARAMS.nudgeGrowthTokens) {
                    const summary = Math.round(growth / PARAMS.t1Ratio)
                    visTok -= growth - summary
                    t1Sum += summary
                    lastT1 = visTok
                }
                if (t1Sum >= PARAMS.nudgeGrowthTokens) {
                    const summary = Math.round(t1Sum / PARAMS.t2Ratio)
                    visTok -= t1Sum - summary
                    t1Sum = 0
                }
            }
        }
        const msavings = cumNoACP - cumACP
        const mpct = (msavings / cumNoACP * 100)
        console.log("  " + m.label.padEnd(12) + fmt(cumNoACP).padStart(14) + fmt(cumACP).padStart(14) + fmt(msavings).padStart(10) + `${mpct.toFixed(0)}%`.padStart(7))
    }
    console.log()

    // ── Compression Statistics ──────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Compression Statistics")
    console.log("─".repeat(80))
    console.log()
    console.log(`  T1: ${s.t1Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t1Count)} days)`)
    if (s.t2Count > 0) {
        console.log(`  T2: ${s.t2Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t2Count)} days)`)
    } else {
        console.log(`  T2: not triggered in ${PARAMS.maxDays} days`)
    }
    if (s.t3Count > 0) {
        console.log(`  T3: ${s.t3Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t3Count)} days)`)
    } else {
        console.log(`  T3: not triggered in ${PARAMS.maxDays} days`)
    }
    console.log()

    // ── Final State ─────────────────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Final State")
    console.log("─".repeat(80))
    console.log(`  Visible context (ACP):    ${fmt(s.visibleTokens)} (${(s.visibleTokens / PARAMS.modelContextLimit * 100).toFixed(1)}% of limit)`)
    console.log(`  Without ACP would be:     ${fmt(s.withoutACPTokens)} (${(s.withoutACPTokens / PARAMS.modelContextLimit * 100).toFixed(1)}% of limit)`)
    console.log(`  Summary overhead:         ${fmt(s.t1Summaries + s.t2Summaries + s.t3Summaries)} tokens`)
    console.log()

    // ── Key Insight ─────────────────────────────────────────────────────
    console.log("═".repeat(80))
    console.log("  KEY INSIGHT")
    console.log("═".repeat(80))
    console.log()
    console.log(`  Without ACP: cumulative = O(n²) — grows quadratically with session length`)
    console.log(`  With ACP:    cumulative = O(n)  — grows linearly (context bounded)`)
    console.log()
    console.log(`  At ${totalTurns} turns over ${(PARAMS.maxDays/365).toFixed(1)} years:`)
    console.log(`    Without ACP: ${fmt(s.cumulativeWithoutACP)} tokens consumed`)
    console.log(`    With ACP:    ${fmt(s.cumulativeWithACP)} tokens consumed`)
    console.log(`    Saved:       ${fmt(savings)} tokens (${savingsPct.toFixed(1)}% reduction)`)
    console.log()
}

main()
