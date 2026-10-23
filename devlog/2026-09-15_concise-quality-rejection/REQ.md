# REQ - Concise quality-gate rejection message (stop re-injecting full compression rules)

- Task ID: `2026-09-15_concise-quality-rejection`
- Home Repo: `opencode-acp`
- Created: 2026-09-15
- Status: InProgress
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/396

## 1. Background & Problem Statement

- **Context**: When the pre-commit quality gate (`config.qualityGate`, default
  algorithm `rouge-recall-v1`) rejects a compression, `buildQualityRejectionError`
  (`lib/compress/quality-gate/rejection.ts`) throws an error whose message is
  returned to the model as the tool result. The message embeds the complete
  `HOW_TO_COMPRESS_RULES` constant (4,936 chars ≈ ~1,234 tokens) plus a long
  "⚠️ CRITICAL" warning paragraph.
- **Current behavior (symptom)**: Every rejected compression injects ~1.5K+
  tokens of new text into the conversation — exactly what compression exists to
  avoid. In long sessions (the issue reports ranges of ~400K tokens) this is a
  significant, repeated context cost. Worse, the content is redundant: the same
  `HOW_TO_COMPRESS_RULES` constant is already embedded in the ACP system prompt
  (`lib/prompts/system.ts:58`), which is sent with every request.
- **Secondary defect**: the rejection message does not include the gate's
  `reason` field (e.g. "Summary too short: …", "Content coverage too low: …"),
  even though the issue's expected behavior explicitly asks for the failure
  reason. It also contains a misleading sentence ("Without acknowledgeRisk:
  true, the compression will be rejected again") — a rewritten summary that
  passes the gate is accepted without the flag; the flag only bypasses after a
  prior rejection set `qualityGateRetryPending` (#301/#303 semantics).
- **Expected behavior** (per issue #396): keep the blocking gate itself, but make
  the failure payload concise and targeted: failure reason + key quality metrics
  + short retry guidance, without re-injecting the full compression instruction.

## 2. Reproduction (if applicable)

- **Environment**: any session with `qualityGate.enabled: true`; model called
  `compress` on a range whose summary fails L1 or L2.
- **Minimal reproduction steps**:
  1) Enable the quality gate, call `compress` with a summary that fails the
     length floor (L1-length) or content coverage (L2-content).
  2) Observe the tool error: header + metrics + CRITICAL paragraph + full
     `HOW_TO_COMPRESS_RULES` (~5K chars) + retry instructions.
- **Relevant configuration**: `qualityGate.enabled: true` (algorithm
  `rouge-recall-v1`).

## 3. Constraints & Non-Goals

- **Constraints**:
  - The E2E fake-LLM server detects rejections by scanning tool text for
    `"QUALITY GATE FAILURE"` / `"COMPRESSION REJECTED"`
    (`scripts/e2e/fake-llm-server.ts:222,503`) — one of these markers MUST stay
    in the message.
  - The `acknowledgeRisk` escape hatch MUST remain discoverable from the message
    (it is the only documented bypass path once `qualityGateRetryPending` is
    set), but its description must match actual behavior (#301/#303).
  - No change to the gate itself, its config, or the throw/bypass mechanics in
    `lib/compress/range.ts`.
- **Non-Goals** (explicitly out of scope):
  - Advisory mode / auto-bypass after N rejections (open design discussion in
    #339 — owner decision pending there).
  - Removing the `dangerous` parameter residue (tracked in #339).
  - Changing how nudges inject `HOW_TO_COMPRESS_RULES`
    (`lib/messages/inject/inject.ts:616,627`) — separate surface.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] Rejection message includes: rejection header (with "COMPRESSION
    REJECTED" marker), range, the gate `reason`, original tokens, summary chars,
    ratio, retention, gate layer, rougeF1, top20Recall.
  - [ ] Rejection message does NOT include `HOW_TO_COMPRESS_RULES` content
    (no "HOW TO COMPRESS" / "KEEP VERBATIM" text) and no multi-paragraph
    warning block.
  - [ ] Retry guidance states: rewrite a more complete summary and retry (gate
    re-evaluates automatically); full rules already live in the system prompt;
    `acknowledgeRisk: true` bypasses this rejection if the summary is believed
    correct despite the metrics.
  - [ ] Message length regression guard: total message < 1,000 chars for a
    standard rejection (was ~5.4K before).
- **Performance / Stability**:
  - [ ] No new allocations beyond string building; no behavior change to the
    gate evaluation path.
- **Regression**:
  - [ ] Updated tests in `tests/quality-gate-enforcement.test.ts`: existing
    assertions on header/range/tokens/chars still pass; the assertion that
    rules are present is inverted to assert absence; reason inclusion asserted;
    length guard added. Integration tests (rejection through the real tool,
    acknowledgeRisk bypass, #301 preemptive no-op) unchanged and green. Full
    suite green.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/compress/quality-gate/rejection.ts` — drop the `HOW_TO_COMPRESS_RULES`
    import/embedding and the CRITICAL paragraph; add `Reason:` line from
    `result.reason`; rewrite retry guidance into ≤3 sentences.
  - `tests/quality-gate-enforcement.test.ts` — update unit assertions per
    acceptance criteria.
- **Risks**: very low — message content only; single throw site
  (`lib/compress/range.ts:351`); E2E marker preserved.
- **Rollback strategy**: revert the commit; purely textual change, no state or
  API impact.
