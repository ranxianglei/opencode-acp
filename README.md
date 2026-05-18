<p align="center">
<strong>Active Context Pruning</strong> for <a href="https://opencode.ai">OpenCode</a>
<br />
The model decides <em>when</em> and <em>what</em> to compress — not a hard limit.
</p>

---

<p align="center">
<a href="https://www.npmjs.com/package/opencode-acp"><img src="https://img.shields.io/npm/v/opencode-acp.svg?style=flat-square" alt="npm"></a>
<a href="https://github.com/ranxianglei/opencode-acp/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/opencode-acp.svg?style=flat-square" alt="license"></a>
<a href="https://github.com/ranxianglei/opencode-acp"><img src="https://img.shields.io/badge/GitHub-ranxianglei%2Fopencode--acp-181717?style=flat-square&logo=github" alt="GitHub"></a>
</p>

<p align="center">
<code>opencode plugin opencode-acp@latest --global</code>
</p>

---

## Why ACP

ACP is a hardened fork of [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning) with **35 bug fixes** applied. It turns context management from a passive, crash-prone mechanism into something stable enough for production use.

| | DCP (original) | ACP (this fork) |
|---|---|---|
| **Max stable session** | ~200 messages | 10,000+ messages |
| **Per-turn overhead** | 20 -- 50 seconds | ~90ms |
| **State persistence** | Lost on restart | Survives restart |
| **GC effectiveness** | Never deactivates old blocks | Age-based auto-cleanup |
| **Compress reliability** | Fails on edge cases, model gives up | Auto-recovers reversed boundaries |

> **Active** means the model proactively decides *when* and *what* to compress -- as opposed to passive approaches that only react when context hits a hard limit. The model uses the `compress` tool to produce high-fidelity summaries of completed conversation segments, preserving important details while freeing context space. This is superior to passive truncation because the model controls what information to keep.

Key fixes include: state persistence across restarts, token usage reporting (was returning 0), summary message ID resolution, GC age-based deactivation, 268x logger/tokenizer speedup, auto-swap for reversed compress boundaries, and aging warning suppression at low context usage.

---

## Installation

```bash
opencode plugin opencode-acp@latest --global
```

Or add to your opencode config:

```json
{
  "plugin": {
    "opencode-acp": "latest"
  }
}
```

---

## How It Works

ACP reduces context size through a compress tool and automatic cleanup. Your session history is never modified -- ACP replaces pruned content with placeholders before sending requests to your LLM.

### Compress

Compress is a tool exposed to your model that replaces closed, stale conversation content with high-fidelity technical summaries. You can think of this as a much smarter version of Opencode's compaction process. Instead of triggering statically when your session reaches its maximum context and on the entire coding session, Compress allows the model to pick when to activate based on task completion, and to only compress the specific messages that are no longer needed verbatim.

ACP supports two compression modes:

- **`range` mode** compresses contiguous spans of conversation into one or more summaries.
- **`message` mode** (experimental) compresses individual raw messages independently, letting the model manage context much more surgically.

In `range` mode, when a new compression overlaps an earlier one, the earlier summary is nested inside the new one so information is preserved through layers of compression rather than diluted away. In both modes, protected tool outputs (such as subagents and skills) and protected file patterns are kept in compression summaries, ensuring that the most important information is never lost. You can also enable `protectUserMessages` to preserve your messages verbatim during compression, though note that large prompts (e.g. copy-pasting log files in the prompt) will then never be compressed away.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns (default: 4). Error messages are preserved; only the potentially large input content is removed. Recalculated on compress tool use.

---

## Commands

ACP provides an `/acp` slash command (also accepts `/dcp` for backward compatibility):

| Command | Description |
|---------|-------------|
| `/acp` | Shows available ACP commands |
| `/acp context` | Token usage breakdown by category (system, user, assistant, tools, etc.) and how much has been saved through pruning |
| `/acp stats` | Cumulative pruning statistics across all sessions |
| `/acp sweep [n]` | Prunes all tools since the last user message. Optional count: `/acp sweep 10` prunes the last 10 tools. Respects `commands.protectedTools` |
| `/acp manual [on\|off]` | Toggle manual mode. When on, the AI will not autonomously use context management tools |
| `/acp compress [focus]` | Trigger a single compress tool execution. Optional focus text directs what content to compress, following the active `compress.mode` |
| `/acp decompress <n>` | Restore a specific active compression by ID. Running without an argument shows available compression IDs, token sizes, and topics |
| `/acp recompress <n>` | Re-apply a user-decompressed compression by ID. Running without an argument shows recompressible IDs, token sizes, and topics |

---

## Configuration

ACP uses its own config file, searched in order:

1. **Global:** `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
2. **Custom config directory:** `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
3. **Project:** `.opencode/dcp.jsonc` (or `dcp.json`) in your project's `.opencode` directory

> **Note:** The config file name `dcp.jsonc` is kept for backward compatibility with DCP installations.

Each level overrides the previous, so project settings take priority over global. Restart OpenCode after making config changes.

> [!NOTE]
> If you use models with smaller context windows, such as GitHub Copilot models or local models, lower `compress.minContextLimit` and `compress.maxContextLimit` in your configuration to match the available context.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Automatically update npm-installed ACP when a newer npm latest is available.
    // Version-locked plugin specs are not updated.
    "autoUpdate": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /acp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /acp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow ACP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Compression mode: "range" (compress spans into block summaries)
        // or experimental "message" (compress individual raw messages)
        "mode": "range",
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Let active summary tokens extend the effective maxContextLimit
        "summaryBuffer": true,
        // Soft upper threshold: above this, ACP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": 100000,
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": 50000,
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "openai/gpt-5.3-codex": 120000,
        //     "anthropic/claude-sonnet-4.6": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "openai/gpt-5.3-codex": 50000,
        //     "anthropic/claude-sonnet-4.6": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
        // Preserve text wrapped in <protect>...</protect> when compressed
        "protectTags": false,
        // Preserve your messages during compression.
        // Warning: large copy-pasted prompts will never be compressed away
        "protectUserMessages": false,
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

