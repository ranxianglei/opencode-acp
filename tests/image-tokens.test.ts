import assert from "node:assert/strict"
import test from "node:test"
import {
    clearImageTokenCache,
    decodedBytesFromBase64,
    decodeBase64Prefix,
    estimateImagePartTokens,
    estimateVisionTokensForDimensions,
    parseImageDimensions,
    TOKENS_PER_TILE,
    VISION_MAX_TILES,
} from "../lib/compress/image-tokens"

// ─── Synthetic container headers (minimal valid prefixes) ───────────────────

function pngHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    b.writeUInt32BE(13, 8) // IHDR chunk length
    b.write("IHDR", 12, "ascii")
    b.writeUInt32BE(width, 16)
    b.writeUInt32BE(height, 20)
    return b
}

function jpegHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(32)
    b[0] = 0xff
    b[1] = 0xd8 // SOI
    b[2] = 0xff
    b[3] = 0xe0 // APP0 segment (skipped by the scanner)
    b.writeUInt16BE(16, 4) // segment length incl. itself
    b[20] = 0xff
    b[21] = 0xc0 // SOF0 @i=20
    b[25] = 8 // precision @i+5
    b.writeUInt16BE(height, 26) // height @i+6
    b.writeUInt16BE(width, 28) // width @i+8
    return b
}

function gifHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(13)
    b.write("GIF89a", 0, "ascii")
    b.writeUInt16LE(width, 6)
    b.writeUInt16LE(height, 8)
    return b
}

function webpVP8LHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(32)
    b.write("RIFF", 0, "ascii")
    b.writeUInt32LE(26, 4)
    b.write("WEBP", 8, "ascii")
    b.write("VP8L", 12, "ascii")
    b.writeUInt32LE(10, 16)
    b[20] = 0x2f // VP8L signature byte
    const packed = (width - 1) | ((height - 1) << 14)
    b[21] = packed & 0xff
    b[22] = (packed >> 8) & 0xff
    b[23] = (packed >> 16) & 0xff
    return b
}

function webpVP8XHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(32)
    b.write("RIFF", 0, "ascii")
    b.writeUInt32LE(30, 4)
    b.write("WEBP", 8, "ascii")
    b.write("VP8X", 12, "ascii")
    b.writeUInt32LE(10, 16)
    b[20] = 0x00 // flags
    b.writeUIntLE(width - 1, 24, 3)
    b.writeUIntLE(height - 1, 27, 3)
    return b
}

function webpVP8Header(width: number, height: number): Buffer {
    const b = Buffer.alloc(32)
    b.write("RIFF", 0, "ascii")
    b.writeUInt32LE(26, 4)
    b.write("WEBP", 8, "ascii")
    b.write("VP8 ", 12, "ascii")
    b.writeUInt32LE(10, 16)
    b[23] = 0x9d // frame tag
    b[24] = 0x01
    b[25] = 0x2a
    b.writeUInt16LE(width & 0x3fff, 26)
    b.writeUInt16LE(height & 0x3fff, 28)
    return b
}

function bmpHeader(width: number, height: number): Buffer {
    const b = Buffer.alloc(26)
    b[0] = 0x42 // 'B'
    b[1] = 0x4d // 'M'
    b.writeInt32LE(width, 18)
    b.writeInt32LE(-height, 22) // negative = bottom-up storage; parser takes abs
    return b
}

const dataUrl = (mime: string, buf: Buffer): string =>
    `data:${mime};base64,${buf.toString("base64")}`

// ─── Vision token formula ────────────────────────────────────────────────────

test("vision formula: issue #489's 3298x1642 image costs 1336 tokens", () => {
    // scale = 1568/3298 → 1568x780 → ceil(1568/512)*ceil(780/512) = 4*2 tiles
    assert.equal(estimateVisionTokensForDimensions(3298, 1642), 8 * TOKENS_PER_TILE)
    assert.equal(estimateVisionTokensForDimensions(3298, 1642), 1336)
})

