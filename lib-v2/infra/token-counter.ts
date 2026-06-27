let tokenizer: { countTokens: (text: string) => number } | null = null

async function getTokenizer(): Promise<{ countTokens: (text: string) => number } | null> {
    if (tokenizer) return tokenizer
    try {
        const mod = await import("@anthropic-ai/tokenizer")
        tokenizer = mod
        return tokenizer
    } catch {
        return null
    }
}

export async function countTokens(text: string): Promise<number> {
    const tok = await getTokenizer()
    if (tok) {
        try {
            return tok.countTokens(text)
        } catch {
            return Math.ceil(text.length / 4)
        }
    }
    return Math.ceil(text.length / 4)
}

export function countTokensSync(text: string): number {
    return Math.ceil(text.length / 4)
}

export function getCurrentTokenUsage(
    state: { modelContextLimit?: number; stats: { pruneTokenCounter: number; totalPruneTokens: number } },
    messages: readonly { parts: readonly any[] }[],
): number {
    let total = 0
    for (const msg of messages) {
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        for (const part of parts) {
            if (part?.type === "text" && typeof part.text === "string") {
                total += countTokensSync(part.text)
            } else if (part?.type === "tool" && typeof part.state?.output === "string") {
                total += countTokensSync(part.state.output)
            }
        }
    }
    return total
}
