import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config"
import {
    compressDisabledByOpencode,
    hasExplicitToolPermission,
    type HostPermissionSnapshot,
} from "./lib/host-permissions"
import { Logger } from "./lib/logger"
import { configureClientAuth, isSecureMode } from "./lib/auth"
import { startAutoUpdate } from "./lib/update"
import {
    createCoreRuntime,
    createSessionModelLimits,
    createSystemPromptHandler,
    createChatMessageTransformHandler,
    createTextCompleteHandler,
    createCommandExecuteHandler,
    createEventHandler,
    createCompressTool,
    createDecompressTool,
    createSearchContextTool,
    createAcpStatusTool,
} from "./lib/kernel"

const server: Plugin = (async (ctx) => {
    const config = getConfig(ctx)

    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)

    if (isSecureMode()) {
        configureClientAuth(ctx.client)
    }

    logger.info("ACP (acp-kernel) initialized")

    startAutoUpdate(ctx, config.autoUpdate)

    const runtime = createCoreRuntime()
    const modelLimits = createSessionModelLimits()

    const hostPermissions: HostPermissionSnapshot = {
        global: undefined,
        agents: {},
    }

    const toolContext = {
        client: ctx.client,
        runtime,
        config,
        logger,
        modelLimits,
    }

    return {
        "experimental.chat.system.transform": createSystemPromptHandler(logger, config, modelLimits),
        "experimental.chat.messages.transform": createChatMessageTransformHandler(
            ctx.client,
            runtime,
            logger,
            config,
            modelLimits,
        ) as any,
        "experimental.text.complete": createTextCompleteHandler(),
        "command.execute.before": createCommandExecuteHandler(ctx.client, runtime, logger, config, modelLimits),
        event: createEventHandler(logger),
        tool: {
            ...(config.compress.permission !== "deny" && {
                compress: createCompressTool(toolContext),
                decompress: createDecompressTool(toolContext),
                search_context: createSearchContextTool(toolContext),
                acp_status: createAcpStatusTool(toolContext),
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
