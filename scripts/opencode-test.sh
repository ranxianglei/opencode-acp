#!/usr/bin/env bash
#
# opencode-test launcher (repo copy). test-profile.sh --seed copies this to
# ~/.local/bin/opencode-test. Kept in the repo so the test setup is reproducible.

set -euo pipefail

ROOT="${OPENCODE_TEST_ROOT:-$HOME/.opencode-test}"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_DATA_HOME="$ROOT/data"
export XDG_CACHE_HOME="$ROOT/cache"
export XDG_STATE_HOME="$ROOT/state"
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
export OPENCODE_DB="$ROOT/data/opencode/opencode-test.db"

mkdir -p "$XDG_CONFIG_HOME/opencode" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
export OPENCODE_CALLER="${OPENCODE_CALLER:-opencode-test}"

exec "/home/dog/.local/bin/opencode" "$@"
