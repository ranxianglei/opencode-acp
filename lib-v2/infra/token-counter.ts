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
