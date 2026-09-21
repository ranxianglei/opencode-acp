/**
 * Tests for the #405 billion-context owner-marker yield: ACP must back off
 * when billion-context owns compression in this process, detected by
 * re-sampling env markers at ACTION time (not just at setup):
 *
 * - BILLION_CONTEXT_PROXY  (launcher mode)
 * - BILLION_CONTEXT_NATIVE (native mode; written at the billion-context
 *   plugin's module evaluation, which can land AFTER ACP setup)
 *
 * Coverage: setup-time fast path (factory returns {}), marker landing after
 * factory init (config hook denies tools + every hook no-op + tool execute
 * throws), launcher marker likewise, re-enable after unsetting, one-time log.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import type { PluginInput, Hooks, Config, ToolContext } from "@opencode-ai/plugin"
import type { WithParts } from "../lib/state"
import { describeBiliEnvYield, detectBiliEnvYield } from "../lib/bili-proxy"

const testDataHome = join(tmpdir(), `opencode-acp-bilinat-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-acp-bilinat-config-${process.pid}`)

// Must be set BEFORE importing ../index: lib/config.ts captures
// XDG_CONFIG_HOME into a module-level constant at import time.
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
delete process.env.BILLION_CONTEXT_PROXY
delete process.env.BILLION_CONTEXT_NATIVE
delete process.env.OPENCODE_CONFIG_DIR
delete process.env.OPENCODE_SERVER_PASSWORD

mkdirSync(join(testConfigHome, "opencode"), { recursive: true })
writeFileSync(
    join(testConfigHome, "opencode", "acp.jsonc"),
    JSON.stringify({ autoUpdate: false }),
    "utf-8",
)
mkdirSync(testDataHome, { recursive: true })

const { default: plugin } = await import("../index")

function makeCtx(): PluginInput {
    const client = {
        config: {
            providers: async () => ({ data: { providers: [] } }),
            get: async () => ({ data: {} }),
        },
        session: {
            get: async () => ({ data: {} }),
            messages: async () => ({ data: [] }),
        },
        tui: { showToast: async () => {} },
    }
    return {
        client: client as PluginInput["client"],
        project: { path: testDataHome },
        directory: testDataHome,
        worktree: testDataHome,
        experimental_workspace: { register: () => {} },
        serverUrl: new URL("http://127.0.0.1:1"),
        $: { command: async () => "" } as PluginInput["$"],
    }
}

const ACP_TOOLS = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]

function makeUserMessage(id: string, text: string, sessionId: string): WithParts {
    return {
        info: {
            id,
            sessionID: sessionId,
            role: "user",
            agent: "assistant",
            time: { created: Date.now() },
            model: { providerID: "test-provider", modelID: "test-model" },
        } as WithParts["info"],
        parts: [{ type: "text", text, id: `${id}-p1`, sessionID: sessionId, messageID: id }],
    }
}

function makeToolCtx(): ToolContext {
    return {
        sessionID: "session-nat-1",
        messageID: "msg-nat-1",
        agent: "assistant",
        directory: testDataHome,
        worktree: testDataHome,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
    }
}

async function makeHooks(): Promise<Hooks> {
    const hooks = await plugin(makeCtx())
    assert.ok(hooks.config, "plugin factory must register a config hook")
    return hooks
}

const VALID_RANGE_ARGS = {
    content: [{ startId: "m00001", endId: "m00002", summary: "test summary" }],
}

const PLAIN_CONFIG: Config = {
    provider: { openai: { options: { baseURL: "https://api.openai.com/v1" } } },
}

test("detectBiliEnvYield: pure detection and precedence", () => {
    assert.equal(detectBiliEnvYield({}), null)
    assert.equal(detectBiliEnvYield({ BILLION_CONTEXT_PROXY: "" }), null)
    assert.equal(detectBiliEnvYield({ BILLION_CONTEXT_NATIVE: "" }), null)
    assert.equal(detectBiliEnvYield({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), "launcher")
    assert.equal(detectBiliEnvYield({ BILLION_CONTEXT_NATIVE: "opencode" }), "native")
    // Launcher wins when both are set (native bootstrap refuses to run while
    // BILLION_CONTEXT_PROXY is set, so both cannot normally coexist).
    assert.equal(
        detectBiliEnvYield({
            BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787",
            BILLION_CONTEXT_NATIVE: "opencode",
        }),
        "launcher",
    )
})

test("describeBiliEnvYield: log message wording", () => {
    assert.match(describeBiliEnvYield("native"), /BILLION_CONTEXT_NATIVE/)
    assert.match(describeBiliEnvYield("launcher"), /BILLION_CONTEXT_PROXY/)
})

test("setup-time native marker: factory yields immediately (fast path)", async () => {
    process.env.BILLION_CONTEXT_NATIVE = "opencode"
    try {
        const hooks = await plugin(makeCtx())
        assert.equal(hooks.config, undefined, "no config hook when the marker is set at setup")
        assert.equal(hooks.tool, undefined, "no tools registered when the marker is set at setup")
    } finally {
        delete process.env.BILLION_CONTEXT_NATIVE
    }
})

test("setup-time launcher marker: factory yields immediately (fast path)", async () => {
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787"
    try {
        const hooks = await plugin(makeCtx())
        assert.equal(hooks.config, undefined)
        assert.equal(hooks.tool, undefined)
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY
    }
})

test("runtime native marker: config hook denies all ACP tools and skips wiring", async () => {
    const hooks = await makeHooks()
    process.env.BILLION_CONTEXT_NATIVE = "opencode"
    try {
        const opencodeConfig: Config = structuredClone(PLAIN_CONFIG)
        await hooks.config!(opencodeConfig)

        for (const toolName of ACP_TOOLS) {
            assert.equal(
                (opencodeConfig.permission as Record<string, unknown>)[toolName],
                "deny",
                `permission.${toolName} must be "deny" when the native marker is set`,
            )
        }
        assert.equal(
            opencodeConfig.command?.["acp"],
            undefined,
            "/acp command must not be registered when yielded",
        )
        assert.equal(
            opencodeConfig.experimental?.primary_tools,
            undefined,
            "primary_tools must not be touched when yielded",
        )
    } finally {
        delete process.env.BILLION_CONTEXT_NATIVE
    }
})

test("runtime native marker: every ACP hook is a no-op", async () => {
    const hooks = await makeHooks()
    process.env.BILLION_CONTEXT_NATIVE = "opencode"
    try {
        const opencodeConfig: Config = structuredClone(PLAIN_CONFIG)
        await hooks.config!(opencodeConfig)

        const messages = [
            makeUserMessage("msg-1", "hello world", "session-nat-2"),
            makeUserMessage("msg-2", "second message", "session-nat-2"),
        ]
        const output = { messages }
        await hooks["experimental.chat.messages.transform"]!({}, output)
        assert.equal(output.messages[0].parts[0].text, "hello world")
        assert.equal(output.messages[1].parts[0].text, "second message")

        const system: string[] = ["base system prompt"]
        await hooks["experimental.chat.system.transform"]!(
            {
                sessionID: "session-nat-2",
                model: { providerID: "anthropic", id: "claude", limit: { context: 200000 } },
            },
            { system },
        )
        assert.equal(system.length, 1)
        assert.equal(system[0], "base system prompt")

        const textOutput = { text: "m00001 b0 some refs" }
        await hooks["experimental.text.complete"]!(
            { sessionID: "session-nat-2", messageID: "msg-1", partID: "part-1" },
            textOutput,
        )
        assert.equal(textOutput.text, "m00001 b0 some refs")

        await hooks.event!({
            event: { type: "session.idle", properties: { sessionID: "session-nat-2" } },
        })

        const commandOutput = { parts: [] }
        await hooks["command.execute.before"]!(
            { command: "acp", sessionID: "session-nat-2", arguments: "context" },
            commandOutput,
        )
        assert.equal(commandOutput.parts.length, 0)
    } finally {
        delete process.env.BILLION_CONTEXT_NATIVE
    }
})

test("runtime native marker: tool execute throws instead of acting", async () => {
    const hooks = await makeHooks()
    process.env.BILLION_CONTEXT_NATIVE = "opencode"
    try {
        // The yield check runs before arg validation, so minimal args suffice;
        // each entry proves the shared resolveToolContext gate covers its tool.
        const toolCalls: Array<[string, () => Promise<unknown>]> = [
            ["compress", () => hooks.tool!.compress!.execute(VALID_RANGE_ARGS, makeToolCtx())],
            ["decompress", () => hooks.tool!.decompress!.execute({}, makeToolCtx())],
            [
                "search_context",
                () => hooks.tool!.search_context!.execute({ query: "test" }, makeToolCtx()),
            ],
            ["acp_status", () => hooks.tool!.acp_status!.execute({}, makeToolCtx())],
            ["acp_context_recap", () => hooks.tool!.acp_context_recap!.execute({}, makeToolCtx())],
        ]
        for (const [name, invoke] of toolCalls) {
            await assert.rejects(
                invoke,
                /disabled in this process[\s\S]*BILLION_CONTEXT_NATIVE/,
                `${name} execute must yield when the native marker is set`,
            )
        }
    } finally {
        delete process.env.BILLION_CONTEXT_NATIVE
    }
})

test("runtime launcher marker: same yield behavior (env re-read at action time)", async () => {
    const hooks = await makeHooks()
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:8787"
    try {
        const opencodeConfig: Config = structuredClone(PLAIN_CONFIG)
        await hooks.config!(opencodeConfig)
        assert.equal((opencodeConfig.permission as Record<string, unknown>)["compress"], "deny")

        const output = { messages: [makeUserMessage("msg-1", "hello world", "session-nat-3")] }
        await hooks["experimental.chat.messages.transform"]!({}, output)
        assert.equal(output.messages[0].parts[0].text, "hello world")

        const compressTool = hooks.tool?.compress
        assert.ok(compressTool)
        await assert.rejects(
            () => compressTool.execute(VALID_RANGE_ARGS, makeToolCtx()),
            /disabled in this process[\s\S]*BILLION_CONTEXT_PROXY/,
        )
    } finally {
        delete process.env.BILLION_CONTEXT_PROXY
    }
})

test("re-enable: unsetting the marker restores ACP behavior", async () => {
    const hooks = await makeHooks()

    process.env.BILLION_CONTEXT_NATIVE = "opencode"
    try {
        const whileDisabled: Config = structuredClone(PLAIN_CONFIG)
        await hooks.config!(whileDisabled)
        assert.equal((whileDisabled.permission as Record<string, unknown>)["compress"], "deny")
    } finally {
        delete process.env.BILLION_CONTEXT_NATIVE
    }

    // Simulate the marker disappearing (e.g. the native plugin was removed and
    // the process is restarted into a clean env): ACP must resume.
    const restored: Config = structuredClone(PLAIN_CONFIG)
    await hooks.config!(restored)
    assert.equal(restored.command?.["acp"]?.description, "Show available ACP commands")
    assert.equal((restored.permission as Record<string, unknown>)["compress"], "allow")

    const output = { messages: [makeUserMessage("msg-1", "hello world", "session-nat-4")] }
    await hooks["experimental.chat.messages.transform"]!({}, output)
    const text = output.messages[0].parts[0].text as string
    assert.ok(
        text.includes("dcp-message-id"),
        `ACP ID injection must resume after the marker is unset, got: ${JSON.stringify(text)}`,
    )

    // The tool must get PAST the yield gate (it then fails on missing session
    // state — proof the gate no longer fires).
    const compressTool = hooks.tool?.compress
    assert.ok(compressTool)
    await assert.rejects(
        () => compressTool.execute(VALID_RANGE_ARGS, makeToolCtx()),
        /no initialized state/,
    )
})

test("yield announcement is logged exactly once per source", async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
    }
    try {
        const hooks = await makeHooks()
        process.env.BILLION_CONTEXT_NATIVE = "opencode"
        try {
            await hooks.config!(structuredClone(PLAIN_CONFIG))
            const output = { messages: [makeUserMessage("msg-1", "hi", "session-nat-5")] }
            await hooks["experimental.chat.messages.transform"]!({}, output)
            await hooks["experimental.chat.messages.transform"]!({}, output)
            await hooks.event!({
                event: { type: "session.idle", properties: { sessionID: "session-nat-5" } },
            })
        } finally {
            delete process.env.BILLION_CONTEXT_NATIVE
        }
    } finally {
        console.log = originalLog
    }

    const yieldLogs = logs.filter(
        (line) =>
            line.includes("[opencode-acp] disabled:") && line.includes("BILLION_CONTEXT_NATIVE"),
    )
    assert.equal(
        yieldLogs.length,
        1,
        `expected exactly one yield log, got: ${JSON.stringify(logs)}`,
    )
})
