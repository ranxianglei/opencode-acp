/**
 * /acp export command — user-initiated export of active compression-block
 * summaries to a markdown file.
 *
 * Design (see devlog/2026-08-03_acp-export-command/REQ.md):
 *   - Exports ACTIVE blocks only. Consumed/inactive blocks are already
 *     distilled into the T2/T3 blocks that superseded them.
 *   - Default tier selection = ALL active tiers (T1+T2+T3). A session may have
 *     only T1 blocks; defaulting to T2+T3 (as initially proposed in #40) would
 *     export nothing for those sessions. Users who want only distilled output
 *     can pass `--tier t2,t3`.
 *   - Default output path = {cwd}/.opencode/acp-export-{shortSessionId}.md.
 *   - `--output -` streams the markdown back to chat instead of writing a file.
 *   - Zero new dependencies — pure fs/promises I/O.
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { dirname, isAbsolute, join, resolve } from "path"
import type { Logger } from "../logger"
import type { PluginConfig } from "../config"
import type {
    CompressionBlock,
    CompressionTier,
    SessionState,
    WithParts,
} from "../state/types"
import { sendIgnoredMessage } from "../ui/notification"

const ALL_TIERS: CompressionTier[] = [1, 2, 3]

const TIER_NAMES: Record<number, string> = {
    1: "Tier 1 — Capture",
    2: "Tier 2 — Distilled",
    3: "Tier 3 — Condensed",
}

export interface ExportCommandContext {
    client: any
    state: SessionState
    config: PluginConfig
    logger: Logger
    sessionId: string
    messages: WithParts[]
    workingDirectory: string
}

export interface ExportOptions {
    /** Resolved output path. `"-"` means stream to chat (stdout equivalent). */
    outputPath: string
    /** Which tiers to include. Empty set = include all. */
    tiers: Set<CompressionTier>
    includeMetadata: boolean
    append: boolean
}

/** @internal exported for tests */
export function parseExportArgs(rawArgs: string): ExportOptions {
    const options: ExportOptions = {
        outputPath: "", // "" sentinel => default path resolved later
        tiers: new Set<CompressionTier>(),
        includeMetadata: true,
        append: false,
    }

    const tokens = tokenize(rawArgs)
    let i = 0
    while (i < tokens.length) {
        const tok = tokens[i]
        const [flag, inlineValue] = splitFlag(tok)

        switch (flag) {
            case "--output":
            case "-o": {
                const value = inlineValue ?? tokens[i + 1]
                if (value === undefined) {
                    throw new Error("--output requires a path (use `-` for stdout)")
                }
                options.outputPath = value
                i += inlineValue !== undefined ? 1 : 2
                break
            }
            case "--tier":
            case "-t": {
                const value = inlineValue ?? tokens[i + 1]
                if (value === undefined) {
                    throw new Error("--tier requires a value (e.g. t2,t3 or all)")
                }
                options.tiers = parseTiers(value)
                i += inlineValue !== undefined ? 1 : 2
                break
            }
            case "--no-metadata":
                if (inlineValue !== undefined) {
                    throw new Error("--no-metadata does not take a value")
                }
                options.includeMetadata = false
                i += 1
                break
            case "--metadata":
                if (inlineValue !== undefined) {
                    throw new Error("--metadata does not take a value")
                }
                options.includeMetadata = true
                i += 1
                break
            case "--append":
                if (inlineValue !== undefined) {
                    throw new Error("--append does not take a value")
                }
                options.append = true
                i += 1
                break
            case "--stdout":
                if (inlineValue !== undefined) {
                    throw new Error("--stdout does not take a value")
                }
                options.outputPath = "-"
                i += 1
                break
            default:
                throw new Error(
                    `Unknown flag: ${tok}. Supported: --output, --tier, --no-metadata, --append, --stdout.`,
                )
        }
    }

    return options
}

function tokenize(input: string): string[] {
    const tokens: string[] = []
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
        tokens.push(m[1] ?? m[2] ?? m[3])
    }
    return tokens
}

function splitFlag(tok: string): [string, string | undefined] {
    const eq = tok.indexOf("=")
    if (eq === -1) return [tok, undefined]
    return [tok.slice(0, eq), tok.slice(eq + 1)]
}

