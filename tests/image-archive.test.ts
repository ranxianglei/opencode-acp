import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs"
import { createSessionState, type WithParts } from "../lib/state"
import type { CompressImagesConfig } from "../lib/config"
import type { SelectionResolution } from "../lib/compress/types"
import { Logger } from "../lib/logger"
import {
    archiveDirName,
    appendArchivedImagePointers,
    archiveSessionImages,
    extForMediaType,
    parseImageDataUrl,
    pruneImageArchive,
} from "../lib/compress/image-archive"

const logger = new Logger(false)
const imagesConfig: CompressImagesConfig = {
    enabled: true,
    minBytes: 16384,
    ttlDays: 7,
    largeBytes: 524288,
    nudge: true,
}

function makePngDataUrl(byteLength: number): string {
    return `data:image/png;base64,${Buffer.alloc(byteLength, 0x42).toString("base64")}`
}

function filePart(messageID: string, sessionID: string, id: string, mime: string, url: string) {
    return { id, messageID, sessionID, type: "file" as const, mime, url }
}

function buildMessage(sessionID: string, messageId: string, parts: unknown[]): WithParts {
    return {
        info: {
            id: messageId,
            role: "user",
            sessionID,
            time: { created: 1 },
        } as WithParts["info"],
        parts: parts as WithParts["parts"],
    }
}

function makeState(
    storageDir: string,
    sessionId = "ses_image_archive",
): ReturnType<typeof createSessionState> {
    const state = createSessionState()
    state.sessionId = sessionId
    state.storageDir = storageDir
    return state
}

test("parseImageDataUrl accepts data:image base64 urls only", () => {
    assert.deepEqual(parseImageDataUrl(makePngDataUrl(16)), {
        mediaType: "image/png",
        base64: Buffer.alloc(16, 0x42).toString("base64"),
    })
    // Uppercase MIME normalizes to lowercase
    assert.equal(parseImageDataUrl(`data:IMAGE/PNG;base64,AAAA`)?.mediaType, "image/png")
    // Non-data URLs are out of scope for v1
    assert.equal(parseImageDataUrl("file:///home/user/pic.png"), undefined)
    assert.equal(parseImageDataUrl("https://example.com/pic.png"), undefined)
    // Non-image data URLs are not archived
    assert.equal(parseImageDataUrl(`data:text/plain;base64,AAAA`), undefined)
})

test("extForMediaType covers decodable raster types and excludes SVG", () => {
    assert.equal(extForMediaType("image/png"), "png")
    assert.equal(extForMediaType("image/jpeg"), "jpg")
    assert.equal(extForMediaType("image/webp"), "webp")
    assert.equal(extForMediaType("image/avif"), "avif")
    assert.equal(extForMediaType("image/svg+xml"), undefined)
    assert.equal(extForMediaType("image/tiff"), undefined)
})

test("archiveDirName keeps clean ids, salts and truncates dirty ones without collisions", () => {
    assert.equal(archiveDirName("ses_abc123"), "ses_abc123")
    const dirtyA = archiveDirName("ses/a.b:c")
    const dirtyB = archiveDirName("sesa.b-c")
    assert.ok(dirtyA.includes("-"))
    assert.notEqual(dirtyA, dirtyB)
    const longId = "x".repeat(150)
    const longName = archiveDirName(longId)
    assert.ok(longName.length <= 100 + 9)
    assert.ok(longName !== archiveDirName("y".repeat(150)))
})

test("archiveSessionImages spills large inline images to disk with metadata-only index", () => {
    const storageDir = join(tmpdir(), `acp-img-archive-${process.pid}-core`)
    rmSync(storageDir, { recursive: true, force: true })
    mkdirSync(storageDir, { recursive: true })
    try {
        const state = makeState(storageDir)
        const messages = [
            buildMessage(state.sessionId!, "msg-with-image", [
                filePart(
                    "msg-with-image",
                    state.sessionId!,
                    "part-img",
                    "image/png",
                    makePngDataUrl(20480),
                ),
            ]),
        ]

        const archived = archiveSessionImages(state, messages, imagesConfig, logger)
        assert.equal(archived, 1)

        const entries = state.imageArchive["msg-with-image"]
        assert.ok(entries, "index entry keyed by RAW message id")
        assert.equal(entries.length, 1)
        assert.equal(entries[0].mediaType, "image/png")
        assert.equal(entries[0].bytes, 20480)
        assert.ok(entries[0].path.startsWith(join(storageDir, "images")), entries[0].path)
        assert.ok(existsSync(entries[0].path))
        assert.equal(statSync(entries[0].path).mode & 0o777, 0o600)
        assert.equal(state.stats.imagesArchived, 1)
        assert.equal(state.stats.imageBytesArchived, 20480)

        // Second pass over the same messages must be a no-op (no double write/count)
        assert.equal(archiveSessionImages(state, messages, imagesConfig, logger), 0)
        assert.equal(state.imageArchive["msg-with-image"].length, 1)
        assert.equal(state.stats.imagesArchived, 1)
        assert.equal(state.stats.imageBytesArchived, 20480)
    } finally {
        rmSync(storageDir, { recursive: true, force: true })
    }
})

