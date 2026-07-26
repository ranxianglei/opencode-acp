const PARAMS = {
    modelContextLimit: 1_000_000,
    callsPerDay: 500,
    newContentPerCall: 9_560,
    outputPerCall: 400,
    systemOverhead: 10_000,
    nudgeGrowthTokens: 50_000,
    t1Ratio: 45,
    t2Ratio: 10,
    t3Ratio: 3,
    maxDays: 400,
}

interface SimState {
    rawPending: number
    t1Pending: number
    t2Pending: number
    t3Accumulated: number
    cumulativeTotal: number
    t1Count: number
    t2Count: number
    t3Count: number
    t1FirstDay: number | null
    t2FirstDay: number | null
    t3FirstDay: number | null
    limitDay: number | null
    cumulativeAtLimit: number | null
    milestones: { day: number; total: number; visible: number; t1s: number; t2s: number; t3s: number }[]
}

function getVisible(s: SimState): number {
    return PARAMS.systemOverhead + s.rawPending + s.t1Pending + s.t2Pending + s.t3Accumulated
}

function simulate(): SimState {
    const s: SimState = {
        rawPending: 0,
        t1Pending: 0,
        t2Pending: 0,
        t3Accumulated: 0,
        cumulativeTotal: 0,
        t1Count: 0,
        t2Count: 0,
        t3Count: 0,
        t1FirstDay: null,
        t2FirstDay: null,
        t3FirstDay: null,
        limitDay: null,
        cumulativeAtLimit: null,
        milestones: [],
    }

    const checkpoints = new Set([1, 7, 30, 90, 180, 365])

    for (let day = 1; day <= PARAMS.maxDays; day++) {
        for (let call = 0; call < PARAMS.callsPerDay; call++) {
            s.cumulativeTotal += getVisible(s) + PARAMS.outputPerCall
            s.rawPending += PARAMS.newContentPerCall

            if (s.rawPending >= PARAMS.nudgeGrowthTokens) {
                const compressed = s.rawPending
                const summary = Math.round(compressed / PARAMS.t1Ratio)
                s.rawPending = 0
                s.t1Pending += summary
                s.t1Count++
                if (s.t1FirstDay === null) s.t1FirstDay = day
            }

            if (s.t1Pending >= PARAMS.nudgeGrowthTokens) {
                const compressed = s.t1Pending
                const summary = Math.round(compressed / PARAMS.t2Ratio)
                s.t1Pending = 0
                s.t2Pending += summary
                s.t2Count++
                if (s.t2FirstDay === null) s.t2FirstDay = day
            }

            if (s.t2Pending >= PARAMS.nudgeGrowthTokens) {
                const compressed = s.t2Pending
                const summary = Math.round(compressed / PARAMS.t3Ratio)
                s.t2Pending = 0
                s.t3Accumulated += summary
                s.t3Count++
                if (s.t3FirstDay === null) s.t3FirstDay = day
            }
        }

        if (checkpoints.has(day) || (s.limitDay === null && getVisible(s) >= PARAMS.modelContextLimit)) {
            s.milestones.push({
                day,
                total: s.cumulativeTotal,
                visible: getVisible(s),
                t1s: s.t1Count,
                t2s: s.t2Count,
                t3s: s.t3Count,
            })
        }

        if (s.limitDay === null && getVisible(s) >= PARAMS.modelContextLimit) {
            s.limitDay = day
            s.cumulativeAtLimit = s.cumulativeTotal
        }
    }

    if (!s.limitDay) {
        s.limitDay = PARAMS.maxDays
        s.cumulativeAtLimit = s.cumulativeTotal
    }

    return s
}

function fmt(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
    return String(n)
}

function main() {
    console.log("═".repeat(80))
    console.log("  Real-Calibrated Lifecycle Simulation")
    console.log("═".repeat(80))
    console.log()
    console.log("Parameters (from real sessions):")
    console.log(`  API calls/day:      ${PARAMS.callsPerDay}`)
    console.log(`  New content/call:   ${fmt(PARAMS.newContentPerCall)}`)
    console.log(`  Daily raw growth:   ${fmt(PARAMS.callsPerDay * PARAMS.newContentPerCall)}/day`)
    console.log(`  Output/call:        ${PARAMS.outputPerCall}`)
    console.log(`  T1/T2/T3 ratios:    ${PARAMS.t1Ratio}x/${PARAMS.t2Ratio}x/${PARAMS.t3Ratio}x`)
    console.log(`  Trigger threshold:  ${fmt(PARAMS.nudgeGrowthTokens)}`)
    console.log(`  Context limit:      ${fmt(PARAMS.modelContextLimit)}`)
    console.log()

    const s = simulate()

    console.log("─".repeat(80))
    console.log("  Tier Activation")
    console.log("─".repeat(80))
    console.log(`  T1: day ${s.t1FirstDay} (${s.t1Count} total, ${Math.round(s.t1Count / s.limitDay!)}/day)`)
    console.log(`  T2: day ${s.t2FirstDay} (${s.t2Count} total, ${Math.round(s.t2Count / s.limitDay!)}/day)`)
    console.log(`  T3: day ${s.t3FirstDay} (${s.t3Count} total, ${Math.round(s.t3Count / s.limitDay!)}/day)`)
    console.log(`  Limit: day ${s.limitDay}`)
    console.log()

    console.log("─".repeat(80))
    console.log("  Cumulative Token Production")
    console.log("─".repeat(80))
    console.log()
    console.log("  " + "Period".padEnd(10) + "Total".padStart(14) + "Visible".padStart(12) + "T1/T2/T3".padStart(14))
    console.log("  " + "─".repeat(50))
    for (const m of s.milestones) {
        const label = m.day === 1 ? "1 day" : m.day === 7 ? "1 week" : m.day === 30 ? "1 month" : m.day === 90 ? "3 months" : m.day === 180 ? "6 months" : m.day === 365 ? "1 year" : `day ${m.day}`
        console.log("  " + label.padEnd(10) + fmt(m.total).padStart(14) + fmt(m.visible).padStart(12) + `${m.t1s}/${m.t2s}/${m.t3s}`.padStart(14))
    }
    console.log()

    const t3Rate = PARAMS.callsPerDay * PARAMS.newContentPerCall / PARAMS.t1Ratio / PARAMS.t2Ratio / PARAMS.t3Ratio
    console.log(`  T3 accumulation rate: ${fmt(t3Rate)}/day`)
    console.log(`  Context fills at:    day ${s.limitDay} (${(s.limitDay! / 365).toFixed(1)} years)`)
    console.log(`  Total at fill:       ${fmt(s.cumulativeAtLimit!)}`)
    console.log()
}

main()
