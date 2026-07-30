import type { MessageFilter } from "../types"
import { registerMessageFilter, getMessageFilter } from "../registry"
import { OMO_SYSTEM_REMINDER_FILTER } from "./omo-system-reminder"
import { OMO_TODO_FILTER } from "./omo-todo-continuation"
import { OMO_CONTEXT_FILTER } from "./omo-context"
import { OMO_TASK_FILTER } from "./omo-task-directive"
import { OMO_MODE_FILTER } from "./omo-mode-injection"

const BUILTIN_FILTERS: MessageFilter[] = [
    OMO_SYSTEM_REMINDER_FILTER,
    OMO_TODO_FILTER,
    OMO_CONTEXT_FILTER,
    OMO_TASK_FILTER,
    OMO_MODE_FILTER,
]

export function ensureBuiltinFiltersRegistered(): void {
    for (const filter of BUILTIN_FILTERS) {
        if (!getMessageFilter(filter.name)) {
            registerMessageFilter(filter)
        }
    }
}
