import * as fsp from "fs/promises"
import { homedir, tmpdir } from "os"
import { dirname, join, relative, resolve } from "path"

export type ToFileTargetResult = { ok: true; filePath: string } | { ok: false; error: string }

/**
 * Validate a `decompress` `toFile` target against the allowed directories.
 *
 * Three layers, fail-closed:
 * 1. Lexical containment of the resolved path (rejects `..` traversal).
 * 2. Physical containment: symlinks in intermediate components are resolved
 *    by realpath-ing the deepest existing ancestor, so a link inside an
 *    allowed root cannot point the write outside it.
 * 3. An existing symlink at the final component is refused outright; the
 *    caller must additionally open with O_NOFOLLOW (POSIX) to close the
 *    check-then-write window.
 */
export async function resolveSafeToFileTarget(
    targetPath: string,
    options?: { allowedDirs?: string[] },
): Promise<ToFileTargetResult> {
    const osTmp = tmpdir()
    const allowedDirs = options?.allowedDirs ?? [osTmp, join(homedir(), ".cache", "opencode")]
    const dirList = allowedDirs.join(" or ")

    if (typeof targetPath !== "string" || targetPath.length === 0) {
        return {
            ok: false,
            error: `Error: toFile path must be under ${dirList}. Got: ${targetPath}`,
        }
    }

    const resolvedPath = resolve(targetPath)

    const lexicallyAllowed = allowedDirs.some((dir) => {
        const rel = relative(resolve(dir), resolvedPath)
        return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !isWinAbsolute(rel))
    })
    if (!lexicallyAllowed) {
        return {
            ok: false,
            error: `Error: toFile path must be under ${dirList}. Got: ${targetPath}`,
        }
    }

    // Deepest existing ancestor: walk up past missing tail components, since
    // realpath fails on paths that do not exist yet.
    let realAncestor: string | null = null
    const tail: string[] = []
    let current = resolvedPath
    while (true) {
        try {
            realAncestor = await fsp.realpath(current)
            break
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                return {
                    ok: false,
                    error: `Error: cannot validate toFile path: ${(err as Error).message}`,
                }
            }
            const parent = dirname(current)
            if (parent === current) {
                return {
                    ok: false,
                    error: `Error: cannot validate toFile path: no existing ancestor found`,
                }
            }
            tail.unshift(basename(current))
            current = parent
        }
    }
    const physicalPath = tail.length > 0 ? join(realAncestor!, ...tail) : realAncestor!

    // Compare against physical allowed roots; a root that does not exist yet
    // cannot contain anything anyway (the write fails at open time).
    const realAllowedDirs: string[] = []
    for (const dir of allowedDirs) {
        try {
            realAllowedDirs.push(await fsp.realpath(resolve(dir)))
        } catch {
            // Root missing — nothing to compare against.
        }
    }
    const physicallyAllowed =
        realAllowedDirs.every((dir) => !containsOrIs(join(dir), physicalPath) === false) &&
        realAllowedDirs.some((dir) => containsOrIs(join(dir), physicalPath))
    if (!physicallyAllowed) {
        return {
            ok: false,
            error: `Error: toFile path resolves outside the allowed directories via a symlink. Got: ${targetPath}`,
        }
    }

    try {
        const stat = await fsp.lstat(resolvedPath)
        if (stat.isSymbolicLink()) {
            return {
                ok: false,
                error: `Error: toFile target exists as a symlink and will not be followed. Got: ${targetPath}`,
            }
        }
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ENOENT") {
            return {
                ok: false,
                error: `Error: cannot validate toFile path: ${(err as Error).message}`,
            }
        }
    }

    return { ok: true, filePath: resolvedPath }
}

function isWinAbsolute(p: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(p)
}

function basename(p: string): string {
    return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function containsOrIs(root: string, p: string): boolean {
    const rel = relative(root, p)
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !isWinAbsolute(rel))
}
