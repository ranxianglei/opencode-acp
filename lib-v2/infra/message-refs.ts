const MESSAGE_REF_PADDING = 5
const MESSAGE_REF_PREFIX = "m"
const BLOCK_REF_PREFIX = "b"

const MESSAGE_REF_REGEX = /^m(\d{4,5})$/
const BLOCK_REF_REGEX = /^b([1-9]\d*)$/
const MESSAGE_REF_MIN_INDEX = 1
const MESSAGE_REF_MAX_INDEX = 99999

export type ParsedBoundaryId =
    | {
          kind: "message"
          ref: string
          index: number
      }
    | {
          kind: "compressed-block"
          ref: string
          blockId: number
      }

export function formatMessageRef(index: number): string {
    if (
        !Number.isInteger(index) ||
        index < MESSAGE_REF_MIN_INDEX ||
        index > MESSAGE_REF_MAX_INDEX
    ) {
        throw new Error(
            `Message ID index out of bounds: ${index}. Supported range is ${MESSAGE_REF_MIN_INDEX}-${MESSAGE_REF_MAX_INDEX}.`,
        )
    }
    return `${MESSAGE_REF_PREFIX}${index.toString().padStart(MESSAGE_REF_PADDING, "0")}`
}

export function parseMessageRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(MESSAGE_REF_REGEX)
    if (!match) {
        return null
    }
    const index = Number.parseInt(match[1]!, 10)
    if (!Number.isInteger(index)) {
        return null
    }
    if (index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
        return null
    }
    return index
}

export function formatBlockRef(blockId: number): string {
    if (!Number.isInteger(blockId) || blockId < 1) {
        throw new Error(`Invalid block ID: ${blockId}`)
    }
    return `${BLOCK_REF_PREFIX}${blockId}`
}

export function parseBlockRef(ref: string): number | null {
    const normalized = ref.trim().toLowerCase()
    const match = normalized.match(BLOCK_REF_REGEX)
    if (!match) {
        return null
    }
    const id = Number.parseInt(match[1]!, 10)
    return Number.isInteger(id) ? id : null
}

export function parseBoundaryId(id: string): ParsedBoundaryId | null {
    const normalized = id.trim().toLowerCase()
    const messageIndex = parseMessageRef(normalized)
    if (messageIndex !== null) {
        return {
            kind: "message",
            ref: formatMessageRef(messageIndex),
            index: messageIndex,
        }
    }

    const blockId = parseBlockRef(normalized)
    if (blockId !== null) {
        return {
            kind: "compressed-block",
            ref: formatBlockRef(blockId),
            blockId,
        }
    }

    return null
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
}

export function formatMessageIdTag(
    ref: string,
    attributes?: Record<string, string | undefined>,
): string {
    const MESSAGE_ID_TAG_NAME = "dcp-message-id"
    const serializedAttributes = Object.entries(attributes || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            if (name.trim().length === 0 || typeof value !== "string" || value.length === 0) {
                return ""
            }

            return ` ${name}="${escapeXmlAttribute(value)}"`
        })
        .join("")

    return `\n<${MESSAGE_ID_TAG_NAME}${serializedAttributes}>${ref}</${MESSAGE_ID_TAG_NAME}>`
}

export const DCP_MESSAGE_REF_TAG_REGEX = /<dcp-message-id>m\d+<\/dcp-message-id>/g

export const DCP_SYSTEM_REMINDER_TAG_REGEX = /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g

export function stripStaleMessageRefs(text: string): string {
    return text.replace(DCP_MESSAGE_REF_TAG_REGEX, "")
}

export function stripSystemReminderTags(text: string): string {
    return text.replace(DCP_SYSTEM_REMINDER_TAG_REGEX, "")
}