### Prompt Overrides

ACP exposes six editable prompts:

- `system`
- `compress-range`
- `compress-message`
- `context-limit-nudge`
- `turn-nudge`
- `iteration-nudge`

This feature is disabled by default. Set `experimental.customPrompts` to `true` in your ACP config to activate it.

When enabled, managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/` as plain-text prompt files. A single `README.md` in that directory explains each prompt and how to create overrides.

To customize behavior, add a file with the same name under an overrides directory and edit it as plain text.

To reset an override, delete the matching file from your overrides directory.

### Protected Tools

By default, these tools are always protected from pruning:
`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`, `write`, `edit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list.

For the `compress` tool, `compress.protectedTools` ensures specific tool outputs are appended to the compressed summary. By default it includes `task`, `skill`, `todowrite`, and `todoread`.

---

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When ACP prunes content, it changes messages, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache reads but gain token savings from reduced context size and fewer hallucinations from stale context. In most cases, especially in long sessions, the savings outweigh the cache miss cost.

> [!NOTE]
> In testing, cache hit rates were approximately 85% with ACP vs 90% without.

**No impact for:**

- **Request-based billing** -- Providers like GitHub Copilot that charge per request, not tokens.
- **Uniform token pricing** -- Providers like Cerebras that bill cached and uncached tokens at the same rate.

---

## Migrating from DCP

ACP is a drop-in replacement for DCP. To migrate:

1. Remove the old DCP plugin from your `opencode.json`
2. Install ACP: `opencode plugin install opencode-acp@latest --global`
3. Restart OpenCode

**What's preserved:**

- Session state (compression blocks, message ID mappings) -- auto-migrated from `plugin/dcp/` to `~/.local/share/opencode/storage/plugin/acp/`
- Config file `~/.config/opencode/dcp.jsonc` -- ACP reads the same config
- Prompt overrides in `~/.config/opencode/dcp-prompts/`

**What changes:**

- Storage directory: `plugin/dcp/` to `plugin/acp/` (auto-migrated on first launch)
- Log directory: `logs/dcp/` to `logs/acp/`
- Slash command: `/dcp` to `/acp` (both work for backward compatibility)
- Notification headers: `DCP` to `ACP`
- Context usage label: `DCP threshold` to `ACP threshold`

Config file names (`dcp.jsonc`, `dcp-prompts/`) keep the `dcp` naming for backward compatibility.

---

<details>
<summary><strong>Bug Fixes (35 total)</strong> -- applied on top of DCP v3.1.11</summary>

| # | Severity | Summary |
|---|----------|---------|
| 1 | CRITICAL | State not persisted across restarts -- messageIds, block deactivation, save errors silently lost |
| 2 | CRITICAL | resetOnCompaction() clears all compression blocks -- undoes all pruning work |
| 3 | CRITICAL | prune silently drops summary -- DATA LOSS when no user message precedes anchor |
| 4 | CRITICAL | getCurrentTokenUsage returns 0 -- prevents nudge from ever triggering |
| 5 | HIGH | loadPruneMessagesState duplicates activeBlockIds + reasoning-strip undefined guard |
| 6 | HIGH | Synthetic summary messages get mNNNN refs but are invisible to boundary lookup |
| 7 | HIGH | State not persisted across restarts -- messageIds, block deactivation, and save errors silently lost |
| 8 | HIGH | isMessageCompacted() inconsistent with compaction summary message handling |
| 9 | HIGH | Compressed block summaries retain stale mNNNN message ID tags -- model copies stale IDs |
| 10 | HIGH | Model uses stale mNNNN IDs from nudges/summaries -- compress fails with "startId not available" |
| 11 | HIGH | Major GC skips legacy blocks without generation field -- oversized blocks never collected |
| 12 | HIGH | Percentage-based thresholds calculated against effective input context instead of full model context window |
| 13 | HIGH | Context window leaks -- compressed messages reappear after /compact |
| 14 | HIGH | Compression notifications write full block summaries to DB -- can reach 150KB+ per notification |
| 15 | HIGH | npm auto-install overwrites fork with upstream package |
| 16 | HIGH | Summary mNNNN refs in compress output -- model copies stale message IDs |
| 17 | HIGH | Synthetic messages not in messageIdToBlockId -- compress fails to find them |
| 18 | HIGH | Compress stops model from responding after compression completes |
| 19 | HIGH | Dynamic block guidance breaks API prefix cache |
| 20 | HIGH | GC never deactivates old blocks -- dead-weight accumulates indefinitely |
| 21 | HIGH | Logger + tokenizer 20-50s per-turn latency (268x slowdown) |
| 22 | HIGH | compress throws hard error on reversed block boundaries -- model gives up |
| 23--34 | MEDIUM | Various fixes for dedup, purge errors, schema validation, hook timing, etc. |
| 35 | HIGH | Aging warnings shown at low context usage (<50%) -- triggers unnecessary compress, wastes tokens |

For the complete list with root cause analysis, see the [bug tracker](https://github.com/ranxianglei/opencode-acp/issues).

</details>

---

## License

AGPL-3.0-or-later -- This project is a fork of [@tarquinen/opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning). Original copyright belongs to the original author. Modifications and bug fixes by ranxianglei.
