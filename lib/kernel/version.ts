declare const ACP_VERSION: string | undefined
declare const ACP_ENGINE: string | undefined
declare const KERNEL_VERSION: string | undefined

export const VERSION = {
    package: typeof ACP_VERSION !== "undefined" ? ACP_VERSION : "dev",
    engine: typeof ACP_ENGINE !== "undefined" ? ACP_ENGINE : "unknown",
    kernel: typeof KERNEL_VERSION !== "undefined" ? KERNEL_VERSION : "dev",
}

export function versionBanner(): string {
    return `opencode-acp v${VERSION.package} (engine: ${VERSION.engine} v${VERSION.kernel})`
}
