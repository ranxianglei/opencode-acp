# REQ: Remove size-based recommendations from nudge

## Problem

ACP's nudge injection listed specific message ranges by size ("Largest tool
outputs: m00175 (20.7K)", "Largest code messages", "Largest text messages").
The model treated these lists as **directives** — compressing by size rather
than by need. This caused the "context leak" pattern: grow 5%, compress 2%
(the largest items), net +3%, eventually overflowing context.

Analysis of session `ses_0e1951573ffeWOaARblvet5U7s` proved the point: when
the user manually directed compression by work phase (ignoring ACP's
size-based recommendations), compression achieved 93–99% reduction across 6
blocks (147,975 → 4,121 tokens). The model already has per-message token
annotations (`<dcp-message-id tokens="2.1K" type="tool:bash">m00175</dcp-message-id>`)
— it does not need ACP to list ranges for it.

## Solution

1. **Remove** the "Largest tool outputs", "Largest code messages", and
   "Largest text messages" range listings from the nudge injection.
2. **Remove** the `topRanges` listing from the `toolOutputReminder`.
3. **Keep** the composition ratio breakdown (`tool 40% | summaries 10% |
   code 28% | text 22%`) and top-tools ratio — these are information, not
   directives.
4. **Replace** the old "Compress incrementally: target the ranges above..."
   text with new guidance:
   - Use `acp_status` or review context to identify consumed content
   - Prefer large continuous ranges by work phase, not small incremental steps
   - Convert verbose tool outputs into concise summaries
5. **Update** the system prompt's CONTEXT BREAKDOWN section to match.

## Files Changed

- `lib/messages/inject/inject.ts` — nudge injection (removed range listings,
  replaced guidance text, simplified toolOutputReminder)
- `lib/prompts/system.ts` — CONTEXT BREAKDOWN section (removed size-based
  directive, replaced with need-based guidance)
