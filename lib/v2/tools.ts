import type { Plugin as V2Api } from "@opencode/plugin"
import type {
    Info as V2ToolInfo,
    Result as V2ToolResult,
    ToolContext as V2ToolContext,
} from "@opencode/plugin/promise/tool"
import type {
    AnyToolSchema,
    SharedToolDefinition,
    ToolExecutionContext,
    ToolFactoryContext,
} from "../compress"
import {
    createAcpContextRecapToolDefinition,
    createAcpStatusToolDefinition,
    createCompressRangeToolDefinition,
    createDecompressToolDefinition,
    createSearchContextToolDefinition,
} from "../compress"
import {
    resolveEffectiveCompressPermission,
    type HostPermissionSnapshot,
} from "../host-permissions"
import type { V2HostAdapter } from "./host"
import type { V2OperationTracker } from "./lifecycle"

type V2Context = Parameters<V2Api.Plugin["setup"]>[0]
export type V2ToolEditor = Parameters<Parameters<V2Context["tool"]["transform"]>[0]>[0]

export const V2_ACP_TOOL_NAMES = [
    "compress",
    "decompress",
    "search_context",
    "acp_status",
    "acp_context_recap",
] as const

type V2ToolContent = Exclude<NonNullable<V2ToolResult["content"]>, string>[number]

const permissionAskMessage = (toolName: string) =>
    `ACP cannot request an interactive permission on OpenCode V2.0.3. Set the active agent's \`${toolName}\` permission to \`allow\` or \`deny\`, then retry.`
const permissionDenyMessage = (toolName: string) =>
    `ACP tool execution is disabled by the active agent or ACP configuration. Choose \`allow\` for the \`${toolName}\` permission to enable it.`
const SUBAGENT_DENY_MESSAGE =
    "ACP direct tools are disabled for child sessions when `allowSubAgents` is false."
const LIFECYCLE_DENY_MESSAGE = "ACP is shutting down; this operation was not executed."

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function errorResult(message: string, metadata: Record<string, unknown>): V2ToolResult {
    return { content: message, metadata }
}

function resultMetadata(
    title: string | undefined,
    metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!title && !metadata) return undefined
    return {
        ...(metadata ?? {}),
        ...(title ? { title } : {}),
    }
}

function toV2Result(result: Awaited<ReturnType<SharedToolDefinition["execute"]>>): V2ToolResult {
    if (typeof result === "string") return { content: result }

    const metadata = resultMetadata(result.title, result.metadata)
    if (!result.attachments || result.attachments.length === 0) {
        return {
            content: result.output,
            ...(metadata ? { metadata } : {}),
        }
    }

    const content: V2ToolContent[] = [
        { type: "text", text: result.output },
        ...result.attachments.map((attachment) => ({
            type: "file" as const,
            uri: attachment.url,
            mime: attachment.mime,
            ...(attachment.filename ? { name: attachment.filename } : {}),
        })),
    ]
    return {
        content,
        ...(metadata ? { metadata } : {}),
    }
}

async function resolveToolPermission(
    factoryCtx: ToolFactoryContext,
    host: V2HostAdapter,
    hostPermissions: HostPermissionSnapshot,
    context: V2ToolContext,
    toolName: string,
    isActive: () => boolean = () => true,
): Promise<"ask" | "allow" | "deny"> {
    const basePermission = factoryCtx.config.compress.permission
    if (basePermission === "deny") {
        return "deny"
    }

    if (!host.agentPermissions) {
        return resolveEffectiveCompressPermission(
            basePermission,
            hostPermissions,
            context.agent,
            toolName,
        )
    }

    try {
        const rules = await host.agentPermissions(context.agent)
        if (!isActive()) return "deny"
        hostPermissions.v2Agents = {
            ...(hostPermissions.v2Agents ?? {}),
            [context.agent]: rules,
        }
        return resolveEffectiveCompressPermission(
            basePermission,
            hostPermissions,
            context.agent,
            toolName,
        )
    } catch {
        // V2 has no supported permission-request fallback. Unknown policy is
        // therefore denied before the shared definition or session guard runs.
        if (!isActive()) return "deny"
        hostPermissions.v2Agents = {
            ...(hostPermissions.v2Agents ?? {}),
            [context.agent]: [{ action: "*", resource: "*", effect: "deny" }],
        }
        return "deny"
    }
}

async function resolveSubAgentPermission(
    config: ToolFactoryContext["config"],
    host: V2HostAdapter,
    sessionID: string,
): Promise<{ allowed: true } | { allowed: false; message: string }> {
    if (config.allowSubAgents !== false) return { allowed: true }
    try {
        const session = await host.sessions.get(sessionID)
        if (!session) return { allowed: false, message: SUBAGENT_DENY_MESSAGE }
        if (session.parentID !== undefined && session.parentID !== null) {
            return { allowed: false, message: SUBAGENT_DENY_MESSAGE }
        }
        return { allowed: true }
    } catch {
        // A failed parent lookup is ambiguous and must not be used to bypass
        // the child-session restriction.
        return {
            allowed: false,
            message: "ACP could not verify the session parent; direct tool execution was blocked.",
        }
    }
}

