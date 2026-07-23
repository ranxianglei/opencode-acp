import type { Logger } from "../logger"
import type { SessionState } from "../state"
import { sendIgnoredMessage } from "../ui/notification"
import { getCurrentParams } from "../token-utils"
import { listMemories, forgetMemory } from "../memory"

export interface MemoryCommandContext {
    client: any
    state: SessionState
    logger: Logger
    sessionId: string
    messages: any[]
}

export async function handleMemoryCommand(
    ctx: MemoryCommandContext,
    args: string[],
): Promise<void> {
    const { client, state, logger, sessionId, messages } = ctx
    const sub = args[0]?.toLowerCase()

    const params = getCurrentParams(state, messages, logger)

    if (!sub || sub === "list") {
        const entries = listMemories(state)
        const active = entries.filter((e) => !e.forgotten)
        const forgotten = entries.filter((e) => e.forgotten)

        const lines: string[] = ["ACP Memories", "─".repeat(50)]
        if (active.length === 0) {
            lines.push("  (none recorded)")
        } else {
            for (const e of active) {
                lines.push(`  ${e.id} [${e.topic}]`)
            }
        }
        if (forgotten.length > 0) {
            lines.push("", `Forgotten (${forgotten.length}):`)
            for (const e of forgotten) {
                lines.push(`  ${e.id} [${e.topic}] — forgotten`)
            }
        }
        lines.push("", `Total: ${active.length} active, ${forgotten.length} forgotten.`)

        await sendIgnoredMessage(client, sessionId, lines.join("\n"), params, logger)
        return
    }

    if (sub === "forget") {
        const id = args[1]
        if (!id) {
            await sendIgnoredMessage(
                client,
                sessionId,
                "Usage: /acp memory forget <mem_id>",
                params,
                logger,
            )
            return
        }
        const ok = forgetMemory(state, id)
        if (!ok) {
            await sendIgnoredMessage(
                client,
                sessionId,
                `No memory found with id "${id}". Use /acp memory list to see recorded memories.`,
                params,
                logger,
            )
            return
        }
        await sendIgnoredMessage(
            client,
            sessionId,
            `Forgot ${id}. It is no longer protected — the next compression that covers it will consume it.`,
            params,
            logger,
        )
        logger.info("Memory forgotten via command", { id })
        return
    }

    await sendIgnoredMessage(
        client,
        sessionId,
        "Usage: /acp memory [list | forget <mem_id>]",
        params,
        logger,
    )
}
