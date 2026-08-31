import type { SessionState } from "../state"
import type { Logger } from "../logger"

/**
 * [FIX #347] Number of consecutive message-transforms with an unresolved
 * context window before we emit the one-time "uncalibrated window" WARN. Three
 * is enough to rule out the first-request race (system.transform sets the limit
 * AFTER messages.transform within one request) while still surfacing the
 * blindness quickly.
 */
export const UNCALIBRATED_WINDOW_WARN_THRESHOLD = 3

/**
 * [FIX #347] Track the uncalibrated-window condition and emit a one-time WARN.
 *
 * When the model reports no context window (`limit.context = 0`) the catalog
 * never records a limit and `state.modelContextLimit` stays undefined — so every
 * percentage threshold (min/max/emergency) resolves to undefined and only the
 * absolute growth nudge fires. That blindness is what lets a session silently
 * grow past the backend's real window and die on a provider 400 (#347).
 *
 * This helper counts consecutive transforms with an unresolved window and, once
 * the threshold is reached, logs a prominent one-time WARN pointing the user at
 * the fix (declare `limit` in opencode.json or set absolute
 * `compress.maxContextLimit`/`minContextLimit`). The request-side overflow guard
 * (`prune-to-fit.ts`) also needs a known window to fire, so this WARN covers
 * both blind spots.
 *
 * The counter resets to 0 as soon as a window resolves, so a session that later
 * switches to a model with a known window stops counting.
 */
export function trackUncalibratedWindow(state: SessionState, logger: Logger): void {
    if (state.modelContextLimit === undefined) {
        state.uncalibratedWindowTransforms++
        if (
            state.uncalibratedWindowTransforms >= UNCALIBRATED_WINDOW_WARN_THRESHOLD &&
            !state.uncalibratedWindowWarned
        ) {
            state.uncalibratedWindowWarned = true
            logger.warn(
                "Model reports no context window — ACP percentage thresholds are disabled",
                {
                    session: state.sessionId,
                    provider: state.modelProviderID,
                    model: state.modelID,
                    transforms: state.uncalibratedWindowTransforms,
                    hint: 'set the model\'s `limit` in opencode.json (e.g. {"context": 262144, "output": 16384}) or use absolute compress.maxContextLimit / compress.minContextLimit in acp.jsonc; the request-side overflow guard also needs a known window to fire',
                },
            )
        }
    } else {
        state.uncalibratedWindowTransforms = 0
    }
}
