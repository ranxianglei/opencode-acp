#!/usr/bin/env bash
#
# DCP Token Cache Test Script
# Tests how Dynamic Context Pruning affects token caching across different providers/models
#
# Usage:
#   ./test-dcp-cache.sh [OPTIONS]
#
# Options:
#   --provider NAME    Run test for specific provider only
#   --dry-run          Show what would be executed without running
#   --results-dir DIR  Custom results directory (default: ./results)
#   --port PORT        Port for server (default: 4096, enables TUI attach)
#   --no-server        Don't start a server, use standalone mode (no TUI attach)
#   --help             Show this help message
#
# To watch tests in real-time:
#   Terminal 1: ./test-dcp-cache.sh --provider anthropic
#   Terminal 2: opencode attach http://localhost:4096
#

set -euo pipefail

# ============================================================================
# CONFIGURATION - Modify these to change which models are tested
# ============================================================================

# Models to test: one per provider
# Format: ["provider-name"]="provider/model-id"
declare -A MODELS=(
    ["opencode-kimi"]="opencode/kimi-k2.5-free"
    ["kimi"]="kimi-for-coding/k2p5"
    ["llm-proxy-cli-gemini"]="llm-proxy/cli_gemini-3-flash-high"
    ["llm-proxy-ant-gemini"]="llm-proxy/ant_gemini-3-flash-high"
    ["llm-proxy-opus"]="llm-proxy/claude-opus-4-5-thinking"
    ["openai"]="openai/gpt-5.2-codex"
    ["openrouter-haiku"]="openrouter/anthropic/claude-haiku-4.5"
)

# Codebases to analyze (ordered from simple to complex)
# Format: "clone_command|description"
CODEBASES=(
    "git clone --depth 1 https://github.com/sindresorhus/is-odd.git|is-odd: minimal npm package (~10 lines)"
    "git clone --depth 1 https://github.com/chalk/chalk.git|chalk: small terminal styling utility"
    "git clone --depth 1 https://github.com/tj/commander.js.git|commander: medium-complexity CLI framework"
    "git clone --depth 1 https://github.com/yargs/yargs.git|yargs: medium-complex argument parser"
    "cp -r ~/.config/opencode/opencode|opencode: full-featured coding assistant (local copy)"
)

# Base prompt template - {CODEBASE_CMD} and {CODEBASE_DESC} will be replaced
PROMPT_TEMPLATE='Clone/copy {CODEBASE_DESC} to /tmp/{CODEBASE_NAME} and give me a comprehensive summary of what it does and how it works. Analyze the directory structure, key files, main functionality, and architecture. Do not use subagents.'

# ============================================================================
# SCRIPT LOGIC - Generally no need to modify below
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="${SCRIPT_DIR}/../scripts"
RESULTS_DIR="${SCRIPT_DIR}/results"
DRY_RUN=false
SPECIFIC_PROVIDER=""
SERVER_PORT="4096"
USE_SERVER=true
SERVER_PID=""

cleanup() {
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        log "Stopping opencode server (PID: $SERVER_PID)..."
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

usage() {
    head -20 "$0" | tail -18 | sed 's/^# \?//'
    echo ""
    echo "Configured models:"
    for provider in "${!MODELS[@]}"; do
        echo "  $provider: ${MODELS[$provider]}"
    done
}

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

log_section() {
    echo ""
    echo "============================================================================"
    echo "$*"
    echo "============================================================================"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --provider)
            SPECIFIC_PROVIDER="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --results-dir)
            RESULTS_DIR="$2"
            shift 2
            ;;
        --port)
            SERVER_PORT="$2"
            shift 2
            ;;
        --no-server)
            USE_SERVER=false
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Create timestamp for this test run
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
RUN_DIR="${RESULTS_DIR}/${TIMESTAMP}"

# Validate specific provider if given
if [[ -n "$SPECIFIC_PROVIDER" ]] && [[ -z "${MODELS[$SPECIFIC_PROVIDER]:-}" ]]; then
    echo "Error: Unknown provider '$SPECIFIC_PROVIDER'"
    echo "Available providers: ${!MODELS[*]}"
    exit 1
fi

# Build list of providers to test
if [[ -n "$SPECIFIC_PROVIDER" ]]; then
    PROVIDERS=("$SPECIFIC_PROVIDER")
else
    PROVIDERS=("${!MODELS[@]}")
fi

log_section "DCP Token Cache Test"
log "Results directory: ${RUN_DIR}"
log "Providers to test: ${PROVIDERS[*]}"
log "Codebases: ${#CODEBASES[@]}"
log "Dry run: ${DRY_RUN}"

