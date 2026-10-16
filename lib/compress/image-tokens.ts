/**
 * [Issue #489] Image token estimation for ACP metering.
 *
 * Before #489 every ACP counter treated inline image attachments (`file` parts
 * carrying data-URLs) as zero tokens: usage fallback, context composition,
 * compressible ranges, protected-zone sizing and per-message tags all skipped
 * them. A multi-megabyte image could therefore enter context without any
 * threshold or nudge reacting to its real size.
 *
 * This module estimates the context cost of one inline image part:
 * - When pixel dimensions can be parsed from the container header, the vision
 *   billing formula applies (Anthropic-style: scale longest side to <=1568 px,
 *   512x512 tiles x 167 tokens). It matches the order of magnitude used by the
 *   major vision providers (Anthropic / OpenAI / Gemini / Qwen-VL).
 * - When dimensions cannot be parsed: payloads >= 256KB fall back to the tile
 *   cap (the maximum a vision model will bill); smaller payloads fall back to
 *   base64 length / 4, a reasonable proxy for small rasters.
 *
 * Providers that bill base64 as plain TEXT (non-vision models) charge far more
 * than any vision estimate. That failure mode is covered by the byte-size
 * large-image nudge (#489), not by this estimator — deliberately, so vision
 * users do not see their 50KB screenshot reported as 33K tokens.
 */

import { parseImageDataUrl } from "./image-archive"

/** Longest side after provider-side downscaling (Anthropic 1568px convention). */
export const VISION_MAX_SIDE = 1568
/** Tile edge size in pixels; each tile bills ~167 tokens on major providers. */
export const VISION_TILE_SIZE = 512
export const TOKENS_PER_TILE = 167
/** ceil(1568/512)^2 — hard tile cap for any single image. */
export const VISION_MAX_TILES = Math.ceil(VISION_MAX_SIDE / VISION_TILE_SIZE) ** 2
/** Unknown-dimension payloads at/above this size use the tile-cap fallback. */
export const UNKNOWN_DIM_LARGE_BYTES = 256 * 1024

export interface ImageDimensions {
    width: number
    height: number
}

/**
 * Vision-billing token estimate for known pixel dimensions. Pure function —
 * safe to call on hot paths. Returns 0 for non-positive/non-finite inputs.
 */
export function estimateVisionTokensForDimensions(width: number, height: number): number {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return 0
    }
    const scale = Math.min(1, VISION_MAX_SIDE / Math.max(width, height))
    const scaledWidth = Math.max(1, Math.floor(width * scale))
    const scaledHeight = Math.max(1, Math.floor(height * scale))
    const tiles =
        Math.ceil(scaledWidth / VISION_TILE_SIZE) * Math.ceil(scaledHeight / VISION_TILE_SIZE)
    return Math.min(tiles, VISION_MAX_TILES) * TOKENS_PER_TILE
}

function validDimensions(width: unknown, height: unknown): ImageDimensions | undefined {
    if (
        typeof width !== "number" ||
        typeof height !== "number" ||
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > 1_000_000 ||
        height > 1_000_000
    ) {
        return undefined
    }
    return { width, height }
}

