export function renderToolListExtension(tools: string[]): string {
    if (tools.length === 0) return ""
    return `Available tools: ${tools.join(", ")}`
}

export function renderProtectedToolDescription(toolName: string): string {
    return `The "${toolName}" tool's output is protected and will never be compressed. Its results are preserved in full.`
}