/** @internal exported for tests */
export function parseTiers(raw: string): Set<CompressionTier> {
    const lower = raw.trim().toLowerCase()
    if (lower === "all") return new Set<CompressionTier>(ALL_TIERS)

    const parts = lower
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0)

    const result = new Set<CompressionTier>()
    for (const part of parts) {
        const digits = part.replace(/^t/i, "")
        const n = Number(digits)
        if (!Number.isInteger(n) || n < 1 || n > 3) {
            throw new Error(
                `Invalid tier "${part}". Expected t1, t2, t3, a combination (t2,t3), or "all".`,
            )
        }
        result.add(n as CompressionTier)
    }
    if (result.size === 0) {
        throw new Error(`Invalid tier "${raw}". Expected t1, t2, t3, or "all".`)
    }
    return result
}

/** @internal exported for tests */
export function resolveDefaultOutputPath(sessionId: string, cwd: string): string {
    const short = (sessionId || "session").slice(0, 8)
    return join(cwd, ".opencode", `acp-export-${short}.md`)
}

interface FormattedTokenSpan {
    effective: number
    summary: number
}

function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return "0"
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

function effectiveTokens(block: CompressionBlock): number {
    return block.effectiveCompressedTokens ?? block.compressedTokens ?? 0
}

function collectActiveBlocks(state: SessionState): CompressionBlock[] {
    const msgState = state.prune.messages
    const blocks: CompressionBlock[] = []
    for (const id of msgState.activeBlockIds) {
        const block = msgState.blocksById.get(id)
        if (block && block.active) {
            blocks.push(block)
        }
    }
    return blocks
}

function filterByTier(
    blocks: CompressionBlock[],
    tiers: Set<CompressionTier>,
): CompressionBlock[] {
    if (tiers.size === 0) return blocks
    return blocks.filter((b) => tiers.has((b.tier ?? 1) as CompressionTier))
}

function tokenSpans(blocks: CompressionBlock[]): FormattedTokenSpan {
    return {
        effective: blocks.reduce((s, b) => s + effectiveTokens(b), 0),
        summary: blocks.reduce((s, b) => s + (b.summaryTokens || 0), 0),
    }
}

function tierCounts(blocks: CompressionBlock[]): string {
    const counts: Record<number, number> = {}
    for (const b of blocks) {
        const t = (b.tier ?? 1) as CompressionTier
        counts[t] = (counts[t] || 0) + 1
    }
    return ALL_TIERS.filter((t) => counts[t])
        .map((t) => `T${t}: ${counts[t]}`)
        .join(", ")
}

/**
 * Render the export markdown. Pure function — no I/O. Exported for testing.
 */
export function renderExportMarkdown(params: {
    sessionId: string
    generatedAt: Date
    blocks: CompressionBlock[]
    tiers: Set<CompressionTier>
    includeMetadata: boolean
}): string {
    const { sessionId, generatedAt, blocks, tiers, includeMetadata } = params
    const out: string[] = []

    const tierFilterLabel =
        tiers.size === 0 ? "all" : ALL_TIERS.filter((t) => tiers.has(t)).map((t) => `T${t}`).join(", ")

    out.push("# ACP Session Export")
    out.push("")
    out.push(`- **Session**: \`${(sessionId || "unknown").slice(0, 16)}\``)
    out.push(`- **Generated**: ${generatedAt.toISOString()}`)
    out.push(`- **Blocks exported**: ${blocks.length}`)
    const breakdown = tierCounts(blocks)
    if (breakdown) {
        out.push(`  - ${breakdown}`)
    }
    out.push(`- **Tiers**: ${tierFilterLabel}`)
    const span = tokenSpans(blocks)
    if (blocks.length > 0) {
        out.push(
            `- **Coverage**: ${formatTokens(span.effective)} original → ${formatTokens(span.summary)} summary`,
        )
    }
    out.push("")
    out.push("---")
    out.push("")

    if (blocks.length === 0) {
        out.push("_No active compression blocks match the selected tiers._")
        out.push("")
        out.push(
            "Tip: run `/acp export --tier all` to include every active tier, or trigger a compression first.",
        )
        return out.join("\n")
    }

    for (const tier of [3, 2, 1] as CompressionTier[]) {
        const tierBlocks = blocks
            .filter((b) => (b.tier ?? 1) === tier)
            .sort((a, b) => a.blockId - b.blockId)
        if (tierBlocks.length === 0) continue

        out.push(`## ${TIER_NAMES[tier]}`)
        out.push("")

        for (const block of tierBlocks) {
            const topic = block.topic || block.batchTopic || "(no topic)"
            out.push(`### b${block.blockId} — ${topic}`)
            out.push("")

            if (includeMetadata) {
                const mode = block.mode ?? "range"
                const msgCount = block.effectiveMessageIds?.length ?? 0
                const created = new Date(block.createdAt).toISOString()
                const age = block.survivedCount ?? 0
                out.push(`- **Tier**: T${tier} · **Mode**: ${mode}`)
                out.push(`- **Messages**: ${msgCount} (effective)`)
                out.push(
                    `- **Tokens**: ${formatTokens(effectiveTokens(block))} → ${formatTokens(block.summaryTokens || 0)} summary`,
                )
                out.push(`- **Created**: ${created}`)
                out.push(`- **Age**: survived ${age} transform${age === 1 ? "" : "s"}`)
                out.push("")
            }

            const summary = (block.summary || "").trim() || "_(empty summary)_"
            out.push(summary)
            out.push("")
            out.push("---")
            out.push("")
        }
    }

    return out.join("\n")
}

