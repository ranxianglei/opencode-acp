# ACP Configuration Reference

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

Complete reference for all configurable parameters in Active Context Pruning (ACP).

## Config File Locations

ACP reads config from up to three layers (later layers override earlier):

| Layer | Path | Scope |
|-------|------|-------|
| **Global** | `~/.config/opencode/acp.jsonc` | All sessions |
| **Config dir** | `$OPENCODE_CONFIG_DIR/acp.jsonc` | All sessions in this config dir |
| **Project** | `.opencode/acp.jsonc` (searched upward from cwd) | Current project only |

> **Tip:** Add `"$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json"` for IDE autocompletion.

## Quick Start

```jsonc
// ~/.config/opencode/acp.jsonc
{
    "$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json",
    "enabled": true,
    "compress": {
        "maxContextLimit": "70%",
        "minContextLimit": "70%",
        "protectedTools": ["skill"]
    }
}
```

---

## Parameter Reference

Status legend: **ACTIVE** = currently used | **DEPRECATED** = kept for backward compatibility, scheduled for removal (may still take effect until then) | **EXPERIMENTAL** = may change

---

### General

#### `enabled`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Master switch. Set to `false` to completely disable ACP.

#### `autoUpdate`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Automatically check for and install ACP updates on startup, tracking the dist-tag/spec the plugin was installed with (`opencode-acp@stable` follows the `stable` tag; range specs like `^1.14.0` follow `latest`). Version-locked specs are never updated.

#### `debug`
- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Enable debug mode. When `true`, ACP sends a chat notification after each compression showing block details, and sets `logLevel` to `debug` (INFO/DEBUG logs plus per-request context snapshots at `~/.config/opencode/logs/acp/`). This flag overrides `logLevel` when set to `true`.

#### `logLevel`
- **Type:** `"debug" | "info" | "warn" | "error" | "silent"`
- **Default:** `"info"`
- **Status:** ACTIVE
- **Description:** File log verbosity for `~/.config/opencode/logs/acp/daily/<date>.log`. Default `info` writes decision-level events by default (nudge decisions, transform summaries, auto-update checks, model switches). `warn`/`error` reduce output; `silent` disables file logging entirely; `debug` additionally enables per-request context snapshots and verbose dumps. Ignored when `debug: true`.

#### `pruneNotification`
- **Type:** `"off" | "minimal" | "detailed"`
- **Default:** `"off"`
- **Status:** ACTIVE
- **Description:** Compression notification verbosity.
  - `"off"` — No notifications
  - `"minimal"` — Brief one-line summary
  - `"detailed"` — Full block details (topics, token counts, ranges)

#### `pruneNotificationType`
- **Type:** `"chat" | "toast"`
- **Default:** `"toast"`
- **Status:** ACTIVE
- **Description:** Delivery method for compression notifications.
  - `"toast"` — Transient toast popup (recommended; non-blocking)
  - `"chat"` — Inject as a chat message (may freeze session on providers that reject empty messages)

#### `protectedFilePatterns`
- **Type:** `string[]`
- **Default:** `[]`
- **Status:** ACTIVE
- **Description:** Glob patterns for files whose content should be protected from compression. When the model reads a file matching these patterns, the tool output is injected into compression summaries instead of being compressible. Example: `["**/*.env", "**/secrets.json"]`

---

### `commands`

Controls ACP slash commands (`/acp context`, `/acp stats`, etc.).

#### `commands.enabled`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Enable or disable all `/acp` slash commands.

#### `commands.protectedTools`
- **Type:** `string[]`
- **Default:** `["task", "skill", "todowrite", "todoread", "compress", "decompress", "batch", "plan_enter", "plan_exit", "write", "edit"]`
- **Status:** ACTIVE
- **Description:** Tool outputs from these tools are protected from compression. These tools' outputs survive intact in visible context. An explicit array **replaces** the default (use `[]` to protect nothing).

---