function fourcc(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

/**
 * Best-effort pixel-dimension parsing from container headers. Only decodes the
 * bytes already provided (callers pass a bounded prefix), never allocates the
 * full payload. Supports PNG, JPEG, GIF, WebP (VP8/VP8L/VP8X) and BMP; returns
 * undefined for everything else (AVIF, HEIC, truncated/corrupt headers).
 */
export function parseImageDimensions(
    bytes: Uint8Array,
    mediaType: string,
): ImageDimensions | undefined {
    const len = bytes.length
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    switch (mediaType.toLowerCase()) {
        case "image/png": {
            // Signature 8 bytes, IHDR chunk: width/height big-endian u32 @16/20.
            if (len < 24) return undefined
            const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
            for (let i = 0; i < sig.length; i++) {
                if (bytes[i] !== sig[i]) return undefined
            }
            return validDimensions(dv.getUint32(16, false), dv.getUint32(20, false))
        }
        case "image/jpeg":
        case "image/jpg": {
            if (len < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
            let i = 2
            while (i + 9 < len) {
                if (bytes[i] !== 0xff) {
                    i++
                    continue
                }
                const marker = bytes[i + 1]
                // Standalone markers / start-of-scan: no SOF follows in-band.
                if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xda && marker <= 0xdf)) {
                    return undefined
                }
                // SOF0..SOF15 except DHT(0xC4)/JPG(0xC8)/DAC(0xCC): precision
                // byte @i+5, height u16 @i+6, width u16 @i+8.
                if (
                    marker >= 0xc0 &&
                    marker <= 0xcf &&
                    marker !== 0xc4 &&
                    marker !== 0xc8 &&
                    marker !== 0xcc
                ) {
                    if (i + 9 >= len) return undefined
                    return validDimensions(dv.getUint16(i + 8, false), dv.getUint16(i + 6, false))
                }
                // Skip segment: length includes itself (u16 @i+2).
                const segLen = dv.getUint16(i + 2, false)
                if (segLen < 2) return undefined
                i += 2 + segLen
            }
            return undefined
        }
        case "image/gif": {
            // "GIF87a"/"GIF89a"; logical screen width/height little-endian u16 @6/8.
            if (len < 10) return undefined
            if (fourcc(bytes, 0) !== "GIF8") return undefined
            return validDimensions(dv.getUint16(6, true), dv.getUint16(8, true))
        }
        case "image/webp": {
            if (len < 30) return undefined
            if (fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WEBP") return undefined
            let i = 12
            while (i + 8 < len) {
                const id = fourcc(bytes, i)
                const size = dv.getUint32(i + 4, true)
                const payload = i + 8
                if (id === "VP8 ") {
                    // Frame tag (3) + start code (3), then width/height LE u16
                    // masked to 14 bits.
                    if (payload + 10 > len) return undefined
                    return validDimensions(
                        dv.getUint16(payload + 6, true) & 0x3fff,
                        dv.getUint16(payload + 8, true) & 0x3fff,
                    )
                }
                if (id === "VP8L") {
                    if (payload + 5 > len) return undefined
                    if (bytes[payload] !== 0x2f) return undefined
                    // Width-1 (14 bits) / height-1 (10 bits) packed across three
                    // little-endian bytes after the signature byte.
                    const packed =
                        bytes[payload + 1] |
                        (bytes[payload + 2] << 8) |
                        (bytes[payload + 3] << 16)
                    return validDimensions(
                        1 + (packed & 0x3fff),
                        1 + ((packed >>> 14) & 0x3fff),
                    )
                }
                if (id === "VP8X") {
                    // Width-1 / height-1 as little-endian 24-bit @payload+4/+7.
                    if (payload + 10 > len) return undefined
                    const w =
                        bytes[payload + 4] | (bytes[payload + 5] << 8) | (bytes[payload + 6] << 16)
                    const h =
                        bytes[payload + 7] | (bytes[payload + 8] << 8) | (bytes[payload + 9] << 16)
                    return validDimensions(w + 1, h + 1)
                }
                if (size === 0xffffffff) return undefined
                i = payload + size + (size & 1)
            }
            return undefined
        }
        case "image/bmp": {
            if (len < 26) return undefined
            if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
            return validDimensions(
                Math.abs(dv.getInt32(18, true)),
                Math.abs(dv.getInt32(22, true)),
            )
        }
        default:
            return undefined
    }
}

/** Decoded byte size implied by a data-URL base64 payload (exact for aligned input). */
export function decodedBytesFromBase64(base64: string): number {
    if (typeof base64 !== "string" || base64.length === 0) return 0
    return Math.max(0, Math.floor((base64.length * 3) / 4))
}

/**
 * Decode only the leading part of a base64 payload — enough for header scans
 * without materializing multi-megabyte buffers. Slices on a 4-char boundary so
 * the base64 decoder sees aligned input.
 */
export function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array | undefined {
    const chars = Math.min(base64.length, Math.ceil((maxBytes * 4) / 3))
    const aligned = chars - (chars % 4)
    if (aligned < 4) return undefined
    try {
        return new Uint8Array(Buffer.from(base64.slice(0, aligned), "base64"))
    } catch {
        return undefined
    }
}

const HEADER_SCAN_BYTES = 256 * 1024

// Per-process estimate cache. Keys mix mime type, URL length and the trailing
// 32 base64 chars (the payload end) — two distinct images sharing all three is
// negligible in practice, and this avoids hashing multi-MB strings on every
// transform pass. Insertion-ordered Map gives cheap oldest-first eviction.
const estimateCache = new Map<string, number>()
const ESTIMATE_CACHE_CAP = 512

function remember(key: string, value: number): void {
    if (estimateCache.size >= ESTIMATE_CACHE_CAP && !estimateCache.has(key)) {
        const oldest = estimateCache.keys().next().value
        if (oldest !== undefined) {
            estimateCache.delete(oldest)
        }
    }
    estimateCache.set(key, value)
}

/** Test hook: drop cached estimates (module-level state outlives test cases). */
export function clearImageTokenCache(): void {
    estimateCache.clear()
}

/**
 * Estimate the context cost of one message part. Returns 0 for every part that
 * is not an inline (data-URL) image attachment:
 * - non-file parts (text/tool/reasoning are metered elsewhere),
 * - file parts whose url is a path or http(s) link (not inline — v1 scope,
 *   same boundary as the #478 archive),
 * - non-image mimes (pdfs etc. are metered by their own rules elsewhere).
 */
export function estimateImagePartTokens(part: unknown): number {
    if (!part || typeof part !== "object") return 0
    const candidate = part as { type?: unknown; url?: unknown }
    if (candidate.type !== "file") return 0
    const url = typeof candidate.url === "string" ? candidate.url : undefined
    if (!url) return 0
    const parsed = parseImageDataUrl(url)
    if (!parsed) return 0

    const key = `${parsed.mediaType}:${url.length}:${url.slice(-32)}`
    const cached = estimateCache.get(key)
    if (cached !== undefined) return cached

    let estimate: number
    const prefix = decodeBase64Prefix(parsed.base64, HEADER_SCAN_BYTES)
    const dims = prefix ? parseImageDimensions(prefix, parsed.mediaType) : undefined
    if (dims) {
        estimate = estimateVisionTokensForDimensions(dims.width, dims.height)
    } else {
        const bytes = decodedBytesFromBase64(parsed.base64)
        estimate =
            bytes >= UNKNOWN_DIM_LARGE_BYTES
                ? VISION_MAX_TILES * TOKENS_PER_TILE
                : Math.round(parsed.base64.length / 4)
    }

    remember(key, estimate)
    return estimate
}
