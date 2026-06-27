import type { CommandContext, CommandResult } from "./types"

interface CommandDoc {
    name: string
    args: string
    description: string
}

const COMMANDS: CommandDoc[] = [
    {
        name: "context",
        args: "",
        description: "Show current context usage, active compression blocks, and tokens freed.",
    },
    {
        name: "stats",
        args: "",
        description: "Show compression statistics: total/active blocks, generations, survival counts.",
    },
    {
        name: "sweep",
        args: "",
        description: "Schedule a full context sweep on the next pass; nudges the model to compress low-priority content.",
    },
    {
        name: "manual",
        args: "[on|off]",
        description: "Toggle manual compression mode. Without an argument, shows the current state.",
    },
    {
        name: "decompress",
        args: "[id ...]",
        description: "Restore compressed content by deactivating block(s). Without an argument, lists available blocks.",
    },
    {
        name: "recompress",
        args: "[id ...]",
        description: "Re-apply user-decompressed block(s). Without an argument, lists recompressible blocks.",
    },
    {
        name: "help",
        args: "",
        description: "Show this help.",
    },
]

export function helpCommand(_ctx: CommandContext): CommandResult {
    const lines: string[] = ["**ACP commands**", ""]
    for (const cmd of COMMANDS) {
        const usage = cmd.args ? ` ${cmd.args}` : ""
        lines.push(`- \`/acp ${cmd.name}${usage}\` — ${cmd.description}`)
    }
    return { output: lines.join("\n") }
}
