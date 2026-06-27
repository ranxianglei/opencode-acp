function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    )
}

function mergeInto(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
): Record<string, unknown> {
    for (const [key, srcValue] of Object.entries(source)) {
        if (srcValue === undefined) {
            continue
        }

        const tgtValue = target[key]

        if (isPlainObject(srcValue) && isPlainObject(tgtValue)) {
            target[key] = mergeInto({ ...tgtValue }, srcValue)
        } else {
            target[key] = srcValue
        }
    }
    return target
}

/**
 * Deep-merge config objects. Objects merge recursively; arrays and primitives
 * override. `undefined` values in a layer never overwrite a defined value below.
 *
 * Later layers take precedence over earlier ones; `base` is the lowest.
 */
export function mergeConfigs(
    base: Record<string, unknown>,
    ...layers: Record<string, unknown>[]
): Record<string, unknown> {
    let acc: Record<string, unknown> = isPlainObject(base) ? { ...base } : {}
    for (const layer of layers) {
        if (!isPlainObject(layer)) {
            continue
        }
        acc = mergeInto(acc, layer)
    }
    return acc
}
