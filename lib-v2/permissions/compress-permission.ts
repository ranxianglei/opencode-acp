import type { PluginConfig } from "../config/types"
import type { SessionState, WithParts } from "../state/types"
import { type HostPermissionSnapshot, resolveEffectiveCompressPermission } from "./host-permissions"

export type CompressPermissionAction = "ask" | "allow" | "deny"

export const compressPermission = (
    state: SessionState,
    config: PluginConfig,
): CompressPermissionAction => {
    return state.compressPermission ?? config.compress.permission
}

// Skip synthetic ACP/DCP summary messages (msg_dcp_* ids — internal naming, §2.6).
function getActiveAgent(messages: WithParts[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        const id = msg?.info?.id
        if (!id || typeof id !== "string") {
            continue
        }
        if (msg.info.role !== "user") {
            continue
        }
        if (id.startsWith("msg_dcp_summary_") || id.startsWith("msg_dcp_text_")) {
            continue
        }
        return msg.info.agent
    }
    return undefined
}

export const syncCompressPermissionState = (
    state: SessionState,
    config: PluginConfig,
    hostPermissions: HostPermissionSnapshot,
    messages: WithParts[],
): void => {
    const activeAgent = getActiveAgent(messages)
    state.compressPermission = resolveEffectiveCompressPermission(
        config.compress.permission,
        hostPermissions,
        activeAgent,
    )
}