if [[ "$USE_SERVER" == "true" ]]; then
    log "Server port: ${SERVER_PORT}"
    log ""
    log ">>> To watch in real-time, run in another terminal:"
    log ">>>   opencode attach http://localhost:${SERVER_PORT}"
else
    log "Server mode: disabled (standalone runs, no TUI attach)"
fi

if [[ "$DRY_RUN" == "true" ]]; then
    log_section "DRY RUN - Commands that would be executed"
fi

# Create results directory
if [[ "$DRY_RUN" == "false" ]]; then
    mkdir -p "$RUN_DIR"
    # Save test configuration (simple approach without complex jq)
    {
        echo "{"
        echo "  \"timestamp\": \"${TIMESTAMP}\","
        echo "  \"providers\": [\"${PROVIDERS[*]// /\", \"}\"],"
        echo "  \"codebases\": ${#CODEBASES[@]},"
        echo "  \"server_port\": ${SERVER_PORT:-null}"
        echo "}"
    } > "${RUN_DIR}/config.json"
fi

# Start server if requested
if [[ "$DRY_RUN" == "false" ]] && [[ "$USE_SERVER" == "true" ]]; then
    log ""
    
    # Check if port is already in use
    if lsof -i ":${SERVER_PORT}" &>/dev/null; then
        log "Port ${SERVER_PORT} is already in use."
        read -p "Kill existing process and continue? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log "Killing process on port ${SERVER_PORT}..."
            fuser -k "${SERVER_PORT}/tcp" 2>/dev/null || lsof -ti ":${SERVER_PORT}" | xargs -r kill -9
            sleep 1
        else
            log "Aborting. Free port ${SERVER_PORT} or use --port to specify a different port."
            exit 1
        fi
    fi
    
    log "Starting opencode server on port ${SERVER_PORT}..."
    opencode serve --port "$SERVER_PORT" &
    SERVER_PID=$!
    
    # Wait for server to be ready
    sleep 2
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        log "Error: Server failed to start"
        exit 1
    fi
    log "Server started (PID: $SERVER_PID)"
fi

# Build base command depending on server mode
if [[ "$USE_SERVER" == "true" ]]; then
    BASE_CMD="opencode run --attach http://localhost:${SERVER_PORT}"
else
    BASE_CMD="opencode run"
fi

