# WORKLOG: Promote allowSubAgents to Top-Level + Default True

## Implementation

### Code Changes

1. **`lib/config.ts`**:
   - Removed `allowSubAgents` from `ExperimentalConfig` interface
   - Added `allowSubAgents: boolean` to top-level `PluginConfig`
   - Default: `true` (was `experimental.allowSubAgents: false`)
   - `mergeLayer`: reads `data.allowSubAgents ?? data.experimental?.allowSubAgents ?? config.allowSubAgents` (backward compat)
   - `mergeExperimental`: removed `allowSubAgents` from merge

2. **`lib/config-validation.ts`**:
   - Added `"allowSubAgents"` to top-level VALID_CONFIG_KEYS
   - Kept `"experimental.allowSubAgents"` for backward compat (no false warnings)

3. **`lib/hooks.ts`** (3 sites):
   - Line 89: `!config.allowSubAgents` (system prompt hook, subagent guard)
   - Line 110: `config.allowSubAgents` (subagent mode prompt text)
   - Line 166: `!config.allowSubAgents` (message transform hook, subagent guard)

4. **`index.ts`** (1 site):
   - Line 111: `!config.allowSubAgents` (primary_tools restriction when subagents disallowed)

5. **`dcp.schema.json`**:
   - Added top-level `allowSubAgents` (boolean, default `true`)
   - Marked `experimental.allowSubAgents` as DEPRECATED (kept for backward compat)
   - Removed `allowSubAgents` from `experimental.default`

### Documentation Changes

- `README.md`: Updated default config block
- `README.zh-CN.md`: Updated default config block
- `CONFIGURATION.md`: Moved `allowSubAgents` from experimental section to main section
- `CONFIGURATION.zh-CN.md`: Same
- `AGENTS.md` §2.4: Updated default config example

### Backward Compatibility

Old configs work without changes:
- `{ "experimental": { "allowSubAgents": true } }` → mergeLayer reads `data.experimental?.allowSubAgents` → works
- `{ "experimental": { "allowSubAgents": false } }` → same, disables subagents
- No config: defaults to `true` (behavior change — was `false`)

### Verification

- Typecheck: PASS
- Tests: 954/954 PASS
