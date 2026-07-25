import { createSessionState, type SessionState } from "../lib/state"

// Test helper: builds a SessionStateRegistry stub that resolves any sessionID
// to a single state. Compress-tool unit tests operate on one state per test, so
// this matches the registry.get() surface that resolveToolContext calls.
export function singletonRegistry(state: SessionState): {
    get: (sessionId: string) => SessionState | undefined
    all: () => SessionState[]
    size: number
    compressionTiming: SessionState["compressionTiming"]
} {
    return {
        get: () => state,
        all: () => [state],
        get size() {
            return 1
        },
        compressionTiming: state.compressionTiming,
    }
}

// Test helper: Map-backed registry for hook-handler tests. getOrCreate()
// returns the seeded state for its session and lazily creates fresh states
// for other sessionIDs (e.g. session-switch tests).
export function createTestRegistry(seedState: SessionState) {
    const states = new Map<string, SessionState>()
    if (seedState.sessionId) {
        states.set(seedState.sessionId, seedState)
    }
    const sharedTiming = seedState.compressionTiming
    return {
        compressionTiming: sharedTiming,
        get size() {
            return states.size
        },
        get(sid: string) {
            return states.get(sid)
        },
        async getOrCreate(
            _client: unknown,
            sid: string,
        ): Promise<SessionState> {
            let s = states.get(sid)
            if (!s) {
                s = createSessionState()
                s.sessionId = sid
                s.compressionTiming = sharedTiming
                states.set(sid, s)
            }
            return s
        },
        all() {
            return [...states.values()]
        },
    }
}
