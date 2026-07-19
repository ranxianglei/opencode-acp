# WORKLOG: Update README Context Statistics

## Data Collection

Ran `acp-inspect --stats` on 6 most active sessions to get:
- Message count, API call count, session duration
- Cumulative tokens processed, cache hit rate
- Context percentiles (p50, p75, p90, p95, p99, peak)

## Changes

### `README.md`
- Lines 29-34 ("Why ACP" bullets): Replaced "saves two-thirds" with "200K is enough" narrative + cost rationale. Replaced "500M / 100K messages" with observed values + design limit note.
- Lines 38-59 ("Proven at scale" section): New headline with actual p90/p95/cache numbers. New 6-session table with Duration, Messages, API calls, Cumulative, Cache hit, p50, p90, p95. Outlier dagger footnote for bug-testing session.

### `README.zh-CN.md`
- Lines 29-30 ("为什么选择 ACP" bullets): Chinese translation of EN changes.
- Lines 38-52 ("实战验证" section): Chinese translation of EN changes.

### `devlog/2026-07-19_readme-context-data/`
- REQ.md + WORKLOG.md

## Verification

- Format check passed
- Markdown tables render correctly
