import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createInitialState, type CompressionState } from "acp-kernel"

// Persistence of the kernel CompressionState. Phase 1 writes to a NEW path
// (plugin/acp-kernel/{sessionId}.json) so the legacy plugin/acp/{sessionId}.json
// SessionState is never touched until the Phase-3 migration converter exists.
// Load is forward-compatible: missing top-level fields are merged from
// createInitialState() so an older on-disk state never starves the kernel.

const STATE_DIR = resolveStateDir()
const KERNEL_SUBDIR = "acp-kernel"
const LEGACY_SUBDIR = "acp"

function resolveStateDir(): string {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    return path.join(base, "opencode", "storage", "plugin")
}

function statePath(sessionId: string): string {
    return path.join(STATE_DIR, KERNEL_SUBDIR, `${sessionId}.json`)
}

function legacyStatePath(sessionId: string): string {
    return path.join(STATE_DIR, LEGACY_SUBDIR, `${sessionId}.json`)
}

export function mergeInitialState(parsed: Partial<CompressionState>): CompressionState {
    const fresh = createInitialState()
    return {
        blocks: parsed.blocks ?? fresh.blocks,
        messageRefs: parsed.messageRefs ?? fresh.messageRefs,
        nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
        stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
        nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
        nextRunId: parsed.nextRunId ?? fresh.nextRunId,
    }
}

export async function loadKernelState(sessionId: string): Promise<CompressionState> {
    const file = statePath(sessionId)
    try {
        const raw = await fs.readFile(file, "utf8")
        const parsed = JSON.parse(raw) as Partial<CompressionState>
        if (parsed && Array.isArray(parsed.blocks)) return mergeInitialState(parsed)
    } catch {
    }
    return createInitialState()
}

export async function saveKernelState(state: CompressionState, sessionId: string): Promise<void> {
    const file = statePath(sessionId)
    const dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    const tmp = path.join(dir, `.acp-kernel-tmp-${path.basename(file)}`)
    await fs.writeFile(tmp, JSON.stringify(state), "utf8")
    await fs.rename(tmp, file)
}

// Detect a legacy SessionState (plugin/acp/{sessionId}.json) so the Phase-3
// migration PR can convert it. Phase 1 only reports presence; it does NOT
// read or convert the legacy blocks.
export async function detectLegacyState(sessionId: string): Promise<boolean> {
    try {
        const raw = await fs.readFile(legacyStatePath(sessionId), "utf8")
        const parsed = JSON.parse(raw) as { prune?: { messages?: { blocksById?: unknown } } }
        return !!(parsed && parsed.prune && parsed.prune.messages && parsed.prune.messages.blocksById)
    } catch {
        return false
    }
}
