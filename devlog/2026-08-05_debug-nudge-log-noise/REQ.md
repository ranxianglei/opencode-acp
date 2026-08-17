# REQ — Debug Nudge Log Noise Fix

## Problem

When `config.debug: true`, the recommendation filter `logger.debug` fired on EVERY message transform hook call — even when no nudge was being injected. In normal sessions with compressible ranges (almost always), this produced a log entry per message. The user saw constant `[ACP Debug] Recommendation filter:` entries in the debug log and toast notifications, even when there was nothing meaningful to compress.

## Fix

Moved the recommendation filter `logger.debug` from its per-turn position (before the `shouldInject` decision) to inside the `shouldInject` block (after the nudge decision is finalized). The log now only fires when a nudge is actually being injected — i.e., when there is real compression to recommend.
