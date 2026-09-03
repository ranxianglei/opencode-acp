/**
 * Integration tests for the #337 manual-proxy self-disable: the plugin
 * factory's config hook detects a `/bili/` proxy in a provider baseURL and
 * (a) denies all ACP tools in opencode's permission config (which removes
 * them from the LLM tool list), (b) skips the /acp command + primary_tools
 * wiring, and (c) turns every ACP hook into a no-op via the guard flag.
 *
 * The plugin is imported through the real factory (index.ts) with an
 * isolated XDG_CONFIG_HOME / XDG_DATA_HOME so no host config or state is
 * touched. autoUpdate is disabled via the ACP config file so the factory
 * performs no network activity.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdirSync, writeFileSync } from "node:fs"
import type { PluginInput, Hooks, Config } from "@opencode-ai/plugin"
import type { WithParts } from "../lib/state"

const testDataHome = join(tmpdir(), `opencode-acp-bili-data-${process.pid}`)
const testConfigHome = join(tmpdir(), `opencode-acp-bili-config-${process.pid}`)

// Must be set BEFORE importing ../index: lib/config.ts captures
// XDG_CONFIG_HOME into a module-level constant at import time.
process.env.XDG_DATA_HOME = testDataHome
process.env.XDG_CONFIG_HOME = testConfigHome
delete process.env.BILLION_CONTEXT_PROXY
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
    // The factory only touches client.config.providers(),
    // client.session.get() and (in secure mode) client interceptors — a
    // structural stub is sufficient for the hooks under test.
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

async function makeHooks(): Promise<Hooks> {
    const hooks = await plugin(makeCtx())
    assert.ok(hooks.config, "plugin factory must register a config hook")
    return hooks
}

test("config hook with /bili/ proxy: denies all ACP tools and skips command wiring", async () => {
    const hooks = await makeHooks()

    const opencodeConfig: Config = {
        provider: {
            openai: {
                options: {
                    baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1",
                },
            },
        },
    }

    await hooks.config!(opencodeConfig)

    for (const tool of ACP_TOOLS) {
        assert.equal(
            (opencodeConfig.permission as Record<string, unknown>)[tool],
            "deny",
            `permission.${tool} must be "deny" when the bili proxy is detected`,
        )
    }
    assert.equal(
        opencodeConfig.command?.["acp"],
        undefined,
        "/acp command must not be registered when disabled by the bili proxy",
    )
    assert.equal(
        opencodeConfig.experimental?.primary_tools,
        undefined,
        "primary_tools must not be touched when disabled by the bili proxy",
    )
})

test("config hook with /bili/ proxy: every ACP hook is a no-op", async () => {
    const hooks = await makeHooks()

    const opencodeConfig: Config = {
        provider: {
            anthropic: { options: { baseURL: "http://127.0.0.1:8787/bili/" } },
        },
    }
    await hooks.config!(opencodeConfig)

    // messages.transform must leave the messages untouched (no ID injection,
    // no nudges, no pruning) — the proxy handles compression.
    const messages = [
        makeUserMessage("msg-1", "hello world", "session-bili-1"),
        makeUserMessage("msg-2", "second message", "session-bili-1"),
    ]
    const output = { messages }
    await hooks["experimental.chat.messages.transform"]!({}, output)
    assert.equal(output.messages[0].parts[0].text, "hello world")
    assert.equal(output.messages[1].parts[0].text, "second message")

    // system.transform must not append the ACP system prompt.
    const system: string[] = ["base system prompt"]
    await hooks["experimental.chat.system.transform"]!(
        {
            sessionID: "session-bili-1",
            model: { providerID: "anthropic", id: "claude", limit: { context: 200000 } },
        },
        { system },
    )
    assert.equal(system.length, 1)
    assert.equal(system[0], "base system prompt")

    // text.complete must not strip anything.
    const textOutput = { text: "m00001 b0 some refs" }
    await hooks["experimental.text.complete"]!(
        { sessionID: "session-bili-1", messageID: "msg-1", partID: "part-1" },
        textOutput,
    )
    assert.equal(textOutput.text, "m00001 b0 some refs")

    // event hook must resolve without error.
    await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "session-bili-1" } },
    })
})

test("config hook without /bili/ proxy: ACP stays enabled (command + defaults wired)", async () => {
    const hooks = await makeHooks()

    const opencodeConfig: Config = {
        provider: {
            openai: { options: { baseURL: "https://api.openai.com/v1" } },
        },
    }

    await hooks.config!(opencodeConfig)

    assert.equal(
        opencodeConfig.command?.["acp"]?.description,
        "Show available ACP commands",
        "/acp command must be registered when no bili proxy is detected",
    )
    assert.equal(
        (opencodeConfig.permission as Record<string, unknown>)["compress"],
        "allow",
        "default compress permission must be applied when no bili proxy is detected",
    )

    // messages.transform must run the real pipeline (ID injection happens).
    const messages = [makeUserMessage("msg-1", "hello world", "session-bili-2")]
    const output = { messages }
    await hooks["experimental.chat.messages.transform"]!({}, output)
    const text = output.messages[0].parts[0].text as string
    assert.ok(
        text.includes("dcp-message-id"),
        `ACP ID injection must run when enabled, got: ${JSON.stringify(text)}`,
    )
})

test("config hook re-enable: removing the proxy restores ACP behavior", async () => {
    const hooks = await makeHooks()

    const withProxy: Config = {
        provider: {
            openai: {
                options: { baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" },
            },
        },
    }
    await hooks.config!(withProxy)
    assert.equal((withProxy.permission as Record<string, unknown>)["compress"], "deny")

    // Simulate a config reload where the provider no longer routes through
    // the proxy: the flag must flip back and the real pipeline must resume.
    const withoutProxy: Config = {
        provider: { openai: { options: { baseURL: "https://api.openai.com/v1" } } },
    }
    await hooks.config!(withoutProxy)
    assert.equal((withoutProxy.permission as Record<string, unknown>)["compress"], "allow")

    const messages = [makeUserMessage("msg-1", "hello world", "session-bili-3")]
    const output = { messages }
    await hooks["experimental.chat.messages.transform"]!({}, output)
    const text = output.messages[0].parts[0].text as string
    assert.ok(
        text.includes("dcp-message-id"),
        `ACP must be re-enabled after the proxy is removed, got: ${JSON.stringify(text)}`,
    )
})
