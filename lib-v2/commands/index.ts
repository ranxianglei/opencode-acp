export { contextCommand } from "./context"
export { statsCommand } from "./stats"
export { sweepCommand } from "./sweep"
export { manualCommand } from "./manual"
export { decompressCommand, parseBlockIds } from "./decompress"
export { recompressCommand } from "./recompress"
export { helpCommand } from "./help"
export type { CommandContext, CommandResult, CommandHandler } from "./types"

import type { CommandHandler } from "./types"
import { contextCommand } from "./context"
import { statsCommand } from "./stats"
import { sweepCommand } from "./sweep"
import { manualCommand } from "./manual"
import { decompressCommand } from "./decompress"
import { recompressCommand } from "./recompress"
import { helpCommand } from "./help"

export const commands: Record<string, CommandHandler> = {
    context: contextCommand,
    stats: statsCommand,
    sweep: sweepCommand,
    manual: manualCommand,
    decompress: decompressCommand,
    recompress: recompressCommand,
    help: helpCommand,
}
