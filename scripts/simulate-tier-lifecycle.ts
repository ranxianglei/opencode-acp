/**
 * Multi-tier compression lifecycle simulation.
 *
 * Models a session from empty → T1 triggers → T2 triggers → T3 triggers.
 * Uses real-world parameters from production session data.
 *
 * Run: node --import tsx scripts/simulate-tier-lifecycle.ts
 */

const PARAMS = {
    modelContextLimit: 1_000_000,
    nudgeGrowthTokens: 50_000,
    dailyGrowthTokens: 7_300,
    t1Ratio: 45,   // raw → T1 summary (from real session: 3.5M → 78K)
    t2Ratio: 10,   // T1 summary → T2 distilled (conservative estimate)
    t3Ratio: 3,    // T2 distilled → T3 condensed (conservative estimate)
    maxDays: 365 * 5,
}

interface SimState {
    visibleTokens: number
    t1Summaries: number
    t2Summaries: number
    t3Summaries: number
    lastT1Trigger: number
    totalRawGrowth: number
    t1Count: number
    t2Count: number
    t3Count: number
    totalT1Compressed: number
    totalT2Compressed: number
    totalT3Compressed: number
    totalT1SummaryOut: number
    totalT2SummaryOut: number
    totalT3SummaryOut: number
    events: { day: number; type: string; details: string }[]
}