test("vision formula: tile grid, cap and degenerate inputs", () => {
    assert.equal(estimateVisionTokensForDimensions(512, 512), 167) // 1x1 tiles
    assert.equal(estimateVisionTokensForDimensions(100, 100), 167) // sub-tile rounds up to 1
    assert.equal(estimateVisionTokensForDimensions(1, 1), 167)
    assert.equal(estimateVisionTokensForDimensions(1024, 1024), 668) // 2x2 tiles
    assert.equal(estimateVisionTokensForDimensions(4000, 3000), 2004) // scaled 1568x1176 → 4x3
    assert.equal(estimateVisionTokensForDimensions(4096, 4096), VISION_MAX_TILES * TOKENS_PER_TILE)
    assert.equal(estimateVisionTokensForDimensions(1568, 1568), VISION_MAX_TILES * TOKENS_PER_TILE)
    // Degenerate inputs never throw, always 0
    assert.equal(estimateVisionTokensForDimensions(0, 100), 0)
    assert.equal(estimateVisionTokensForDimensions(-5, 10), 0)
    assert.equal(estimateVisionTokensForDimensions(Number.NaN, 10), 0)
    assert.equal(estimateVisionTokensForDimensions(Number.POSITIVE_INFINITY, 10), 0)
})

// ─── Header parsing ──────────────────────────────────────────────────────────

test("parseImageDimensions handles PNG, JPEG, GIF, WebP (VP8/VP8L/VP8X) and BMP", () => {
    assert.deepEqual(parseImageDimensions(pngHeader(3298, 1642), "image/png"), {
        width: 3298,
        height: 1642,
    })
    assert.deepEqual(parseImageDimensions(jpegHeader(1920, 1080), "image/jpeg"), {
        width: 1920,
        height: 1080,
    })
    assert.deepEqual(parseImageDimensions(gifHeader(800, 600), "image/gif"), {
        width: 800,
        height: 600,
    })
    assert.deepEqual(parseImageDimensions(webpVP8LHeader(1000, 500), "image/webp"), {
        width: 1000,
        height: 500,
    })
    assert.deepEqual(parseImageDimensions(webpVP8XHeader(777, 333), "image/webp"), {
        width: 777,
        height: 333,
    })
    assert.deepEqual(parseImageDimensions(webpVP8Header(1280, 720), "image/webp"), {
        width: 1280,
        height: 720,
    })
    assert.deepEqual(parseImageDimensions(bmpHeader(640, 480), "image/bmp"), {
        width: 640,
        height: 480,
    })
})

test("parseImageDimensions rejects a VP8 chunk with a corrupt frame tag", () => {
    const buf = webpVP8Header(1280, 720)
    buf[23] = 0x00 // corrupt the frame tag at chunk-payload offset 3
    assert.equal(parseImageDimensions(buf, "image/webp"), undefined)
})

test("parseImageDimensions returns undefined for garbage, truncation and wrong format", () => {
    const garbage = Buffer.alloc(64, 0x42)
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]) {
        assert.equal(parseImageDimensions(garbage, mime), undefined, mime)
    }
    // Truncated headers must not throw
    assert.equal(parseImageDimensions(pngHeader(10, 10).subarray(0, 10), "image/png"), undefined)
    assert.equal(parseImageDimensions(jpegHeader(10, 10).subarray(0, 12), "image/jpeg"), undefined)
    assert.equal(parseImageDimensions(gifHeader(10, 10).subarray(0, 8), "image/gif"), undefined)
    // Wrong magic for the declared mime
    assert.equal(parseImageDimensions(pngHeader(10, 10), "image/jpeg"), undefined)
    // Unsupported containers
    assert.equal(parseImageDimensions(Buffer.alloc(64, 1), "image/avif"), undefined)
})

