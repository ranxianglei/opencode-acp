/**
 * Test-process env isolation — import this BEFORE any module-scope `new Logger(...)`.
 *
 * Since PR #311 the Logger appends WARN/ERROR lines to
 * `<XDG_CONFIG_HOME | ~/.config>/opencode/logs/acp/daily/<date>.log` even when
 * debug is disabled. Without this redirect, every test file that constructs a
 * real Logger and exercises a warn/error path would write into the developer's
 * real config home; persisted state files (XDG_DATA_HOME) leak the same way.
 *
 * Files that manage their own XDG_* env (logger.test.ts, prompts.test.ts,
 * e2e-*) do not import this module.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "acp-test-config-"))
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "acp-test-data-"))
