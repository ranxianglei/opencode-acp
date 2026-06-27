const DCP_SCHEMA_PATTERN = /dcp\.schema\.json/i

/**
 * Detect whether a config object originated from a DCP installation and needs
 * migration to ACP.
 *
 * Per AGENTS.md §2.6 the config *structure* is identical between DCP and ACP
 * (internal `dcp` naming is intentionally preserved for backward compat), so
 * the only object-level DCP artifact is a `$schema` URL still pointing at the
 * legacy DCP schema.
 */
export function needsMigration(obj: unknown): boolean {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return false
    }
    const schema = (obj as Record<string, unknown>).$schema
    return typeof schema === "string" && DCP_SCHEMA_PATTERN.test(schema)
}

function deepClone<T>(value: T): T {
    if (typeof structuredClone === "function") {
        return structuredClone(value)
    }
    return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Migrate a DCP config object to ACP form.
 *
 * The field structure is unchanged (§2.6); migration returns a deep clone so the
 * caller cannot mutate the source, and the legacy `$schema` URL is normalized to
 * the ACP schema. Non-migrating inputs pass through untouched.
 */
export function migrateDCPConfig<T extends Record<string, unknown>>(obj: T): T {
    const clone = deepClone(obj)
    if (needsMigration(clone)) {
        const schema = (clone as Record<string, unknown>).$schema
        if (typeof schema === "string") {
            ;(clone as Record<string, unknown>).$schema = schema.replace(
                DCP_SCHEMA_PATTERN,
                "acp.schema.json",
            )
        }
    }
    return clone
}
