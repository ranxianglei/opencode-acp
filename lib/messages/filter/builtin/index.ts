import type { MessageFilter } from "../types"
import { registerMessageFilter, getMessageFilter } from "../registry"
import { OMO_SYSTEM_REMINDER_FILTER } from "./omo-system-reminder"

const BUILTIN_FILTERS: MessageFilter[] = [OMO_SYSTEM_REMINDER_FILTER]

export function ensureBuiltinFiltersRegistered(): void {
    for (const filter of BUILTIN_FILTERS) {
        if (!getMessageFilter(filter.name)) {
            registerMessageFilter(filter)
        }
    }
}