test("parseImageDimensions rejects implausible dimension values", () => {
    // Zero-sized IHDR
    const zeroed = pngHeader(0, 500)
    assert.equal(parseImageDimensions(zeroed, "image/png"), undefined)
    // >1MP guard
    const huge = pngHeader(2_000_000, 10)
    assert.equal(parseImageDimensions(huge, "image/png"), undefined)
})

// ─── Base64 helpers ──────────────────────────────────────────────────────────

test("decodedBytesFromBase64 derives size from payload length", () => {
    assert.equal(decodedBytesFromBase64(""), 0)
    assert.equal(decodedBytesFromBase64("AAAA"), 3)
    assert.equal(decodedBytesFromBase64(Buffer.alloc(1024, 0x42).toString("base64")), 1026)
})

test("decodeBase64Prefix decodes an aligned prefix and refuses tiny input", () => {
    const buf = Buffer.from("hello world, this is a prefix scan")
    const b64 = buf.toString("base64")
    // Slices on a 4-char base64 boundary, so the result is ≤ maxBytes, aligned.
    const prefix = decodeBase64Prefix(b64, 6)
    assert.ok(prefix)
    assert.equal(prefix.length, 6)
    assert.equal(Buffer.from(prefix).toString("utf8"), "hello ")
    assert.equal(decodeBase64Prefix("", 10), undefined)
    assert.equal(decodeBase64Prefix("AA", 10), undefined)
})

// ─── Per-part estimator ──────────────────────────────────────────────────────

test("estimateImagePartTokens is 0 for non-inline-image parts", () => {
    assert.equal(estimateImagePartTokens({ type: "text", text: "hi" }), 0)
    assert.equal(estimateImagePartTokens({ type: "tool", tool: "bash" }), 0)
    assert.equal(estimateImagePartTokens({ type: "reasoning" }), 0)
    assert.equal(estimateImagePartTokens(null), 0)
    assert.equal(estimateImagePartTokens("not an object"), 0)
    // Non-data URLs are out of scope (same boundary as the #478 archive)
    assert.equal(
        estimateImagePartTokens({ type: "file", url: "https://example.com/pic.png" }),
        0,
    )
    assert.equal(estimateImagePartTokens({ type: "file", url: "file:///tmp/pic.png" }), 0)
    // Non-image data URLs
    assert.equal(
        estimateImagePartTokens({
            type: "file",
            url: dataUrl("application/pdf", Buffer.from("%PDF-1.4")),
        }),
        0,
    )
})

test("estimateImagePartTokens uses the vision formula when dimensions parse", () => {
    const part = { type: "file", url: dataUrl("image/png", pngHeader(3298, 1642)) }
    assert.equal(estimateImagePartTokens(part), 1336)
    const jpeg = { type: "file", url: dataUrl("image/jpeg", jpegHeader(1920, 1080)) }
    // 1920x1080 → scaled 1568x882 → 4*2 tiles
    assert.equal(estimateImagePartTokens(jpeg), 8 * TOKENS_PER_TILE)
})

test("estimateImagePartTokens falls back for unparseable payloads", () => {
    // Unknown dims, >= 256KB decoded → capped at max tiles
    const big = { type: "file", url: dataUrl("image/png", Buffer.alloc(300 * 1024, 0x42)) }
    assert.equal(estimateImagePartTokens(big), VISION_MAX_TILES * TOKENS_PER_TILE)
    // Unknown dims, small → base64/4 proxy
    const smallBuf = Buffer.alloc(1024, 0x42)
    const small = { type: "file", url: dataUrl("image/png", smallBuf) }
    assert.equal(estimateImagePartTokens(small), Math.round(smallBuf.toString("base64").length / 4))
})

test("estimateImagePartTokens is stable across repeated calls and cache clears", () => {
    clearImageTokenCache()
    const part = { type: "file", url: dataUrl("image/png", pngHeader(640, 480)) }
    const first = estimateImagePartTokens(part)
    assert.ok(first > 0)
    assert.equal(estimateImagePartTokens(part), first)
    clearImageTokenCache()
    assert.equal(estimateImagePartTokens(part), first)
})
