const MESSAGE_REF_PADDING = 5
const MESSAGE_REF_PREFIX = "m"
const BLOCK_REF_PREFIX = "b"

export function formatMessageRef(index: number): string {
    return `${MESSAGE_REF_PREFIX}${String(index).padStart(MESSAGE_REF_PADDING, "0")}`
}

export function parseMessageRef(ref: string): number | null {
    if (!ref.startsWith(MESSAGE_REF_PREFIX)) return null
    const numStr = ref.slice(MESSAGE_REF_PREFIX.length)
    const num = parseInt(numStr, 10)
    if (isNaN(num)) return null
    return num
}

export function formatBlockRef(id: number): string {
    return `${BLOCK_REF_PREFIX}${id}`
}

export function parseBlockRef(ref: string): number | null {
    if (!ref.startsWith(BLOCK_REF_PREFIX)) return null
    const numStr = ref.slice(BLOCK_REF_PREFIX.length)
    const num = parseInt(numStr, 10)
    if (isNaN(num)) return null
    return num
}

export function formatMessageIdTag(ref: string): string {
    return `<dcp-message-id>${ref}</dcp-message-id>`
}

export const DCP_MESSAGE_REF_TAG_REGEX = /<dcp-message-id>m\d+<\/dcp-message-id>/g

export const DCP_SYSTEM_REMINDER_TAG_REGEX = /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g

export function stripStaleMessageRefs(text: string): string {
    return text.replace(DCP_MESSAGE_REF_TAG_REGEX, "")
}

export function stripSystemReminderTags(text: string): string {
    return text.replace(DCP_SYSTEM_REMINDER_TAG_REGEX, "")
}
