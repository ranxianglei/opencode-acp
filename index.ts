import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import {
    createAcpStatusTool,
    createAcpContextRecapTool,
    createCompressRangeTool,
    createDecompressTool,
    createSearchContextTool,
} from "./lib/compress"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { SessionStateRegistry } from "./lib/state"
import { PromptStore } from "./lib/prompts/store"
import {
    createChatMessageTransformHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createSystemPromptHandler,
    createTextCompleteHandler,
} from "./lib/hooks"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const registry = new SessionStateRegistry(logger)
    const prompts = new PromptStore(logger, ctx.directory, config.experimental.customPrompts)
    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
        // logger.info("Secure mode detected, configured client authentication")
    }

    // [FIX #312] Seed the model-limit catalog so the FIRST request after a
    // model switch resolves the new model's context window (the per-request
    // system.transform refresh only fills entries for models already used in
    // this instance). Fire-and-forget — never blocks init; outcome is logged
    // so a silent degrade (empty catalog / failed fetch) is debuggable. On
    // failure the fallback is per-request refresh, the pre-fix behavior.
    registry.hydrateModelLimitsFromClient(ctx.client).then(
        (recorded) => {
            if (recorded > 0) {
                logger.info("Model limit catalog seeded from provider config", {
                    models: recorded,
                })
            } else {
                logger.warn(
                    "Model limit catalog seeding recorded no entries — " +
                        "falling back to per-request refresh (system.transform)",
                )
            }
        },
        (error) => {
            logger.warn(
                "Model limit catalog seeding failed — " +
                    "falling back to per-request refresh (system.transform)",
                { error: error instanceof Error ? error.message : String(error) },
            )
        },
    )

    logger.info("DCP initialized")

    startAutoUpdate(ctx, config.autoUpdate)

    const compressToolContext = {
        client: ctx.client,
        registry,
        logger,
        config,
        prompts,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(
            registry,
            logger,
            config,
            prompts,
        ),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            registry,
            logger,
            config,
            prompts,
            hostPermissions,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(
            ctx.client,
            registry,
            logger,
            config,
            ctx.directory,
            hostPermissions,
        ),
        event: createEventHandler(registry, logger),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress: createCompressRangeTool(compressToolContext),
                decompress: createDecompressTool(compressToolContext),
                search_context: createSearchContextTool(compressToolContext),
                acp_status: createAcpStatusTool(compressToolContext),
                acp_context_recap: createAcpContextRecapTool(compressToolContext),
            }),
        },
        config: async (opencodeConfig) => {
            if (
                config.compress.permission !== "deny" &&
                compressDisabledByOpencode(opencodeConfig.permission)
            ) {
                config.compress.permission = "deny"
            }

            if (config.commands.enabled && config.compress.permission !== "deny") {
                opencodeConfig.command ??= {}
                opencodeConfig.command["acp"] = {
                    template: "",
                    description: "Show available ACP commands",
                }
            }

            const toolsToAdd: string[] = []
            if (config.compress.permission !== "deny" && !config.allowSubAgents) {
                toolsToAdd.push("compress", "decompress", "search_context", "acp_status")
            }

            if (toolsToAdd.length > 0) {
                const existingPrimaryTools = opencodeConfig.experimental?.primary_tools ?? []
                opencodeConfig.experimental = {
                    ...opencodeConfig.experimental,
                    primary_tools: [...existingPrimaryTools, ...toolsToAdd],
                }
            }

            if (!hasExplicitToolPermission(opencodeConfig.permission, "compress")) {
                const permission = opencodeConfig.permission ?? {}
                opencodeConfig.permission = {
                    ...permission,
                    compress: config.compress.permission,
                    acp_status: "allow",
                } as typeof permission
            }

            hostPermissions.global = opencodeConfig.permission
            hostPermissions.agents = Object.fromEntries(
                Object.entries(opencodeConfig.agent ?? {}).map(([name, agent]) => [
                    name,
                    agent?.permission,
                ]),
            )
        },
    }
}) satisfies Plugin

export default server