function simulate(): SimState {
    const s: SimState = {
        visibleTokens: 0,
        t1Summaries: 0,
        t2Summaries: 0,
        t3Summaries: 0,
        lastT1Trigger: 0,
        totalRawGrowth: 0,
        t1Count: 0,
        t2Count: 0,
        t3Count: 0,
        totalT1Compressed: 0,
        totalT2Compressed: 0,
        totalT3Compressed: 0,
        totalT1SummaryOut: 0,
        totalT2SummaryOut: 0,
        totalT3SummaryOut: 0,
        events: [],
    }

    for (let day = 1; day <= PARAMS.maxDays; day++) {
        s.visibleTokens += PARAMS.dailyGrowthTokens
        s.totalRawGrowth += PARAMS.dailyGrowthTokens

        // T1 trigger: raw growth since last T1 >= nudgeGrowthTokens
        const t1Growth = s.visibleTokens - s.lastT1Trigger
        if (t1Growth >= PARAMS.nudgeGrowthTokens) {
            const compressed = t1Growth
            const summary = Math.round(compressed / PARAMS.t1Ratio)
            s.visibleTokens -= compressed - summary
            s.t1Summaries += summary
            s.lastT1Trigger = s.visibleTokens
            s.t1Count++
            s.totalT1Compressed += compressed
            s.totalT1SummaryOut += summary
            s.events.push({ day, type: "T1", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
        }

        // T2 trigger: T1 summaries >= nudgeGrowthTokens
        if (s.t1Summaries >= PARAMS.nudgeGrowthTokens) {
            const compressed = s.t1Summaries
            const summary = Math.round(compressed / PARAMS.t2Ratio)
            s.visibleTokens -= compressed - summary
            s.t1Summaries = 0
            s.t2Summaries += summary
            s.t2Count++
            s.totalT2Compressed += compressed
            s.totalT2SummaryOut += summary
            s.events.push({ day, type: "T2", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
        }

        // T3 trigger: T2 summaries >= nudgeGrowthTokens
        if (s.t2Summaries >= PARAMS.nudgeGrowthTokens) {
            const compressed = s.t2Summaries
            const summary = Math.round(compressed / PARAMS.t3Ratio)
            s.visibleTokens -= compressed - summary
            s.t2Summaries = 0
            s.t3Summaries += summary
            s.t3Count++
            s.totalT3Compressed += compressed
            s.totalT3SummaryOut += summary
            s.events.push({ day, type: "T3", details: `${(compressed/1000).toFixed(1)}K→${summary}tok` })
        }
    }

    return s
}

function fmt(n: number): string {
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
    console.log(`  nudgeGrowthTokens:      ${fmt(PARAMS.nudgeGrowthTokens)} (trigger threshold for all tiers)`)
    console.log(`  Daily growth:           ${fmt(PARAMS.dailyGrowthTokens)} tokens/day`)
    console.log(`  T1 compression ratio:   ${PARAMS.t1Ratio}x (raw → T1 summary)`)
    console.log(`  T2 compression ratio:   ${PARAMS.t2Ratio}x (T1 → T2 distilled)`)
    console.log(`  T3 compression ratio:   ${PARAMS.t3Ratio}x (T2 → T3 condensed)`)
    console.log(`  Simulation period:      ${PARAMS.maxDays} days (${(PARAMS.maxDays/365).toFixed(1)} years)`)
    console.log()

    const s = simulate()

    // ── Event Timeline ──────────────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Event Timeline (first 30 + last 10)")
    console.log("─".repeat(80))
    const first30 = s.events.slice(0, 30)
    const last10 = s.events.slice(-10)
    for (const e of first30) {
        const years = (e.day / 365).toFixed(2)
        console.log(`  Day ${String(e.day).padStart(5)} (${years}y)  ${e.type}: ${e.details}`)
    }
    if (s.events.length > 40) {
        console.log(`  ... (${s.events.length - 40} more events) ...`)
    }
    for (const e of last10) {
        const years = (e.day / 365).toFixed(2)
        console.log(`  Day ${String(e.day).padStart(5)} (${years}y)  ${e.type}: ${e.details}`)
    }
    console.log()

    // ── Summary Statistics ──────────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Compression Statistics")
    console.log("─".repeat(80))
    console.log()
    console.log("  Tier 1 (raw → summary):")
    console.log(`    Total triggers:        ${s.t1Count}`)
    console.log(`    Total compressed:      ${fmt(s.totalT1Compressed)} tokens`)
    console.log(`    Total summary output:  ${fmt(s.totalT1SummaryOut)} tokens`)
    console.log(`    Actual ratio:          ${(s.totalT1Compressed / s.totalT1SummaryOut).toFixed(1)}x`)
    console.log(`    Frequency:             every ${(PARAMS.maxDays / s.t1Count).toFixed(1)} days`)
    console.log()
    console.log("  Tier 2 (T1 → T2 distilled):")
    if (s.t2Count > 0) {
        console.log(`    Total triggers:        ${s.t2Count}`)
        console.log(`    Total compressed:      ${fmt(s.totalT2Compressed)} tokens`)
        console.log(`    Total summary output:  ${fmt(s.totalT2SummaryOut)} tokens`)
        console.log(`    Actual ratio:          ${(s.totalT2Compressed / s.totalT2SummaryOut).toFixed(1)}x`)
        console.log(`    Frequency:             every ${(PARAMS.maxDays / s.t2Count).toFixed(1)} days`)
    } else {
        console.log(`    Not triggered in ${PARAMS.maxDays} days`)
        const t1PerT2 = Math.ceil(PARAMS.nudgeGrowthTokens / (PARAMS.nudgeGrowthTokens / PARAMS.t1Ratio))
        console.log(`    Estimated: needs ${t1PerT2} T1 compressions to accumulate ${fmt(PARAMS.nudgeGrowthTokens)} T1 tokens`)
    }
    console.log()
    console.log("  Tier 3 (T2 → T3 condensed):")
    if (s.t3Count > 0) {
        console.log(`    Total triggers:        ${s.t3Count}`)
        console.log(`    Total compressed:      ${fmt(s.totalT3Compressed)} tokens`)
        console.log(`    Total summary output:  ${fmt(s.totalT3SummaryOut)} tokens`)
        console.log(`    Actual ratio:          ${(s.totalT3Compressed / s.totalT3SummaryOut).toFixed(1)}x`)
        console.log(`    Frequency:             every ${(PARAMS.maxDays / s.t3Count).toFixed(1)} days`)
    } else {
        console.log(`    Not triggered in ${PARAMS.maxDays} days`)
    }
    console.log()

    // ── Final State ─────────────────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Final State")
    console.log("─".repeat(80))
    console.log(`  Total raw growth:       ${fmt(s.totalRawGrowth)} tokens`)
    console.log(`  Visible context:        ${fmt(s.visibleTokens)} tokens (${(s.visibleTokens / PARAMS.modelContextLimit * 100).toFixed(1)}% of limit)`)
    console.log(`  T1 summaries (pending): ${fmt(s.t1Summaries)} tokens`)
    console.log(`  T2 summaries (pending): ${fmt(s.t2Summaries)} tokens`)
    console.log(`  T3 summaries (pending): ${fmt(s.t3Summaries)} tokens`)
    console.log(`  Total summary overhead: ${fmt(s.t1Summaries + s.t2Summaries + s.t3Summaries)} tokens`)
    console.log()

    // ── Theoretical Analysis ────────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Theoretical Analysis")
    console.log("─".repeat(80))

    const t1PerDay = PARAMS.dailyGrowthTokens / PARAMS.nudgeGrowthTokens
    const t1SummaryPerDay = PARAMS.dailyGrowthTokens / PARAMS.t1Ratio
    const daysToT2 = Math.ceil(PARAMS.nudgeGrowthTokens / t1SummaryPerDay)
    const t2SummaryPerT2 = PARAMS.nudgeGrowthTokens / PARAMS.t2Ratio
    const t2PerDay = 1 / daysToT2 * t2SummaryPerT2 / PARAMS.nudgeGrowthTokens
    const daysToT3 = Math.ceil(PARAMS.nudgeGrowthTokens / (t2SummaryPerT2 / daysToT2))

    console.log()
    console.log("  Trigger frequency (theoretical):")
    console.log(`    T1: every ${Math.ceil(1/t1PerDay)} days (${t1PerDay.toFixed(3)} triggers/day)`)
    console.log(`    T2: every ${daysToT2} days (needs ${Math.ceil(PARAMS.nudgeGrowthTokens / t1SummaryPerDay)} T1 triggers)`)
    console.log(`    T3: every ~${daysToT3} days (needs ${Math.ceil(PARAMS.nudgeGrowthTokens / t2SummaryPerT2)} T2 triggers)`)
    console.log()

    // ── Steady State Analysis ───────────────────────────────────────────
    console.log("─".repeat(80))
    console.log("  Steady-State Context Growth")
    console.log("─".repeat(80))
    console.log()
    console.log("  Without compression, context fills in:")
    console.log(`    ${Math.ceil(PARAMS.modelContextLimit / PARAMS.dailyGrowthTokens)} days (${(PARAMS.modelContextLimit / PARAMS.dailyGrowthTokens / 365).toFixed(1)} years)`)
    console.log()

    // Each T1 cycle: adds dailyGrowth*cycle, removes same, adds summary.
    // Net per day = dailyGrowth / t1Ratio (summary overhead only)
    const netT1PerDay = PARAMS.dailyGrowthTokens / PARAMS.t1Ratio
    console.log("  With T1 compression only:")
    console.log(`    Net growth: ${netT1PerDay.toFixed(0)} tokens/day (summary overhead)`)
    console.log(`    Context fills in: ${Math.ceil(PARAMS.modelContextLimit / netT1PerDay)} days (${(PARAMS.modelContextLimit / netT1PerDay / 365).toFixed(1)} years)`)
    console.log()

    // T2 periodically removes T1 summaries, reducing the T1 overhead
    const t2SummaryPerDay = netT1PerDay / PARAMS.t2Ratio
    const netT1T2PerDay = netT1PerDay - netT1PerDay + t2SummaryPerDay
    console.log("  With T1+T2 compression:")
    console.log(`    Net growth: ${netT1T2PerDay.toFixed(0)} tokens/day (T2 distilled overhead)`)
    console.log(`    Context fills in: ${Math.ceil(PARAMS.modelContextLimit / netT1T2PerDay)} days (${(PARAMS.modelContextLimit / netT1T2PerDay / 365).toFixed(1)} years)`)
    console.log()

    // T3 periodically removes T2 summaries
    const t3SummaryPerDay = t2SummaryPerDay / PARAMS.t3Ratio
    const netAllTiersPerDay = t2SummaryPerDay - t2SummaryPerDay + t3SummaryPerDay
    console.log("  With T1+T2+T3 compression:")
    console.log(`    Net growth: ${netAllTiersPerDay.toFixed(0)} tokens/day (T3 condensed overhead)`)
    console.log(`    Context fills in: ${Math.ceil(PARAMS.modelContextLimit / netAllTiersPerDay)} days (${(PARAMS.modelContextLimit / netAllTiersPerDay / 365).toFixed(1)} years)`)
    console.log()

    // Simulated actual
    console.log("  Simulated actual:")
    const actualPerDay = s.visibleTokens / PARAMS.maxDays
    console.log(`    Net growth: ${actualPerDay.toFixed(0)} tokens/day`)
    console.log(`    Context fills in: ${Math.ceil(PARAMS.modelContextLimit / actualPerDay)} days (${(PARAMS.modelContextLimit / actualPerDay / 365).toFixed(1)} years)`)
    console.log()

    // ── Conclusion ──────────────────────────────────────────────────────
    console.log("═".repeat(80))
    console.log("  CONCLUSION")
    console.log("═".repeat(80))
    console.log()
    if (s.t3Count > 0) {
        console.log(`  All 3 tiers activated within ${PARAMS.maxDays} days.`)
        console.log(`  T1: ${s.t1Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t1Count)} days)`)
        console.log(`  T2: ${s.t2Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t2Count)} days)`)
        console.log(`  T3: ${s.t3Count} compressions (every ${Math.ceil(PARAMS.maxDays/s.t3Count)} days)`)
    } else if (s.t2Count > 0) {
        console.log(`  T1+T2 activated, T3 NOT reached in ${PARAMS.maxDays} days.`)
        console.log(`  T3 requires ${daysToT3} days to first trigger.`)
    } else {
        console.log(`  Only T1 activated in ${PARAMS.maxDays} days.`)
        console.log(`  T2 requires ~${daysToT2} days to first trigger.`)
        console.log(`  T3 requires ~${daysToT3} days to first trigger.`)
    }
    console.log()
    console.log(`  Simulation period: ${PARAMS.maxDays} days = ${(PARAMS.maxDays/365).toFixed(1)} years`)
    console.log(`  Visible context at end: ${fmt(s.visibleTokens)} (${(s.visibleTokens/PARAMS.modelContextLimit*100).toFixed(1)}%)`)
    console.log()
}

main()
