export type PermissionAction = "ask" | "allow" | "deny"

export type PermissionValue = PermissionAction | Record<string, PermissionAction>

export type PermissionConfig = Record<string, PermissionValue> | undefined

export interface HostPermissionSnapshot {
    global: PermissionConfig
    agents: Record<string, PermissionConfig>
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

export const resolveEffectiveCompressPermission = (
    basePermission: PermissionAction,
    hostPermissions: HostPermissionSnapshot,
    agentName?: string,
): PermissionAction => {
    if (basePermission === "deny") {
        return "deny"
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
