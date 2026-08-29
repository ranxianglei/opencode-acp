# REQ — Deprecate `minContextLimit` (and `modelMinLimits`)

- **Task ID:** 2026-08-29_deprecate-min-context-limit
- **Date:** 2026-08-29
- **Priority:** P2
- **Status:** Done (pending review)

## Background

`compress.minContextLimit` (default `"80%"`) is the soft lower bound for turn/iteration reminder nudges: `overMinLimit` gates when those anchors are set/cleared. Since #343/#351, the growth-nudge floor (`minNudgeContextPercent`, cascade via `compress.providers`) is the maintained "minimum" mechanism — two parallel "min" knobs confuse users.

Maintainer direction (2026-08-29): mark `minContextLimit` as deprecated.

## Requirement

1. **Soft deprecation only** — annotations, no behavior change:
   - `@deprecated` JSDoc on `CompressConfig.minContextLimit` and `CompressConfig.modelMinLimits` (the flat per-model map only feeds `minContextLimit`; same fate).
   - `dcp.schema.json`: `[DEPRECATED — …]` description prefix (repo convention, cf. `allowSubAgents`).
   - `CONFIGURATION.md` / `CONFIGURATION.zh-CN.md`: Status → DEPRECATED, deprecation notes, legend reworded ("kept for backward compatibility, scheduled for removal (may still take effect until then)") — the old legend "accepted but no effect" is wrong for a soft deprecation.
2. Deprecation text must state the removal consequence: when removed, the lower-bound gating for turn/iteration reminder nudges is retired with it (those nudges depend on `overMinLimit`); the growth-nudge system (`minNudgeContextPercent` + `nudgeGrowthTokens`) is the maintained mechanism.
3. No runtime warnings, no validation rejection, no default changes, no removal in this PR.

## Non-goals

- Actually removing the field or changing nudge behavior.
- Deprecating `nudgeFrequency` / `iterationNudgeThreshold` (only meaningful to revisit at removal time).
- Touching `maxContextLimit` / `modelMaxLimits`.

## Acceptance criteria

- Annotations present in code + schema + both docs.
- `npm run typecheck` passes; full suite 1053/1053 unchanged (annotation-only change proves no behavior drift).
- CI green.

## References

- PR #351 (nested providers floor, stacked-under), PR #343 (growth floor gate)
- Deprecation precedents: `gc.algorithm`, `gc.maxBlockAge`, schema `allowSubAgents`