### `allowSubAgents`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Allow ACP to run in sub-agent sessions. When enabled, subagent sessions get full compression, nudge, and context-management capabilities. Set to `false` to restrict ACP to the main session only.
- **Migration:** Moved from `experimental.allowSubAgents` (default `false`) to top-level `allowSubAgents` (default `true`) in v1.14.13. The old `experimental.allowSubAgents` key is still read for backward compatibility — top-level takes priority.

---

### `experimental`

Experimental features that may change or be removed.

#### `experimental.customPrompts`
- **Type:** `boolean`
- **Default:** `false`
- **Status:** EXPERIMENTAL
- **Description:** Enable loading custom prompt overrides from `~/.config/opencode/acp-prompts/`.

---

### `compress`

Core compression behavior.

#### `compress.permission`
- **Type:** `"ask" | "allow" | "deny"`
- **Default:** `"allow"`
- **Status:** ACTIVE
- **Description:** Permission level for the `compress` tool.
  - `"allow"` — Auto-approve compression calls
  - `"ask"` — Prompt user before each compression
  - `"deny"` — Block all compression calls

#### `compress.showCompression`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Show compression status indicators in the chat UI.

#### `compress.summaryBuffer`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Inject summary buffer guidance into the system prompt, helping the model understand which blocks exist and their coverage.

#### `compress.maxContextLimit`
- **Type:** `number | \`${number}%\``
- **Default:** `"80%"`
- **Status:** ACTIVE
- **Description:** Upper context usage threshold (as % of model context window or absolute tokens). When exceeded, ACP nudges the model to compress. Example: `"80%"` or `100000`.

#### `compress.minContextLimit`
- **Type:** `number | \`${number}%\``
- **Default:** `"80%"`
- **Status:** DEPRECATED
- **Description:** **Deprecated — scheduled for removal.** Lower context usage threshold for turn/iteration reminder nudges. ACP stops injecting those reminders when usage drops below this level (or when the limit cannot be resolved to a concrete value, e.g. a `"X%"` limit with an unknown model context window). Growth nudges are governed separately by `minNudgeContextPercent`. Still honored until removed; when it is removed, the lower-bound gating for turn/iteration reminder nudges is retired along with it (new sessions should rely on the growth-nudge system).

#### `compress.modelMaxLimits`
- **Type:** `Record<string, number | \`${number}%\`>`
- **Default:** `undefined`
- **Status:** ACTIVE
- **Description:** Per-model override for `maxContextLimit`. Keyed by model ID. Example: `{"gpt-4": 80000, "claude-3-opus": "50%"}`

#### `compress.modelMinLimits`
- **Type:** `Record<string, number | \`${number}%\`>`
- **Default:** `undefined`
- **Status:** DEPRECATED
- **Description:** **Deprecated — scheduled for removal alongside `minContextLimit`.** Per-model override for `minContextLimit`. Still honored until removed.

#### `compress.nudgeFrequency`
- **Type:** `number`
- **Default:** `5`
- **Status:** ACTIVE
- **Description:** Minimum number of turns between nudge injections. Prevents nagging the model every turn.

#### `compress.minNudgeContextPercent`
- **Type:** `number`
- **Default:** `5`
- **Status:** ACTIVE
- **Description:** Floor for growth-triggered nudges, as a percentage of the model context window: a growth nudge requires context usage at or above this percentage (in addition to the growth threshold). Over-max (`maxContextLimit`) and the 98% emergency-override nudges bypass the floor. If the model context window is unknown, the floor is unresolvable and growth nudges fall back to growth-only behavior. Turn/iteration reminder nudges are governed by `minContextLimit`, not this field. The default is deliberately low: with the default `nudgeGrowthTokens` (50K), a 5% floor stays inert for typical working cycles and only binds on very large (≥2M-class) windows — a higher default (e.g. 15%) would bind on ≥400K windows and shift every compress cycle's working range upward on large-window models. Set `0` to disable the floor entirely, or raise it (e.g. 15–30%) to keep growth nudges waiting until a larger share of the window is in use. Can be narrowed per provider / per model via [`compress.providers`](#compressproviders) (issue #344).