test("archiveSessionImages skips small, disabled, non-inline and non-raster images", () => {
    const storageDir = join(tmpdir(), `acp-img-archive-${process.pid}-skip`)
    rmSync(storageDir, { recursive: true, force: true })
    mkdirSync(storageDir, { recursive: true })
    try {
        const state = makeState(storageDir)
        const small = makePngDataUrl(100)
        const big = makePngDataUrl(20480)
        const messages = [
            buildMessage(state.sessionId!, "msg-small", [
                filePart("msg-small", state.sessionId!, "p1", "image/png", small),
            ]),
            buildMessage(state.sessionId!, "msg-path", [
                filePart("msg-path", state.sessionId!, "p2", "image/png", "file:///tmp/x.png"),
                filePart("msg-path", state.sessionId!, "p3", "image/png", "https://e.com/x.png"),
            ]),
            buildMessage(state.sessionId!, "msg-svg", [
                filePart(
                    "msg-svg",
                    state.sessionId!,
                    "p4",
                    "image/svg+xml",
                    big.replace("image/png", "image/svg+xml"),
                ),
            ]),
        ]

        assert.equal(archiveSessionImages(state, messages, imagesConfig, logger), 0)
        assert.equal(Object.keys(state.imageArchive).length, 0)
        assert.equal(state.stats.imagesArchived, undefined)

        // Master switch off: even a qualifying image is left alone
        const stateDisabled = makeState(storageDir, "ses_disabled")
        const bigMessages = [
            buildMessage(stateDisabled.sessionId!, "msg-big", [
                filePart("msg-big", stateDisabled.sessionId!, "p5", "image/png", big),
            ]),
        ]
        assert.equal(
            archiveSessionImages(
                stateDisabled,
                bigMessages,
                { ...imagesConfig, enabled: false },
                logger,
            ),
            0,
        )
        assert.equal(existsSync(join(storageDir, "images")), false)
    } finally {
        rmSync(storageDir, { recursive: true, force: true })
    }
})

test("pruneImageArchive removes expired files, index entries and the empty dir", () => {
    const storageDir = join(tmpdir(), `acp-img-archive-${process.pid}-ttl`)
    rmSync(storageDir, { recursive: true, force: true })
    mkdirSync(storageDir, { recursive: true })
    try {
        const state = makeState(storageDir)
        const messages = [
            buildMessage(state.sessionId!, "msg-old", [
                filePart("msg-old", state.sessionId!, "p1", "image/png", makePngDataUrl(20480)),
            ]),
        ]
        archiveSessionImages(state, messages, imagesConfig, logger)
        const [entry] = state.imageArchive["msg-old"]

        const past = new Date(Date.now() - 8 * 86_400_000)
        utimesSync(entry.path, past, past)
        pruneImageArchive(state, imagesConfig, logger)

        assert.equal(existsSync(entry.path), false)
        assert.equal(state.imageArchive["msg-old"], undefined)
        assert.equal(
            existsSync(join(storageDir, "images", archiveDirName(state.sessionId!))),
            false,
        )

        // TTL sweep runs once per session state (once per process in
        // production) — a newly expired file survives within the same run.
        archiveSessionImages(state, messages, imagesConfig, logger)
        const [rearchived] = state.imageArchive["msg-old"]
        const pastAgain = new Date(Date.now() - 8 * 86_400_000)
        utimesSync(rearchived.path, pastAgain, pastAgain)
        pruneImageArchive(state, imagesConfig, logger)
        assert.equal(existsSync(rearchived.path), true)
    } finally {
        rmSync(storageDir, { recursive: true, force: true })
    }
})

test("pruneImageArchive keeps files newer than the TTL", () => {
    const storageDir = join(tmpdir(), `acp-img-archive-${process.pid}-keep`)
    rmSync(storageDir, { recursive: true, force: true })
    mkdirSync(storageDir, { recursive: true })
    try {
        const state = makeState(storageDir)
        const messages = [
            buildMessage(state.sessionId!, "msg-fresh", [
                filePart("msg-fresh", state.sessionId!, "p1", "image/png", makePngDataUrl(20480)),
            ]),
        ]
        archiveSessionImages(state, messages, imagesConfig, logger)
        const [entry] = state.imageArchive["msg-fresh"]
        pruneImageArchive(state, imagesConfig, logger)
        assert.equal(existsSync(entry.path), true)
        assert.deepEqual(state.imageArchive["msg-fresh"], [entry])
    } finally {
        rmSync(storageDir, { recursive: true, force: true })
    }
})

test("appendArchivedImagePointers appends re-readable pointers resolved by ref", () => {
    const state = makeState("/unused-storage")
    state.imageArchive["msg-with-image"] = [
        { path: "/data/images/ses_x/deadbeef-p0-cafe.png", mediaType: "image/png", bytes: 20480 },
    ]
    state.messageIds.byRawId.set("msg-with-image", "m00001")

    const selection = { messageIds: ["msg-with-image", "msg-unknown-id"] } as SelectionResolution
    const out = appendArchivedImagePointers("SUMMARY", selection, state, true)
    assert.ok(out.startsWith("SUMMARY"))
    assert.ok(out.includes("archived to disk"))
    assert.ok(
        out.includes("- m00001: /data/images/ses_x/deadbeef-p0-cafe.png (image/png, 20480 bytes)"),
    )
    // Raw ids without a known ref fall back to the raw id itself
    state.imageArchive["msg-unknown-id"] = [
        { path: "/data/images/ses_x/ffff-p0-aaaa.png", mediaType: "image/jpeg", bytes: 1000 },
    ]
    const out2 = appendArchivedImagePointers("SUMMARY", selection, state, true)
    assert.ok(
        out2.includes(
            "- msg-unknown-id: /data/images/ses_x/ffff-p0-aaaa.png (image/jpeg, 1000 bytes)",
        ),
    )

    // No archived images in range → summary untouched
    const empty = makeState("/unused-storage")
    assert.equal(appendArchivedImagePointers("SUMMARY", selection, empty, true), "SUMMARY")
    // Disabled → summary untouched
    assert.equal(appendArchivedImagePointers("SUMMARY", selection, state, false), "SUMMARY")
})
