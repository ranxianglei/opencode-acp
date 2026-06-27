export { compressRange, collectRangeContent } from "./range-mode"
export { compressMessages, resolveMessageIds } from "./message-mode"
export { resolveBoundary, resolveMessageRef, type ResolvedBoundary } from "./search"
export {
    appendProtectedUserMessages,
    appendProtectedPromptInfo,
    extractProtectedPromptInfo,
    appendProtectedTools,
} from "./protected-content"
export type {
    ToolContext,
    BoundaryReference,
    RangeInput,
    MessageInput,
    CompressionResult,
    ResolvedRange,
    ResolvedMessage,
    CompressMode,
} from "./types"