# Run tests for each provider
for provider in "${PROVIDERS[@]}"; do
    model="${MODELS[$provider]}"
    provider_dir="${RUN_DIR}/${provider}"
    
    log_section "Testing Provider: ${provider}"
    log "Model: ${model}"
    
    if [[ "$DRY_RUN" == "false" ]]; then
        mkdir -p "$provider_dir"
    fi
    
    SESSION_ID=""
    PROMPT_NUM=0
    
    for codebase_entry in "${CODEBASES[@]}"; do
        PROMPT_NUM=$((PROMPT_NUM + 1))
        
        # Parse codebase entry
        IFS='|' read -r clone_cmd codebase_desc <<< "$codebase_entry"
        codebase_name=$(echo "$clone_cmd" | grep -oE '[^/]+\.git$' | sed 's/\.git$//' || echo "$clone_cmd" | awk '{print $NF}')
        
        # Build the prompt
        prompt="${PROMPT_TEMPLATE}"
        prompt="${prompt//\{CODEBASE_CMD\}/$clone_cmd}"
        prompt="${prompt//\{CODEBASE_DESC\}/$codebase_desc}"
        prompt="${prompt//\{CODEBASE_NAME\}/$codebase_name}"
        
        log ""
        log "Prompt ${PROMPT_NUM}/${#CODEBASES[@]}: ${codebase_desc}"
        
        # Build opencode command (for display only, actual execution below)
        if [[ -z "$SESSION_ID" ]]; then
            # First prompt - create new session
            display_cmd="${BASE_CMD} -m '${model}' --title 'DCP Test: ${provider}' '<prompt>'"
        else
            # Subsequent prompts - continue session
            display_cmd="${BASE_CMD} -m '${model}' --session '${SESSION_ID}' '<prompt>'"
        fi
        
        if [[ "$DRY_RUN" == "true" ]]; then
            echo "  $ $display_cmd"
            # Simulate session ID for dry run
            if [[ -z "$SESSION_ID" ]]; then
                SESSION_ID="dry-run-session-id"
            fi
        else
            log "Executing: $display_cmd"
            
            # Run opencode and capture output
            output_file="${provider_dir}/prompt_${PROMPT_NUM}_output.txt"
            json_file="${provider_dir}/prompt_${PROMPT_NUM}_events.json"
            
            if [[ -z "$SESSION_ID" ]]; then
                # First run - use --format json to capture session ID from events
                log "Using JSON format to capture session ID..."
                if [[ "$USE_SERVER" == "true" ]]; then
                    opencode run --attach "http://localhost:${SERVER_PORT}" \
                        -m "${model}" \
                        --title "DCP Test: ${provider}" \
                        --format json \
                        "${prompt}" 2>&1 | tee "$json_file"
                else
                    opencode run \
                        -m "${model}" \
                        --title "DCP Test: ${provider}" \
                        --format json \
                        "${prompt}" 2>&1 | tee "$json_file"
                fi
                
                # Extract session ID from the first JSON event
                SESSION_ID=$(head -1 "$json_file" | jq -r '.sessionID // empty' 2>/dev/null || echo "")
                
                if [[ -z "$SESSION_ID" ]]; then
                    log "Warning: Could not extract session ID from JSON output"
                    # Fallback to opencode-find-session
                    log "Falling back to session search..."
                    SESSION_ID=$("${SCRIPTS_DIR}/opencode-find-session" "DCP Test: ${provider}" 2>/dev/null | head -1 || echo "")
                fi
                
                if [[ -z "$SESSION_ID" ]]; then
                    log "Error: Could not find session ID, cannot continue session"
                    log "Will create new sessions for each prompt (cache test will be less meaningful)"
                fi
                
                log "Session ID: ${SESSION_ID:-unknown}"
                echo "$SESSION_ID" > "${provider_dir}/session_id.txt"
            else
                # Subsequent prompts - continue session with normal output
                if [[ "$USE_SERVER" == "true" ]]; then
                    opencode run --attach "http://localhost:${SERVER_PORT}" \
                        -m "${model}" \
                        --session "${SESSION_ID}" \
                        "${prompt}" 2>&1 | tee "$output_file"
                else
                    opencode run \
                        -m "${model}" \
                        --session "${SESSION_ID}" \
                        "${prompt}" 2>&1 | tee "$output_file"
                fi
            fi
            
            log "Output saved to: ${output_file:-$json_file}"
        fi
    done
    
    # Collect analysis after all prompts for this provider
    if [[ "$DRY_RUN" == "false" ]] && [[ -n "$SESSION_ID" ]]; then
        log ""
        log "Collecting cache analysis for session ${SESSION_ID}..."
        
        # Session timeline
        "${SCRIPTS_DIR}/opencode-session-timeline" --session "$SESSION_ID" --no-color > "${provider_dir}/session_timeline.txt" 2>&1 || true
        "${SCRIPTS_DIR}/opencode-session-timeline" --session "$SESSION_ID" --json > "${provider_dir}/session_timeline.json" 2>&1 || true
        
        # Token stats
        "${SCRIPTS_DIR}/opencode-token-stats" --session "$SESSION_ID" > "${provider_dir}/token_stats.txt" 2>&1 || true
        "${SCRIPTS_DIR}/opencode-token-stats" --session "$SESSION_ID" --json > "${provider_dir}/token_stats.json" 2>&1 || true
        
        # DCP stats
        "${SCRIPTS_DIR}/opencode-dcp-stats" --session "$SESSION_ID" > "${provider_dir}/dcp_stats.txt" 2>&1 || true
        "${SCRIPTS_DIR}/opencode-dcp-stats" --session "$SESSION_ID" --json > "${provider_dir}/dcp_stats.json" 2>&1 || true
        
        log "Analysis saved to: ${provider_dir}/"
    elif [[ "$DRY_RUN" == "true" ]]; then
        echo ""
        echo "  # After session completes:"
        echo "  $ ${SCRIPTS_DIR}/opencode-session-timeline --session \$SESSION_ID > ${provider_dir}/session_timeline.txt"
        echo "  $ ${SCRIPTS_DIR}/opencode-token-stats --session \$SESSION_ID > ${provider_dir}/token_stats.txt"
        echo "  $ ${SCRIPTS_DIR}/opencode-dcp-stats --session \$SESSION_ID > ${provider_dir}/dcp_stats.txt"
    fi
done

log_section "Test Complete"
if [[ "$DRY_RUN" == "false" ]]; then
    log "Results saved to: ${RUN_DIR}"
    log ""
    log "To view results:"
    echo "  ls -la ${RUN_DIR}/"
    for provider in "${PROVIDERS[@]}"; do
        echo "  cat ${RUN_DIR}/${provider}/session_timeline.txt"
    done
else
    log "Dry run complete. Run without --dry-run to execute tests."
fi
