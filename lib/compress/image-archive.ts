import { createHash } from "node:crypto"
import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { CompressImagesConfig } from "../config"
import type { Logger } from "../logger"
import { getDefaultStorageDir } from "../state/persistence"
import type { ArchivedImageEntry, SessionState, WithParts } from "../state/types"
import type { SelectionResolution } from "./types"

const DATA_URL_REGEX = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is

/**
 * [Issue #478] Decodable image types only. SVG is intentionally excluded:
 * it is text-based and can embed scripts — archiving it would turn a summary
 * pointer into a potential code-execution path when re-read.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/bmp": "bmp",
}

/** [Issue #478/#489] Short content fingerprint; shared with the image nudge dedup keys. */
export function sha8(input: string | Buffer): string {
    return createHash("sha256").update(input).digest("hex").slice(0, 8)
}

/**
 * [Issue #478] Parse an inline data-URL image attachment. Returns undefined for
 * non-data URLs (file paths, http(s) links) which v1 does not archive.
 */
export function parseImageDataUrl(url: string):
    | {
          mediaType: string
          base64: string
      }
    | undefined {
    if (typeof url !== "string") return undefined
    const match = DATA_URL_REGEX.exec(url)
    if (!match) return undefined
    return { mediaType: match[1].toLowerCase(), base64: match[2] }
}

export function extForMediaType(mediaType: string): string | undefined {
    return IMAGE_EXTENSIONS[mediaType.toLowerCase()]
}

/**
 * [Issue #478] Map a session ID to a safe archive directory name. The salt
 * (sha8 of the raw ID) is appended whenever sanitization changed the string,
 * so two distinct session IDs can never collide on one directory even after
 * aggressive character replacement.
 */
export function archiveDirName(sessionId: string): string {
    let name = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100)
    if (name !== sessionId) {
        name = `${name}-${sha8(sessionId)}`
    }
    return name || "-"
}

function archiveRoot(storageDir: string | undefined, sessionId: string): string {
    return join(storageDir ?? getDefaultStorageDir(), "images", archiveDirName(sessionId))
}

/**
 * [Issue #478] Spill inline image attachments of known messages to disk so that
 * later compression folds keep a re-readable file pointer instead of silently
 * losing the pixels. Metadata-only index in `state.imageArchive` (keyed by RAW
 * message ID — stable across compaction ref re-issue); pixels never enter state.
 * Never throws: any I/O failure downgrades to a warn log and skips the entry.
 * Returns the number of newly archived images.
 */
export function archiveSessionImages(
    state: SessionState,
    messages: WithParts[],
    images: CompressImagesConfig,
    logger: Logger,
): number {
    if (!images.enabled || !state.sessionId) return 0

    const root = archiveRoot(state.storageDir, state.sessionId)
    let archived = 0

    for (const message of messages) {
        const rawId = message.info.id
        if (!rawId) continue
        const parts = Array.isArray(message.parts) ? message.parts : []

        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            const part = parts[partIndex]
            if (part.type !== "file") continue
            const parsed = parseImageDataUrl(part.url)
            if (!parsed) continue
            const ext = extForMediaType(parsed.mediaType)
            if (!ext) continue

            // Content identity comes from the base64 payload hash — cheap to
            // compute and identical for identical bytes, so the index check
            // below can skip re-decoding images already archived this session.
            const fileName = `${sha8(rawId)}-p${partIndex}-${sha8(parsed.base64)}.${ext}`
            const filePath = join(root, fileName)

            const existing = state.imageArchive[rawId]?.find((e) => e.path === filePath)
            if (existing) continue

            let bytes: number
            try {
                if (existsSync(filePath)) {
                    bytes = statSync(filePath).size
                } else {
                    const buffer = Buffer.from(parsed.base64, "base64")
                    bytes = buffer.byteLength
                    if (bytes < images.minBytes) continue
                    mkdirSync(root, { recursive: true })
                    writeFileSync(filePath, buffer, { mode: 0o600 })
                }
            } catch (error) {
                logger.warn(
                    `[#478] failed to archive image ${filePath}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                )
                continue
            }

            const entry: ArchivedImageEntry = {
                path: filePath,
                mediaType: parsed.mediaType,
                bytes,
            }
            if (!state.imageArchive[rawId]) {
                state.imageArchive[rawId] = []
            }
            state.imageArchive[rawId].push(entry)
            state.stats.imagesArchived = (state.stats.imagesArchived ?? 0) + 1
            state.stats.imageBytesArchived = (state.stats.imageBytesArchived ?? 0) + bytes
            archived++
        }
    }

    return archived
}

/**
 * [Issue #478] Best-effort TTL sweep of the session's archived image files,
 * run at most once per process per session (transient `imagePruneDone` flag).
 * Files older than `ttlDays` are deleted along with their index entries; the
 * now-empty directory is removed too. Never throws.
 */
export function pruneImageArchive(
    state: SessionState,
    images: CompressImagesConfig,
    logger: Logger,
): void {
    if (state.imagePruneDone || !state.sessionId) return
    state.imagePruneDone = true

    try {
        const root = archiveRoot(state.storageDir, state.sessionId)
        if (!existsSync(root)) return

        const cutoff = Date.now() - images.ttlDays * 86_400_000
        const prunedPaths = new Set<string>()

        for (const name of readdirSync(root)) {
            const filePath = join(root, name)
            try {
                if (statSync(filePath).mtimeMs < cutoff) {
                    unlinkSync(filePath)
                    prunedPaths.add(filePath)
                }
            } catch {
                // Per-file failure is not fatal — other entries still get swept.
            }
        }

        if (prunedPaths.size > 0) {
            for (const [rawId, entries] of Object.entries(state.imageArchive)) {
                const kept = entries.filter((e) => !prunedPaths.has(e.path))
                if (kept.length === 0) {
                    delete state.imageArchive[rawId]
                } else if (kept.length !== entries.length) {
                    state.imageArchive[rawId] = kept
                }
            }
            logger.info(`[#478] TTL sweep removed ${prunedPaths.size} expired archived image(s)`)
        }

        if (readdirSync(root).length === 0) {
            rmdirSync(root)
        }
    } catch (error) {
        logger.warn(
            `[#478] image TTL sweep failed: ${
                error instanceof Error ? error.message : String(error)
            }`,
        )
    }
}

/**
 * [Issue #478] Append a pointer appendix to a folded block summary listing every
 * archived image whose source message falls inside the compressed range, so the
 * model can re-read the pixels with its own file tools after folding.
 */
export function appendArchivedImagePointers(
    summary: string,
    selection: SelectionResolution,
    state: SessionState,
    enabled: boolean,
): string {
    if (!enabled) return summary

    const lines: string[] = []
    for (const messageId of selection.messageIds) {
        const entries = state.imageArchive[messageId]
        if (!entries || entries.length === 0) continue
        const ref = state.messageIds.byRawId.get(messageId) ?? messageId
        for (const entry of entries) {
            lines.push(`- ${ref}: ${entry.path} (${entry.mediaType}, ${entry.bytes} bytes)`)
        }
    }

    if (lines.length === 0) return summary

    const heading =
        "\n\nImages captured in this range were archived to disk (their pixels are NOT summarized). Re-read them with your file tools if you need the pixels again:"
    return summary + heading + "\n" + lines.join("\n")
}
