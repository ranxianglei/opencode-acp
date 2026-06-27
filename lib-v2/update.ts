import type { Logger } from "./infra/logger"

const PACKAGE_VERSION = "2.0.0"
const NPM_REGISTRY = "https://registry.npmjs.org"
const PACKAGE_NAME = "opencode-acp"

export interface UpdateInfo {
    latestVersion: string | null
    currentVersion: string
    updateAvailable: boolean
}

export async function checkForUpdate(logger: Logger): Promise<UpdateInfo> {
    const currentVersion = PACKAGE_VERSION

    try {
        const response = await fetch(`${NPM_REGISTRY}/${PACKAGE_NAME}/latest`, {
            signal: AbortSignal.timeout(5000),
        })

        if (!response.ok) {
            return { latestVersion: null, currentVersion, updateAvailable: false }
        }

        const data = (await response.json()) as { version?: string }
        const latestVersion = data.version ?? null

        if (!latestVersion) {
            return { latestVersion: null, currentVersion, updateAvailable: false }
        }

        const updateAvailable = compareVersions(latestVersion, currentVersion) > 0

        if (updateAvailable) {
            logger.info("Update available", { currentVersion, latestVersion })
        }

        return { latestVersion, currentVersion, updateAvailable }
    } catch {
        logger.debug("Failed to check for updates")
        return { latestVersion: null, currentVersion, updateAvailable: false }
    }
}

export function compareVersions(a: string, b: string): number {
    const partsA = a.split(".").map(Number)
    const partsB = b.split(".").map(Number)
    const maxLength = Math.max(partsA.length, partsB.length)

    for (let i = 0; i < maxLength; i++) {
        const valA = partsA[i] ?? 0
        const valB = partsB[i] ?? 0
        if (valA > valB) return 1
        if (valA < valB) return -1
    }

    return 0
}
