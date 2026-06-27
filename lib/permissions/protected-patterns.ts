function normalizePath(input: string): string {
    return input.replaceAll("\\\\", "/")
}

function escapeRegExpChar(ch: string): string {
    return /[\\.^$+{}()|\[\]]/.test(ch) ? `\\${ch}` : ch
}

export function matchesGlob(inputPath: string, pattern: string): boolean {
    if (!pattern) return false

    const input = normalizePath(inputPath)
    const pat = normalizePath(pattern)

    let regex = "^"

    for (let i = 0; i < pat.length; i++) {
        const ch = pat[i]

        if (ch === "*") {
            const next = pat[i + 1]
            if (next === "*") {
                const after = pat[i + 2]
                if (after === "/") {
                    regex += "(?:.*/)?"
                    i += 2
                    continue
                }

                regex += ".*"
                i++
                continue
            }

            regex += "[^/]*"
            continue
        }

        if (ch === "?") {
            regex += "[^/]"
            continue
        }

        if (ch === "/") {
            regex += "/"
            continue
        }

        regex += escapeRegExpChar(ch)
    }

    regex += "$"

    return new RegExp(regex).test(input)
}

function readStringField(record: Record<string, unknown>, field: string): string | undefined {
    const value = record[field]
    return typeof value === "string" ? value : undefined
}

export function getFilePathsFromParameters(tool: string, parameters: unknown): string[] {
    if (typeof parameters !== "object" || parameters === null) {
        return []
    }

    const paths: string[] = []
    const params = parameters as Record<string, unknown>

    if (tool === "apply_patch") {
        const patchText = readStringField(params, "patchText")
        if (patchText !== undefined) {
            const pathRegex = /\*\*\* (?:Add|Delete|Update) File: ([^\n\r]+)/g
            let match
            while ((match = pathRegex.exec(patchText)) !== null) {
                paths.push(match[1].trim())
            }
        }
    }

    if (tool === "multiedit") {
        const topLevel = readStringField(params, "filePath")
        if (topLevel !== undefined) {
            paths.push(topLevel)
        }
        if (Array.isArray(params.edits)) {
            for (const edit of params.edits) {
                if (edit && typeof edit === "object") {
                    const nested = readStringField(edit as Record<string, unknown>, "filePath")
                    if (nested !== undefined) {
                        paths.push(nested)
                    }
                }
            }
        }
    }

    const defaultPath = readStringField(params, "filePath")
    if (defaultPath !== undefined) {
        paths.push(defaultPath)
    }

    return [...new Set(paths)].filter((p) => p.length > 0)
}

export function isFilePathProtected(filePaths: string[], patterns: string[]): boolean {
    if (!filePaths || filePaths.length === 0) return false
    if (!patterns || patterns.length === 0) return false

    return filePaths.some((path) => patterns.some((pattern) => matchesGlob(path, pattern)))
}

const GLOB_CHARS = /[*?]/

export function isToolNameProtected(toolName: string, patterns: string[]): boolean {
    if (!toolName || !patterns || patterns.length === 0) return false

    const exactPatterns: Set<string> = new Set()
    const globPatterns: string[] = []

    for (const pattern of patterns) {
        if (GLOB_CHARS.test(pattern)) {
            globPatterns.push(pattern)
        } else {
            exactPatterns.add(pattern)
        }
    }

    if (exactPatterns.has(toolName)) {
        return true
    }

    return globPatterns.some((pattern) => matchesGlob(toolName, pattern))
}
