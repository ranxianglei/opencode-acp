# REQ — v1.14.17: Eliminate compress retry dead-ends (#301)

## Background

Issue #301 reported a compress error loop with two hard errors that hit the
model on first use:

```
⚙ compress [acknowledgeRisk=true, dangerous=true]
content[0] needs a topic — provide content[0].topic or the top-level topic
⚙ compress [acknowledgeRisk=true, dangerous=true, topic=xxx]
Parameter "acknowledgeRisk": true was provided, but no quality gate rejection is pending.
```

Root causes:

1. The quality-gate rejection template teaches "add `acknowledgeRisk: true`
   to retry". Models generalize this into carrying the flag on EVERY retry —
   including retries after non-quality errors (e.g. argument validation
   failures like a missing topic). Validation errors never set
   `qualityGateRetryPending`, so the preemptive guard hard-failed the retry
   with "no rejection pending", producing a confusing dead-end loop.
2. `validateArgs` required every content entry to have its own `topic` or a
   top-level fallback, hard-failing otherwise.

## Requirement

Neither parameter may hard-fail on ordinary model usage:

- `acknowledgeRisk` without a pending quality-gate rejection becomes a no-op:
  quality checks still run; a successful result carries an
  `⚠️ acknowledgeRisk was ignored` note teaching correct usage. The gate's
  protection is unchanged — bypass is only armed by a real quality-gate
  rejection.
- Topics become fully optional: entry.topic → top-level topic → automatic
  fallback derived from the summary's first line (markdown headings stripped,
  capped at 80 chars), keeping `search_context` functional.

## Acceptance criteria

- Compress calls with missing topics succeed (topic auto-derived).
- Compress calls with preemptive `acknowledgeRisk` + good summary succeed with
  ignore note; with bad summary they are rejected by the QUALITY gate (not a
  parameter error) and the flag is armed for the retry.
- `buildPreemptiveAcknowledgeError` removed from `lib/compress/quality-gate`.
- typecheck + tests + build green.
