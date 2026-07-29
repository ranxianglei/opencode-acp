const STRUCTURAL_PART_TYPES = new Set(["step-start", "step-finish", "reasoning"])

export function hasMeaningfulContent(parts: { type: string }[]): boolean {
    return parts.some((p) => !STRUCTURAL_PART_TYPES.has(p.type))
}
