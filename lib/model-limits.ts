const MODEL_CONTEXT_LIMITS: Record<string, number> = {
    "claude-3-opus": 200000,
    "claude-3-sonnet": 200000,
    "claude-3-haiku": 200000,
    "claude-3.5-sonnet": 200000,
    "claude-3.5-haiku": 200000,
    "claude-sonnet-4": 200000,
    "claude-opus-4": 200000,
    "claude-haiku-4": 200000,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4-turbo": 128000,
    "gpt-4": 8192,
    "gpt-4-32k": 32768,
    "gpt-3.5-turbo": 16385,
    "o1": 200000,
    "o1-mini": 128000,
    "o1-pro": 200000,
    "o3": 200000,
    "o3-mini": 200000,
    "o4-mini": 200000,
    "gemini-1.5-pro": 2000000,
    "gemini-1.5-flash": 1000000,
    "gemini-2.0-flash": 1000000,
    "gemini-2.5-pro": 1000000,
    "gemini-2.5-flash": 1000000,
    "deepseek-chat": 64000,
    "deepseek-reasoner": 64000,
    "llama-3.1-405b": 128000,
    "llama-3.1-70b": 128000,
    "llama-3.1-8b": 128000,
    "qwen2.5-72b": 32768,
    "qwen-max": 32768,
    "glm-4": 128000,
    "glm-4-plus": 128000,
    "glm-5": 128000,
}

export function inferModelContextLimit(modelId: string | undefined): number | undefined {
    if (!modelId) return undefined

    const direct = MODEL_CONTEXT_LIMITS[modelId]
    if (direct) return direct

    const normalized = modelId.toLowerCase()
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (normalized.includes(key)) {
            return limit
        }
    }

    return undefined
}