#### `compress.providers`
- **Type:** `Record<string, ProviderOverrides>` where `ProviderOverrides = Partial<CompressOverridableConfig> & { models?: Record<string, Partial<CompressOverridableConfig>> }` (all fields optional at both levels)
- **Default:** `undefined`
- **Status:** ACTIVE
- **Description:** Nested per-provider / per-model overrides for **every tunable compress field**, resolved field-by-field with the cascade **model > provider > global** (mirrors the sibling project billion-context-pi, issue #344). Deeper levels only override when the field is explicitly set — unset fields never clear shallower values. `0` / `false` are explicit values, not "unset". Unknown provider/model ids fall back to the global value. Percentages and `"X%"` limits resolve against the active model's context window. Across the three config file layers (global → config dir → project) the maps deep-merge per provider/model key — a project layer can narrow one provider without wiping others configured in lower layers.
- **Overridable fields:** `maxContextLimit`, `emergencyThresholdPercent`, `minNudgeContextPercent`, `nudgeFrequency`, `iterationNudgeThreshold`, `toolOutputNudgeThreshold`, `nudgeGrowthTokens`, `minNudgeGrowthRatio`, `minNudgeGrowthFloor`, `nudgeForce`, `protectedTools`, `showCompression`, `summaryBuffer`, `protectTags`, `protectUserMessages`, `maxSummaryLengthHard`, `minCompressRange`, `maxVisibleSegments`, `keepEmbedMaxChars`, `lastSegmentSoftBlock`, `preserveRecentMessages`, `preserveRecentTokens`, `preserveLastUserMessage`.
- **Not overridable:** `permission` (session-level, fixed before model info is known), the deprecated `minContextLimit` / `modelMinLimits` family, the flat `modelMaxLimits` / `modelMinLimits` maps themselves, and `providers` itself. `modelMaxLimits` itself is **not** deprecated — it remains fully supported (only outranked). For `maxContextLimit` the precedence when set nested is **nested override > `modelMaxLimits` flat map > global**. `protectedTools` set here affects the compress tool and nudge-side logic; the system-prompt protected-tools listing (shown at prompt build time, before model info is available) always reflects the global value.

```jsonc
{
    "compress": {
        "maxContextLimit": "55%",
        "minNudgeContextPercent": 5,
        "nudgeGrowthTokens": 50000,
        "providers": {
            "anthropic": {
                "minNudgeContextPercent": 8,
                "nudgeForce": "strong",
                "models": {
                    "claude-sonnet-4-6": {
                        "minNudgeContextPercent": 30,
                        "maxContextLimit": "70%",
                        "nudgeGrowthTokens": 20000
                    }
                }
            }
        }
    }
}
```
In this example, for `anthropic/claude-sonnet-4-6`: the floor is 30%, the over-max band starts at 70% of the window instead of the global 55% (a larger working range before over-max nudges kick in), the growth threshold is 20K, and nudges use the `strong` tone (inherited from the provider level). Every other Anthropic model gets the 8% floor and `strong` tone but keeps the global band and 50K growth threshold; everything else uses the pure global values. Provider keys are provider ids and model keys are model ids (as reported by the active session, e.g. `anthropic`, `claude-sonnet-4-6`).

#### `compress.nudgeGrowthTokens`
- **Type:** `number`
- **Default:** `50000` (fixed)
- **Status:** ACTIVE
- **Description:** The nudge growth threshold. ACP nudges when context grows by this many tokens since the last nudge. The default is a fixed value, identical for all model context window sizes (was previously scaled as a percentage of the window — removed in v1.14.23 because it made small-window models nudge ~4× more often).

#### `compress.toolOutputNudgeThreshold`
- **Type:** `number`
- **Default:** `undefined`
- **Status:** ACTIVE
- **Description:** Token threshold for the tool-output-specific nudge. When tool outputs exceed this, a targeted nudge suggests compressing them.

#### `compress.iterationNudgeThreshold`
- **Type:** `number`
- **Default:** `15`
- **Status:** ACTIVE
- **Description:** Inject an iteration nudge when this many messages accumulate since the last user message (indicates long tool-use chains without user interaction).

#### `compress.nudgeForce`
- **Type:** `"strong" | "soft"`
- **Default:** `"soft"`
- **Status:** ACTIVE
- **Description:** Nudge tone.
  - `"soft"` — Informational, lets the model decide
  - `"strong"` — More urgent, emphasizes context overflow risk

#### `compress.protectedTools`
- **Type:** `string[]`
- **Default:** `["skill", "compress"]`
- **Status:** ACTIVE
- **Description:** Tool outputs from these tools are soft-filtered from compression ranges. Unlike `commands.protectedTools` (hard-protect), these are excluded from compressible ranges but their content may still be referenced in summaries. An explicit array **replaces** the default.

> **Note:** `"compress"` is force-appended to this list regardless of user config — compression tool calls must never be lost.

#### `compress.protectTags`
- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** When `true`, `<dcp-message-id>` tagged content is protected from compression.

#### `compress.protectUserMessages`
- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** When `true`, all user messages are protected from compression (not just the last one).

#### `compress.maxSummaryLengthHard`
- **Type:** `number`
- **Default:** `20000`
- **Status:** ACTIVE
- **Description:** Hard limit on summary length in characters. Compression calls with summaries exceeding this are rejected.

#### `compress.minCompressRange`
- **Type:** `number`
- **Default:** `5000`
- **Status:** ACTIVE
- **Description:** Minimum estimated tokens in a compression range. Ranges smaller than this are filtered out from recommendations (not worth compressing).

#### `compress.minNudgeGrowthRatio`
- **Type:** `number`
- **Default:** `0.45`
- **Status:** ACTIVE
- **Description:** Ratio of `nudgeGrowthTokens` used to calculate the nudge growth floor. Higher value = less frequent nudges.

#### `compress.minNudgeGrowthFloor`
- **Type:** `number`
- **Default:** `5000`
- **Status:** ACTIVE
- **Description:** Minimum nudge growth threshold in tokens. The actual threshold is `max(this, minNudgeGrowthRatio × nudgeGrowthTokens)`.

#### `compress.emergencyThresholdPercent`
- **Type:** `number | \`${number}%\``
- **Default:** `"98%"`
- **Status:** ACTIVE
- **Description:** Context usage threshold for "emergency" mode. When exceeded, ACP overrides all protection filters and forcefully nudges the model to compress immediately.

#### `compress.maxVisibleSegments`
- **Type:** `number`
- **Default:** `50`
- **Status:** ACTIVE
- **Description:** Maximum number of visible context segments to display in the system prompt's segment guidance.

#### `compress.keepEmbedMaxChars`
- **Type:** `number`
- **Default:** `2000`
- **Status:** ACTIVE
- **Description:** Maximum characters to embed per message when using `[[KEEP:mNNNNN]]` markers in compression summaries.

#### `compress.lastSegmentSoftBlock`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** When `true`, the last visible segment (most recent messages) is treated as a soft-block — excluded from compression recommendations but can be overridden with `dangerous: true`.

#### `compress.preserveRecentMessages`
- **Type:** `number`
- **Default:** `5`
- **Status:** ACTIVE
- **Description:** Number of most recent messages to protect from compression. These messages are soft-filtered from compressible ranges. Set to `0` to disable.

#### `compress.preserveRecentTokens`
- **Type:** `number`
- **Default:** `5000`
- **Status:** ACTIVE
- **Description:** Token budget for recent-message protection. In addition to the last N messages, ACP also protects messages within this token budget (expanding backward from the most recent message). Set to `0` to disable.

#### `compress.preserveLastUserMessage`
- **Type:** `boolean`
- **Default:** `true`
- **Status:** ACTIVE
- **Description:** Always protect the most recent user message from compression, regardless of `preserveRecentMessages` or `preserveRecentTokens`.

#### `compress.completionReserveTokens`
- **Type:** `number`
- **Default:** `32768`
- **Status:** ACTIVE
- **Description:** Tokens reserved for the model's completion by the context-budget guard. The guard estimates the request's input size and, if it exceeds `window - completionReserveTokens`, deterministically truncates (then clears) old compressible tool outputs until it fits — summaries, protected tools, the first user message, and the last 3 messages are never touched. The default `32768` covers opencode's `32000` `max_tokens` fallback for models with no declared `limit.output`. The guard is a no-op unless the model's context window is known (declared `limit.context` in opencode.json, or a catalog entry). An absolute (number) `compress.maxContextLimit` does **not** enable the guard — it is a soft nudge threshold, not the backend's real limit.

---

### `gc` (Generation & Cleanup)

> **Note:** The GC truncation module (`gc/truncate.ts`) was removed in v1.14.4. The remaining `gc` fields are used for block generation tracking and batch cleanup (block merging). Old config files with these fields continue to work.

#### `gc.algorithm`
- **Type:** `"truncate"`
- **Default:** `"truncate"`
- **Status:** DEPRECATED
- **Description:** Historically selected the GC algorithm. Only `"truncate"` was ever implemented. Now a no-op — kept for config compatibility.

#### `gc.promotionThreshold`
- **Type:** `number`
- **Default:** `5`
- **Status:** ACTIVE
- **Description:** Number of message-transform cycles a compression block must survive before being promoted from `"young"` to `"old"` generation. Old-gen blocks are eligible for batch merging by `gc/merge.ts`.

#### `gc.maxBlockAge`
- **Type:** `number`
- **Default:** `9007199254740991` (`Number.MAX_SAFE_INTEGER`)
- **Status:** DEPRECATED
- **Description:** Historically controlled age-based block deactivation. Set to infinity — effectively disabled. Kept for config compatibility.

#### `gc.maxOldGenSummaryLength`
- **Type:** `number`
- **Default:** `3000`
- **Status:** ACTIVE
- **Description:** Maximum length (in characters) for a merged summary when batch cleanup consolidates multiple old-gen blocks into a higher-tier block.

#### `gc.majorGcThresholdPercent`
- **Type:** `number | \`${number}%\``
- **Default:** `"100%"`
- **Status:** ACTIVE
- **Description:** Context usage threshold that triggers emergency tool output truncation. When context reaches this level, the largest tool outputs are truncated (keeping 2000-char prefix + suffix) to free space. Set to `"200%"` or higher to effectively disable. **Summaries are never truncated.**

#### `gc.batchCleanup`

Batch cleanup consolidates multiple old-gen blocks into higher-tier blocks.

##### `gc.batchCleanup.lowThreshold`
- **Type:** `number | \`${number}%\``
- **Default:** `"55%"`
- **Status:** ACTIVE
- **Description:** Context usage threshold for low-priority batch cleanup. At this level, batch cleanup considers merging old-gen blocks.

##### `gc.batchCleanup.highThreshold`
- **Type:** `number | \`${number}%\``
- **Default:** `"75%"`
- **Status:** ACTIVE
- **Description:** Medium-priority batch cleanup threshold.

##### `gc.batchCleanup.forceThreshold`
- **Type:** `number | \`${number}%\``
- **Default:** `"90%"`
- **Status:** ACTIVE
- **Description:** Force batch cleanup threshold. At this level, batch cleanup aggressively merges all eligible blocks.

---

### `qualityGate`

Post-compression quality evaluation. Runs after each compression to verify summary quality.

#### `qualityGate.enabled`
- **Type:** `boolean`
- **Default:** `false`
- **Status:** ACTIVE
- **Description:** Enable post-compression quality evaluation. When `true`, ACP evaluates each compression summary against quality metrics. Failures are logged but do not block compression (non-blocking).

#### `qualityGate.algorithm`
- **Type:** `string`
- **Default:** `"rouge-recall-v1"`
- **Status:** ACTIVE
- **Description:** Quality gate algorithm to use. Currently only `"rouge-recall-v1"` is available.

#### `qualityGate.algorithms`
- **Type:** `object`
- **Status:** ACTIVE
- **Description:** Algorithm-specific parameters. See below.

##### `qualityGate.algorithms.rouge-recall-v1`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `layer1MinChars` | number | 200 | Minimum summary length in characters |
| `layer1MinRetentionPct` | number | 5.0 | Minimum content retention percentage |
| `layer2MaxRougeF1` | number | 0.05 | Maximum ROUGE-1 F1 score for "too similar" detection |
| `layer2MaxTop20Recall` | number | 0.20 | Maximum top-20 keyword recall for quality check |

---

## Common Config Recipes

### Aggressive compression (maximize context savings)
```jsonc
{
    "compress": {
        "maxContextLimit": "45%",
        "minContextLimit": "35%",
        "preserveRecentMessages": 3,
        "preserveRecentTokens": 2000,
        "nudgeFrequency": 3
    }
}
```

### Conservative compression (minimize information loss)
```jsonc
{
    "compress": {
        "maxContextLimit": "70%",
        "minContextLimit": "60%",
        "preserveRecentMessages": 15,
        "preserveRecentTokens": 10000,
        "nudgeFrequency": 8,
        "protectedTools": ["skill", "bash", "read", "grep", "glob"]
    }
}
```

### Disable automatic compression entirely
```jsonc
{
}
```

### Per-model context limits
```jsonc
{
    "compress": {
        "modelMaxLimits": {
            "gpt-4o": 80000,
            "claude-3.5-sonnet": "60%",
            "gemini-1.5-pro": 150000
        },
        "modelMinLimits": {
            "gpt-4o": 60000,
            "claude-3.5-sonnet": "50%"
        }
    }
}
```

### Per-model growth-nudge floor (nested providers.models)
```jsonc
{
    "compress": {
        "minNudgeContextPercent": 5,
        "providers": {
            "anthropic": {
                "minNudgeContextPercent": 8,
                "models": {
                    "claude-sonnet-4-6": { "minNudgeContextPercent": 30 },
                    "claude-haiku-4-5": { "minNudgeContextPercent": 0 }
                }
            }
        }
    }
}
```
Floors resolve as model > provider > global (field-by-field). `0` disables the floor for that model — useful for small-window models where the growth threshold alone is the right signal.

### Per-model tuning of any compress field (nested providers.models)
The same cascade works for every tunable field, not just the floor — e.g. give one heavy model a tighter growth threshold and a lower over-max band while its siblings keep the global profile:
```jsonc
{
    "compress": {
        "providers": {
            "anthropic": {
                "models": {
                    "claude-sonnet-4-6": {
                        "nudgeGrowthTokens": 20000,
                        "maxContextLimit": "40%"
                    }
                }
            }
        }
    }
}
```
See the [`compress.providers`](#compressproviders) reference for the full overridable field list.

### Protect sensitive files
```jsonc
{
    "protectedFilePatterns": [
        "**/*.env",
        "**/*.pem",
        "**/*.key",
        "**/credentials.json",
        "**/secrets.*"
    ]
}
```

---

## Removed Parameters

These parameters existed in older versions and have been removed. Config files containing them will show a warning toast but continue to work.

| Parameter | Version Removed | Replacement |
|-----------|----------------|-------------|
| `strategies.deduplication.*` | PR #206 | Compression tool handles duplicates |
| `strategies.purgeErrors.*` | PR #206 | Compression tool handles error pruning |
| `compress.automaticStrategies` | PR #206 | Always-on; no config needed |
| `state.prune.tools` | PR #206 | Internal only; no config |

---

## Config Validation

ACP validates config on load. Unknown keys and type mismatches trigger a warning toast. Valid keys are defined in `lib/config-validation.ts` (`VALID_CONFIG_KEYS` set).