function toSharedContext(
    context: V2ToolContext,
    permission: "ask" | "allow" | "deny",
    progressTasks: Promise<void>[],
    isActive: () => boolean = () => true,
): ToolExecutionContext {
    const progress = (update: {
        title?: string
        status?: string
        metadata?: Record<string, unknown>
    }) => {
        if (!isActive()) return
        const task = context.progress({
            ...(update.metadata ?? {}),
            ...(update.title ? { title: update.title } : {}),
            ...(update.status ? { status: update.status } : {}),
        })
        progressTasks.push(task)
        return task
    }

    return {
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: context.id,
        agent: context.agent,
        permission,
        ask: async () => {},
        metadata: (input) => {
            progress({ ...input })
        },
        progress,
        isActive,
    }
}

/**
 * Adapt a shared ACP definition to the Promise V2 direct-tool contract.
 * The adapter catches schema and execution failures because Promise tool
 * callbacks are lifted with Effect.promise in @opencode/plugin 2.0.3.
 */
export function createV2Tool<Schema extends AnyToolSchema>(
    definition: SharedToolDefinition<Schema>,
    factoryCtx: ToolFactoryContext,
    host: V2HostAdapter,
    hostPermissions: HostPermissionSnapshot,
    isEnabled: () => boolean = () => true,
    operations?: V2OperationTracker,
): V2ToolInfo {
    return {
        name: definition.name,
        description: definition.description,
        input: definition.schema,
        options: { codemode: false, permission: definition.name },
        execute: async (rawInput, context) => {
            const executeBody = async (isActive: () => boolean = () => true) => {
                if (!isActive())
                    return errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })
                if (!isEnabled()) {
                    return errorResult(
                        "ACP is currently disabled because a /bili/ proxy is active.",
                        {
                            acpDisabled: true,
                            reason: "bili-proxy",
                        },
                    )
                }

                const subAgent = await resolveSubAgentPermission(
                    factoryCtx.config,
                    host,
                    context.sessionID,
                )
                if (!subAgent.allowed) {
                    return errorResult(subAgent.message, {
                        acpPermission: "deny",
                        acpSubAgent: "deny",
                    })
                }
                if (!isActive())
                    return errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })

                let permissionResult: "ask" | "allow" | "deny"
                try {
                    permissionResult = await resolveToolPermission(
                        factoryCtx,
                        host,
                        hostPermissions,
                        context,
                        definition.name,
                        isActive,
                    )
                } catch (error) {
                    return errorResult(
                        "ACP could not resolve the active agent permission; execution was blocked.",
                        {
                            acpPermission: "deny",
                            permission: definition.name,
                            actionable: "choose allow or deny",
                            error: errorMessage(error),
                        },
                    )
                }
                if (!isActive())
                    return errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })
                if (permissionResult === "deny") {
                    return errorResult(permissionDenyMessage(definition.name), {
                        acpPermission: "deny",
                        permission: definition.name,
                        actionable: "choose allow or deny",
                    })
                }
                if (permissionResult === "ask") {
                    return errorResult(permissionAskMessage(definition.name), {
                        acpPermission: "ask",
                        permission: definition.name,
                        actionable: "choose allow or deny",
                    })
                }

                const progressTasks: Promise<void>[] = []
                try {
                    const parsed = definition.schema.safeParse(rawInput)
                    if (!parsed.success) {
                        return errorResult(
                            `Invalid ${definition.name} input: ${parsed.error.message}`,
                            {
                                acpError: "invalid-input",
                                tool: definition.name,
                            },
                        )
                    }
                    const result = await definition.execute(
                        parsed.data,
                        toSharedContext(context, "allow", progressTasks, isActive),
                    )
                    if (progressTasks.length > 0) await Promise.allSettled(progressTasks)
                    if (!isActive()) {
                        return errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })
                    }
                    return toV2Result(result)
                } catch (error) {
                    if (progressTasks.length > 0) await Promise.allSettled(progressTasks)
                    if (!isActive()) {
                        return errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })
                    }
                    return errorResult(`ACP ${definition.name} failed: ${errorMessage(error)}`, {
                        acpError: "execution",
                        tool: definition.name,
                    })
                }
            }

            if (operations) {
                const result = await operations.run("tool", (lease) => executeBody(lease.isActive))
                return result ?? errorResult(LIFECYCLE_DENY_MESSAGE, { acpError: "inactive" })
            }
            return executeBody()
        },
    }
}

/** Add all five ACP tools to one replayable V2 transform. */
export function createV2ToolTransform(
    factoryCtx: ToolFactoryContext,
    host: V2HostAdapter,
    hostPermissions: HostPermissionSnapshot,
    isEnabled: () => boolean = () => true,
    operations?: V2OperationTracker,
): (editor: V2ToolEditor) => void {
    return (editor) => {
        if (!isEnabled() || factoryCtx.config.compress.permission === "deny") return

        editor.add(
            createV2Tool(
                createCompressRangeToolDefinition(factoryCtx),
                factoryCtx,
                host,
                hostPermissions,
                isEnabled,
                operations,
            ),
        )
        editor.add(
            createV2Tool(
                createDecompressToolDefinition(factoryCtx),
                factoryCtx,
                host,
                hostPermissions,
                isEnabled,
                operations,
            ),
        )
        editor.add(
            createV2Tool(
                createSearchContextToolDefinition(factoryCtx),
                factoryCtx,
                host,
                hostPermissions,
                isEnabled,
                operations,
            ),
        )
        editor.add(
            createV2Tool(
                createAcpStatusToolDefinition(factoryCtx),
                factoryCtx,
                host,
                hostPermissions,
                isEnabled,
                operations,
            ),
        )
        editor.add(
            createV2Tool(
                createAcpContextRecapToolDefinition(factoryCtx),
                factoryCtx,
                host,
                hostPermissions,
                isEnabled,
                operations,
            ),
        )
    }
}
