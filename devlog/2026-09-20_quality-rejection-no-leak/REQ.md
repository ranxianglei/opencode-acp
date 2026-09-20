# REQ - Quality-gate rejection: stop leaking internal details into model context

- Task ID: `2026-09-20_quality-rejection-no-leak`
- Home Repo: `opencode-acp`
- Created: 2026-09-20
- Status: InProgress
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/444

## 1. Background & Problem Statement

- **Context**: When the pre-commit quality gate rejects a compression,
  `buildQualityRejectionError` (`lib/compress/quality-gate/rejection.ts`) throws
  an error whose message is returned to the model as the tool result. The #397
  fix already removed the giant embedded `HOW_TO_COMPRESS_RULES` block, but the
  remaining message still leaks internal implementation detail that the model
  does not need in order to act.
- **Current behavior (symptom)** — three residual leaks (issue #444):
  1. `"Full compression rules are already in your system prompt."` — reveals an
     internal architecture fact (that a system prompt carries the full rules).
  2. `"...add \"acknowledgeRisk\": true to bypass the quality gate on your next
     compress call."` — frames `acknowledgeRisk` as an internal *bypass/backdoor*
     mechanism rather than a neutral, documented tool parameter.
  3. Algorithm-internal diagnostic lines — `Gate layer:`, `rougeF1:`,
     `top20Recall:` — plus threshold config carried inside `result.reason` by the
     external algorithm package (e.g. `(threshold: 200 chars OR 0.5% retention)`).
- **Impact**: every rejection injects these tokens into the live context of a
  session that is (by definition) already large. It is pure overhead with no
  actionable value for the model, and it exposes internals that should stay in
  the ACP debug log.
- **Expected behavior** (per issue #444): keep the blocking gate; on failure the
  model should learn (a) why it failed and (b) how to retry, concisely. No system
  prompt / internal-rules references, no "bypass" framing, no algorithm metrics or
  threshold config. Detailed diagnostics belong in the ACP log, not the model
  context.

## 2. Reproduction (if applicable)

- **Environment**: any session with `qualityGate.enabled: true`; model calls
  `compress` with a summary that fails L1/L2 (issue report: range m00006–m00010,
  ~36234 tokens → 670-char summary, L1-length, retention 0.46%).
- **Minimal reproduction steps**:
  1) Enable the quality gate, call `compress` with a too-short summary.
  2) Read the tool error: it contains the system-prompt sentence, the "bypass"
     framing, and the Gate layer / rougeF1 / top20Recall lines.

## 3. Constraints & Non-Goals

- **Constraints**:
  - E2E fake-LLM detection markers `"COMPRESSION REJECTED"` and
    `"QUALITY GATE FAILURE"` MUST remain in the message header
    (`scripts/e2e/fake-llm-server.ts`).
  - The message MUST still contain: the range, the core failure reason
    ("Summary too short" / "Content coverage too low"), original token count,
    summary char count, a `Retry:` directive, and the `acknowledgeRisk` escape
    hatch (neutral wording). Existing unit assertions depend on these substrings.
  - Message length regression guard `< 1000` chars must hold (and improve).
  - No change to the gate evaluation itself, its config schema, or the
    throw/bypass mechanics in `lib/compress/range.ts`.
- **Non-Goals** (out of scope):
  - Advisory mode / auto-bypass after N rejections (#339, owner decision pending).
  - Removing `dangerous` parameter residue (#339).
  - Changing the external `context-compress-algorithms` package's own `reason`
    string format — we sanitize at display time instead.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] Rejection message includes: header (with both detection markers), range,
    core reason, original token count, summary char count, retention, `Retry:`
    directive, and neutral `acknowledgeRisk` mention.
  - [ ] Rejection message does NOT include: `"system prompt"`, `"bypass"`,
    `"Gate layer"`, `"rougeF1"`, `"top20Recall"`, or any `(threshold: …)` text.
  - [ ] Core reason strips the algorithm's trailing threshold/config detail
    (`"Summary too short: …(threshold: …)"` → `"Summary too short"`).
  - [ ] Full diagnostics (full reason incl. thresholds, gate layer, rougeF1,
    top20Recall, ratio) are written to the ACP logger when one is supplied.
  - [ ] Message length stays < 1000 chars (and is shorter than before the fix).
- **Regression**:
  - [ ] Existing assertions in `tests/quality-gate-enforcement.test.ts`
    (header/range/reason/tokens/chars/Retry/acknowledgeRisk, absence of HOW TO
    COMPRESS / KEEP VERBATIM / CRITICAL, length guard) still pass.
  - [ ] Integration tests (rejection through real tool, acknowledgeRisk bypass,
    #301 preemptive no-op) unchanged and green. Full suite green.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/compress/quality-gate/rejection.ts` — add `coreReason()` sanitizer; drop
    Gate layer / rougeF1 / top20Recall lines from the model-facing message;
    rewrite retry paragraph (remove system-prompt sentence + "bypass" framing);
    add optional logger param that emits full diagnostics via `warn`.
  - `lib/compress/range.ts` — pass `ctx.logger` into `buildQualityRejectionError`.
  - `tests/quality-gate-enforcement.test.ts` — add no-leak + debug-log-path
    assertions.
- **Risks**: very low — message content + one call-site arg; single throw site;
  E2E markers preserved; logger param is optional so other callers are unaffected.
- **Rollback strategy**: revert the commit; purely textual/log change, no state or
  API impact.
