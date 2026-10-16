/**
 * [Issue #489] Large-image guard.
 *
 * A multi-megabyte image read into context is invisible to the growth-based
 * nudge machinery until the next API response reports token usage — and with
 * a non-vision provider billing base64 as text, that next request may be the
 * one the backend rejects as over-length. This module detects NEW oversized
 * inline images on each transform pass and produces a one-shot strong notice
 * telling the model to compress older ranges immediately ("compress before you
 * work with the image").
 *
 * Dedup state lives in `state.imageSurgeNudged` (persisted): one notice per
 * (message, part, content) triple for the session's lifetime. A turn that
 * already contains a compress call skips detection entirely (the early return
 * in injectCompressNudges), so an ignored notice re-fires on the next plain
 * turn while the image is still visible.
 */

import type { SessionState, WithParts } from "../state"
import { extForMediaType, parseImageDataUrl, sha8 } from "../compress/image-archive"
import { decodedBytesFromBase64, estimateImagePartTokens } from "../compress/image-tokens"

export interface LargeImageInfo {
    ref: string
    mediaType: string
    bytes: number
    estimatedTokens: number
}

/** Insertion-ordered cap so long sessions cannot grow the dedup map unboundedly. */
export const IMAGE_SURGE_DEDUP_CAP = 512

/**
 * Scan messages for inline images at/above `largeBytes` whose content has not
 * been noticed before. Records each newly found image into
 * `state.imageSurgeNudged` (mutates + returns the new ones), so callers must
 * persist state after a non-empty result.
 */
export function detectNewLargeImages(
    messages: WithParts[],
    state: SessionState,
    largeBytes: number,
): LargeImageInfo[] {
    if (!Number.isFinite(largeBytes) || largeBytes <= 0) return []

    // State persisted by pre-#489 builds (or partially constructed states in
    // tests) lacks this map — heal lazily instead of assuming the field.
    const nudged = (state.imageSurgeNudged ??= {})

    const found: LargeImageInfo[] = []
    for (const message of messages) {
        const rawId = message.info.id
        if (!rawId) continue
        const ref = state.messageIds.byRawId.get(rawId)
        if (!ref) continue
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex]
            if (part.type !== "file") continue
            const parsed = parseImageDataUrl(part.url)
            if (!parsed) continue
            if (!extForMediaType(parsed.mediaType)) continue

            const bytes = decodedBytesFromBase64(parsed.base64)
            if (bytes < largeBytes) continue

            // Cheap pre-filter before hashing multi-MB base64: skip when this
            // (rawId, partIndex) slot was already noticed under any content hash.
            const slotPrefix = `${sha8(rawId)}:p${partIndex}:`
            let slotSeen = false
            for (const key of Object.keys(nudged)) {
                if (key.startsWith(slotPrefix)) {
                    slotSeen = true
                    break
                }
            }
            if (slotSeen) continue

            const key = `${slotPrefix}${sha8(parsed.base64)}`
            if (nudged[key] !== undefined) continue
            nudged[key] = Date.now()

            found.push({
                ref,
                mediaType: parsed.mediaType,
                bytes,
                estimatedTokens: estimateImagePartTokens(part),
            })
        }
    }

    const keys = Object.keys(nudged)
    if (keys.length > IMAGE_SURGE_DEDUP_CAP) {
        for (const key of keys.slice(0, keys.length - IMAGE_SURGE_DEDUP_CAP)) {
            delete nudged[key]
        }
    }

    return found
}

function formatBytes(bytes: number): string {
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function formatLargeImageNotice(images: LargeImageInfo[]): string {
    const items = images
        .map(
            (image) =>
                `- ${image.ref}: ${image.mediaType}, ${formatBytes(image.bytes)} ` +
                `(≈${formatTokens(image.estimatedTokens)} vision tokens; far more if your provider bills base64 as text)`,
        )
        .join("\n")
    return (
        `\n\n🖼️ Large image(s) just entered context:\n${items}\n` +
        `Before doing anything else, make room: call the \`compress\` tool NOW on older conversation ranges you no longer need (acp_status lists them). ` +
        `Once you are done analyzing the image(s), compress the range(s) containing them — archived copies stay re-readable via their disk pointers.`
    )
}

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}
