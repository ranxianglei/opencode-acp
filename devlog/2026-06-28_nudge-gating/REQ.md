# REQ: Gate per-message nudge by context growth

## Problem

The per-message compression nudge (context usage guidance + compressed-block hint)
was injected into the suffix message **every single turn**. The model saw the
full guidance text (tiered advice, the "💡 compress tool outputs" hint) on every
assistant-facing message, even when context had not meaningfully changed.

This caused two issues:

1. **Attention dilution** — repeating identical guidance every turn trains the
   model to treat it as boilerplate and ignore it, undermining the nudge's
   purpose.
2. **Wasted tokens** — the verbose guidance string (tiered advice can be 300+ chars)
   is appended to the suffix message every turn, inflating token usage on every
   request without adding new information.

## Solution

Gate the per-message nudge so the full guidance only appears when the context has
**actually grown** since the last nudge, rather than unconditionally each turn.

Two complementary triggers (either fires a nudge):

- **Turn frequency**: at least `config.compress.nudgeFrequency` (default 5) turns
  have passed since the last full nudge.
- **Token growth**: context has grown by ≥ 3% of the model context limit since
  the last nudge.

When the nudge is **suppressed**, the suffix message still shows the lightweight
context-usage line (token count + percentage) but omits the verbose tiered
guidance and the compressed-block "compress tool outputs" hint. This keeps the
model informed about current usage without nagging it with action advice on
every turn.

The last nudge turn/token baseline is persisted across sessions so gating state
survives OpenCode restarts.

## Non-goals

- The anchored nudges (context-limit / turn / iteration anchors) are unaffected —
  they are already interval-gated by `addAnchor`.
- Threshold logic (`minContextLimit` / `maxContextLimit` percentages) is unchanged.
- The wording of all guidance text is unchanged.
