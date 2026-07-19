# REQ: Update README Context Statistics

## Summary

Update the "Why ACP" and "Proven at scale" sections in README.md and README.zh-CN.md with real data from 6 active engineering sessions. The old data was from pre-improvement sessions and understated ACP's current capabilities.

## Motivation

Old README claimed:
- "200K–300K token range" (too pessimistic — actual p90=150K, p95=180K)
- "p95 around 30%" (actually 15-21%)
- "500M cumulative" (from older sessions; current max 339M due to better compression)
- 2-session table with stale data

New data from `acp-inspect --stats` across 6 active sessions shows ACP performs significantly better than the old README described.

## Changes

### README.md
- **"Why ACP" section**: Bullet 1 changed from "saves two-thirds / 200K-300K range" to "200K is enough / 97% under 200K / p90 150K, p95 180K" with cost rationale (re-billing per call). Bullet 2 changed from "500M / 100K messages" to "observed 3,300+ messages, 300M+ cumulative; architecturally 100K messages".
- **"Proven at scale" section**: Headline updated to "p90 150-190K (15-19%), p95 160-210K (16-21%), cache hit 91%". Table replaced with 6 sessions showing Duration, Messages, API calls, Cumulative, Cache hit, p50, p90, p95. Outlier (bug-testing session) noted with dagger footnote.

### README.zh-CN.md
- Same changes, Chinese translation.

## Data Source

- 6 most active sessions (918–2,796 API calls each)
- `acp-inspect --stats` for API-level usage data (messages, cumulative tokens, cache hit rate, context percentiles, session duration)
- Sessions span 37h–865h (1.5–36 days)

## Acceptance Criteria

- [x] README.md "Why ACP" updated
- [x] README.md "Proven at scale" table updated with 6 sessions
- [x] README.zh-CN.md corresponding sections updated
- [x] Outlier session annotated
- [x] Session duration included in table