/**
 * Main handler invoked by the command hook.
 * @param args raw argument string following `/acp export` (may be empty).
 */
export async function handleExportCommand(
    ctx: ExportCommandContext,
    args: string,
): Promise<void> {
    const { client, state, logger, sessionId } = ctx

    let options: ExportOptions
    try {
        options = parseExportArgs(args)
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        logger.warn("export: argument parse failed", { error: msg, args })
        await sendExportNotice(client, sessionId, ctx, `[ACP Export] ${msg}`)
        return
    }

    const tiers = options.tiers

    const allActive = collectActiveBlocks(state)
    const blocks = filterByTier(allActive, tiers)

    const generatedAt = new Date()
    const markdown = renderExportMarkdown({
        sessionId,
        generatedAt,
        blocks,
        tiers,
        includeMetadata: options.includeMetadata,
    })

    // Stream-to-chat mode: `--output -` or `--stdout`.
    if (options.outputPath === "-") {
        await sendExportNotice(client, sessionId, ctx, markdown)
        return
    }

    const cwd = ctx.workingDirectory || process.cwd()
    const targetPath =
        options.outputPath !== ""
            ? isAbsolute(options.outputPath)
                ? options.outputPath
                : resolve(cwd, options.outputPath)
            : resolveDefaultOutputPath(sessionId, cwd)

    try {
        const dir = dirname(targetPath)
        if (!existsSync(dir)) {
            await fs.mkdir(dir, { recursive: true })
        }
        const flag = options.append ? "a" : "w"
        if (options.append && existsSync(targetPath)) {
            // Separate repeated exports with a clear boundary.
            await fs.appendFile(targetPath, `\n\n---\n\n${markdown}`, "utf-8")
        } else {
            await fs.writeFile(targetPath, markdown, { flag, encoding: "utf-8" })
        }
    } catch (err: any) {
        const msg = err?.message ?? String(err)
        logger.warn("export: file write failed", { path: targetPath, error: msg })
        await sendExportNotice(
            client,
            sessionId,
            ctx,
            `[ACP Export] Failed to write \`${targetPath}\`: ${msg}`,
        )
        return
    }

    logger.info("export: wrote markdown", {
        path: targetPath,
        blocks: blocks.length,
        tiers: tiers.size ? [...tiers].sort().join(",") : "all",
    })

    const summary = formatExportSummary(targetPath, blocks, allActive, generatedAt)
    await sendExportNotice(client, sessionId, ctx, summary)
}

function formatExportSummary(
    path: string,
    exported: CompressionBlock[],
    allActive: CompressionBlock[],
    generatedAt: Date,
): string {
    const lines: string[] = []
    lines.push("[ACP Export]")
    lines.push(`Wrote ${exported.length} block${exported.length === 1 ? "" : "s"} to:`)
    lines.push(`  ${path}`)
    if (exported.length === 0) {
        lines.push("")
        lines.push(
            `No matching blocks (of ${allActive.length} active). Try \`/acp export --tier all\`.`,
        )
    } else {
        lines.push("")
        lines.push(`Generated ${generatedAt.toISOString()}.`)
        lines.push(
            "Review, edit, and commit as a devlog / AGENTS.md supplement — export is user-driven, never auto-injected.",
        )
    }
    return lines.join("\n")
}

async function sendExportNotice(
    client: any,
    sessionId: string,
    ctx: ExportCommandContext,
    text: string,
): Promise<void> {
    await sendIgnoredMessage(client, sessionId, text, {}, ctx.logger)
}
