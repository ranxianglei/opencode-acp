export type PermissionAction = "ask" | "allow" | "deny"

export type PermissionValue = PermissionAction | Record<string, PermissionAction>

export type PermissionConfig = Record<string, PermissionValue> | undefined

/** The ordered rule shape exposed by OpenCode V2 AgentInfo.permissions. */
export interface HostPermissionRule {
    action: string
    resource: string
    effect: PermissionAction
}

export interface HostPermissionSnapshot {
    global: PermissionConfig
    agents: Record<string, PermissionConfig>
    /**
     * V2 keeps the original ordered rules alongside the legacy object view.
     * Object grouping cannot preserve cross-action last-match semantics.
     */
    v2Agents?: Record<string, readonly HostPermissionRule[]>
}

type PermissionRule = {
    permission: string
    pattern: string
    action: PermissionAction
}

const findLastMatchingRule = (
    rules: PermissionRule[],
    predicate: (rule: PermissionRule) => boolean,
): PermissionRule | undefined => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]
        if (rule && predicate(rule)) {
            return rule
        }
    }

    return undefined
}

const wildcardMatch = (value: string, pattern: string): boolean => {
    const normalizedValue = value.replaceAll("\\", "/")
    let escaped = pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")

    if (escaped.endsWith(" .*")) {
        escaped = escaped.slice(0, -3) + "( .*)?"
    }

    const flags = process.platform === "win32" ? "si" : "s"
    return new RegExp(`^${escaped}$`, flags).test(normalizedValue)
}

/** Match an OpenCode V2 action using its ordered last-match semantics. */
export const resolveV2Permission = (
    rules: readonly HostPermissionRule[],
    action: string,
    resource = "*",
): PermissionAction | undefined => {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index]
        if (rule && wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
            return rule.effect
        }
    }
    return undefined
}

const getPermissionRules = (permissionConfigs: PermissionConfig[]): PermissionRule[] => {
    const rules: PermissionRule[] = []
    for (const permissionConfig of permissionConfigs) {
        if (!permissionConfig) {
            continue
        }

        for (const [permission, value] of Object.entries(permissionConfig)) {
            if (value === "ask" || value === "allow" || value === "deny") {
                rules.push({ permission, pattern: "*", action: value })
                continue
            }

            for (const [pattern, action] of Object.entries(value)) {
                if (action === "ask" || action === "allow" || action === "deny") {
                    rules.push({ permission, pattern, action })
                }
            }
        }
    }
    return rules
}

export const compressDisabledByOpencode = (...permissionConfigs: PermissionConfig[]): boolean => {
    const match = findLastMatchingRule(getPermissionRules(permissionConfigs), (rule) =>
        wildcardMatch("compress", rule.permission),
    )

    return match?.pattern === "*" && match.action === "deny"
}

/**
 * Resolve the effective ACP permission for one tool.
 *
 * `toolName` is only consulted on the V2 branch, where ordered agent rules
 * match by real tool name (`compress`, `decompress`, `search_context`,
 * `acp_status`, `acp_context_recap`). It defaults to `"compress"` for the
 * compress-specific callers (nudge gating); the legacy V1 branch stays keyed
 * to the `compress` permission entry because V1 host configs have no
 * per-tool entries for ACP tools.
 */
export const resolveEffectiveCompressPermission = (
    basePermission: PermissionAction,
    hostPermissions: HostPermissionSnapshot,
    agentName?: string,
    toolName: string = "compress",
): PermissionAction => {
    if (basePermission === "deny") {
        return "deny"
    }

    const v2Rules = agentName ? hostPermissions.v2Agents?.[agentName] : undefined
    if (v2Rules) {
        const permission = resolveV2Permission(v2Rules, toolName)
        return permission ?? basePermission
    }

    return compressDisabledByOpencode(
        hostPermissions.global,
        agentName ? hostPermissions.agents[agentName] : undefined,
    )
        ? "deny"
        : basePermission
}

export const hasExplicitToolPermission = (
    permissionConfig: PermissionConfig,
    tool: string,
): boolean => {
    return permissionConfig ? Object.prototype.hasOwnProperty.call(permissionConfig, tool) : false
}
