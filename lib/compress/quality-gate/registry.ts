import type { QualityGate } from "./types"

const registry = new Map<string, QualityGate>()

export function registerQualityGate(gate: QualityGate): void {
    if (registry.has(gate.name)) {
        const existing = registry.get(gate.name)!
        if (existing !== gate && existing.version !== gate.version) {
            throw new Error(
                `Quality gate "${gate.name}" already registered with version ${existing.version} (attempted ${gate.version})`,
            )
        }
    }
    registry.set(gate.name, gate)
}

export function getQualityGate(name: string): QualityGate | undefined {
    return registry.get(name)
}

export function listQualityGates(): string[] {
    return [...registry.keys()].sort()
}

export function clearQualityGateRegistryForTests(): void {
    registry.clear()
}
