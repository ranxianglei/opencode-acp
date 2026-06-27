# REQ: README v3 — two-point focus (saves tokens + long sessions)

- Task ID: `2026-06-27_readme-v3`
- Home Repo: `opencode-acp`
- Created: 2026-06-27
- Status: Done
- Priority: P2
- Owner: awork (glm-5.2)
- References: dog/opencode-acp#3 (user v3 feedback on README v2)

## Background

User feedback on the v2 README (PR #19) asked for a sharper focus:

1. **"Proven at scale"** should keep *only* the two sessions (drop the 1,445-session
   aggregate), use the **full p50/p75/p90/p95/p99/peak distribution table** (more
   telling than peak alone), and add **message total count** + the 100,000-message
   support note.
2. **"Why ACP"** should emphasize just **two points**: (a) 省 token — with hard
   numbers; (b) supports very long sessions without losing key content.
3. The block-lifecycle bullet should be reframed as the model doing **CRUD over
   context** (which stays / which goes), **without** emphasizing GC (GC is being
   phased out).
4. Remove the other feature bullets (pressure-aware GC, two modes, protected
   content, strategies, production config) from the headline.

## Verified data

- **100K message cap**: `MESSAGE_REF_MAX_INDEX = 99999` in `lib/message-ids.ts`.
- **Compression savings** (from ACP state files): Session 1 summaries = 2.1% of
  original (97.9% reduction, 2.57M reclaimed / 99 blocks); Session 2 = 6.1%
  (93.9% reduction, 1.79M / 182 blocks).
- **Message counts**: Session 1 = 3,024 msgs; Session 2 = 2,028 msgs.

## Acceptance

- [x] "Proven at scale": only Session 1/2, full distribution table, message count
  column, 100K support note. Global aggregate dropped.
- [x] "Why ACP": two H3 points — (1) saves tokens (2–6% summary size, p95 ~30%,
  reclaimed numbers), (2) long sessions + model CRUD over context (no GC framing).
- [x] Removed: pressure-aware GC, two modes, protected content, strategies,
  production-config bullets.
- [x] EN + ZH consistent.
