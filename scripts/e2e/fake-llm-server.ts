#!/usr/bin/env bun
/**
 * Fake OpenAI-compatible LLM server for ACP E2E tests.
 *
 * Drives real `opencode run` sessions through a stub LLM that emits
 * scripted responses — either text or `compress` tool_use calls —
 * based on a JSON scenario file. This exercises the full ACP pipeline:
 * opencode → message transform hooks → compress tool → state persistence.
 *
 * Architecture:
 *   - Listens on PORT (default 8400), responds to /v1/chat/completions
 *   - Reads scenario from SCENARIO env var (JSON file path)
 *   - Tracks turns by counting user messages in each request
 *   - At compress turns: parses <dcp-message-id> tags for mNNNNN refs,
 *     emits compress tool_use with startId/endId/summary from scenario
 *   - After tool result: emits text acknowledgment
 *   - SSE streaming (opencode defaults to stream=true)
 *
 * Usage:
 *   PORT=8400 SCENARIO=scenarios/01-basic-compress.json bun run fake-llm-server.ts
 */

import { readFileSync, writeFileSync, existsSync } from "fs"

const PORT = parseInt(process.env.PORT ?? "8400", 10)
const HOST = process.env.HOST ?? "127.0.0.1"
const SCENARIO_PATH = process.env.SCENARIO
const TURN_COUNTER = process.env.TURN_COUNTER ?? "/tmp/acp-e2e-turn-counter"

if (!SCENARIO_PATH) {
    process.stderr.write("[fake-llm] FATAL: SCENARIO env var not set\n")
    process.exit(1)
}

interface ScenarioStep {
    respond: "text" | "compress" | "task" | "tool"
    text?: string
    summary?: string
    topic?: string
    acknowledgeRisk?: boolean
    auto?: boolean
    retryOnReject?: {
        summary: string
        topic?: string
        acknowledgeRisk?: boolean
    }
    /** For compress: "all" to compress everything, or explicit [startIdx, endIdx] of mNNNNN refs */
    range?: "all" | [number, number]
    /** For batch compress: multiple ranges */
    ranges?: Array<{ summary: string; topic?: string; range?: "all" | [number, number] }>
    /** For task: subagent spawn parameters */
    description?: string
    prompt?: string
    subagent_type?: string
    /** For task: turns the spawned subagent session will execute */
    subagent_turns?: ScenarioStep[]
    /** For tool: arbitrary tool_use call */
    tool?: string
    toolArgs?: Record<string, unknown>
}

interface Scenario {
    name: string
    description: string
    turns: ScenarioStep[]
}

const scenario: Scenario = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"))

process.stderr.write(`[fake-llm] scenario: ${scenario.name} (${scenario.turns.length} turns)\n`)

const CHILD_TURN_COUNTER = TURN_COUNTER + "-child"

function readChildTurnCounter(): number {
    if (existsSync(CHILD_TURN_COUNTER)) {
        return parseInt(readFileSync(CHILD_TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    return 0
}

function incrementChildTurnCounter(): number {
    const current = readChildTurnCounter()
    writeFileSync(CHILD_TURN_COUNTER, String(current + 1))
    return current
}

// --- HTTP server ---

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch(req) {
        const url = new URL(req.url)

        if (req.method === "GET" && url.pathname === "/v1/models") {
            return jsonResponse({
                object: "list",
                data: [
                    {
                        id: "fake-model",
                        object: "model",
                        created: 1_700_000_000_000,
                        owned_by: "acp-e2e",
                    },
                ],
            })
        }

        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            return handleChatCompletion(req)
        }

        return jsonResponse({ error: `not found: ${req.method} ${url.pathname}` }, 404)
    },
})

function log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23)
    process.stderr.write(`[fake-llm ${ts}] ${msg}\n`)
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
        },
    })
}

// --- Chat completion handler ---

async function handleChatCompletion(req: Request): Promise<Response> {
    let body: any
    try {
        body = await req.json()
    } catch (err) {
        return jsonResponse({ error: `invalid JSON: ${(err as Error).message}` }, 400)
    }

    const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
    const tools: any[] = Array.isArray(body?.tools) ? body.tools : []
    const isStream: boolean = body?.stream === true
    const model: string = body?.model ?? "fake-model"

    const parentSessionId = req.headers.get("x-parent-session-id")
    const sessionId = req.headers.get("x-session-id") ?? "unknown"
    const isChild = !!parentSessionId

    const lastMsg = messages[messages.length - 1]
    const lastRole = lastMsg?.role

    log(
        `  body: stream=${isStream} msgs=${messages.length} ` +
            `lastRole=${lastRole} tools=${tools.length}${isChild ? " [CHILD]" : ""}`,
    )

    if (tools.length === 0) {
        log("  → auxiliary call (tools=0), emitting generic text")
        return textResponse(model, "Session summary.", isStream)
    }

    if (isChild) {
        return handleChildRequest(model, messages, lastRole, lastMsg, isStream)
    }

    if (lastRole === "tool" || lastRole === "function") {
        const toolText = extractMessageText(lastMsg)
        if (toolText.includes("QUALITY GATE FAILURE") || toolText.includes("COMPRESSION REJECTED")) {
            const currentIdx = readTurnCounter() - 1
            const currentStep = scenario.turns[currentIdx]
            if (currentStep?.retryOnReject) {
                const refs = parseMessageRefs(messages)
                const [startId, endId] = resolveRange(refs, currentStep.range ?? "all")
                log(`  → retrying compress with acknowledgeRisk after rejection`)
                return compressResponse(
                    model,
                    {
                        content: [
                            {
                                topic: currentStep.retryOnReject.topic ?? "Retry",
                                startId,
                                endId,
                                summary: currentStep.retryOnReject.summary,
                            },
                        ],
                    },
                    currentStep.retryOnReject.acknowledgeRisk ?? true,
                    isStream,
                )
            }
        }
        log("  → tool result received, emitting text acknowledgment")
        return textResponse(model, "Understood, continuing.", isStream)
    }

    // Real conversation turn: increment file-based counter for stateful tracking
    // across opencode run invocations (each run is a separate process).
    const turnIdx = incrementTurnCounter()
    const step = scenario.turns[turnIdx]

    if (!step) {
        log(`  → no scenario step for turn ${turnIdx + 1}, emitting default text`)
        return textResponse(model, "Done.", isStream)
    }

    log(`  → turn ${turnIdx + 1}: respond=${step.respond}`)

    if (step.respond === "task") {
        return handleTaskStep(model, step, isStream)
    }

    if (step.respond === "compress") {
        return handleCompressStep(model, messages, step, isStream)
    }

    // Text response
    const text = step.text ?? "(empty)"
    return textResponse(model, text, isStream)
}

function incrementTurnCounter(): number {
    let current = 0
    if (existsSync(TURN_COUNTER)) {
        current = parseInt(readFileSync(TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    const next = current + 1
    writeFileSync(TURN_COUNTER, String(next))
    return current
}

function readTurnCounter(): number {
    if (existsSync(TURN_COUNTER)) {
        return parseInt(readFileSync(TURN_COUNTER, "utf-8").trim(), 10) || 0
    }
    return 0
}

// --- Compress tool_use emission ---

function handleCompressStep(
    model: string,
    messages: any[],
    step: ScenarioStep,
    isStream: boolean,
): Response {
    // Parse all mNNNNN refs from the conversation.
    // ACP injects <dcp-message-id tokens="..." type="...">mNNNNN</dcp-message-id> tags.
    const refs = parseMessageRefs(messages)

    if (refs.length === 0) {
        log("  ⚠ no mNNNNN refs found — emitting fallback text")
        return textResponse(model, "No messages to compress.", isStream)
    }

    log(`  → found ${refs.length} mNNNNN refs: ${refs[0]}..${refs[refs.length - 1]}`)

    if (step.ranges && step.ranges.length > 0) {
        const content = step.ranges.map((r) => {
            const [startId, endId] = resolveRange(refs, r.range ?? "all")
            return {
                topic: r.topic ?? "Batch range",
                startId,
                endId,
                summary: r.summary,
            }
        })

        log(`  → batch compress: ${content.length} ranges`)
        return compressResponse(model, { topic: "Batch compression", content }, step.acknowledgeRisk ?? false, isStream)
    }

    const [startId, endId] = resolveRange(refs, step.range ?? "all")
    const content = [
        {
            topic: step.topic ?? "Compression",
            startId,
            endId,
            summary: step.summary ?? "Summary not provided.",
        },
    ]

    log(`  → compress: ${startId}..${endId}, summary=${(step.summary ?? "").length} chars, ack=${step.acknowledgeRisk ?? false}`)
    return compressResponse(model, { content }, step.acknowledgeRisk ?? false, isStream)
}

function handleChildRequest(
    model: string,
    messages: any[],
    lastRole: string | undefined,
    lastMsg: any,
    isStream: boolean,
): Response {
    const taskStep = scenario.turns.find((t) => t.respond === "task")
    const childTurns = taskStep?.subagent_turns ?? []

    if (lastRole === "tool" || lastRole === "function") {
        const toolText = extractMessageText(lastMsg)
        if (toolText.includes("QUALITY GATE FAILURE") || toolText.includes("COMPRESSION REJECTED")) {
            const idx = readChildTurnCounter() - 1
            const step = childTurns[idx]
            if (step?.retryOnReject) {
                const refs = parseMessageRefs(messages)
                const [startId, endId] = resolveRange(refs, step.range ?? "all")
                log(`  → [CHILD] retrying compress with acknowledgeRisk`)
                return compressResponse(
                    model,
                    {
                        content: [
                            {
                                topic: step.retryOnReject.topic ?? "Retry",
                                startId,
                                endId,
                                summary: step.retryOnReject.summary,
                            },
                        ],
                    },
                    step.retryOnReject.acknowledgeRisk ?? true,
                    isStream,
                )
            }
        }
    }

    const turnIdx = incrementChildTurnCounter()
    const step = childTurns[turnIdx]

    if (!step) {
        log(`  → [CHILD] turn ${turnIdx + 1}: no step, emitting default text`)
        return textResponse(model, "Task complete.", isStream)
    }

    log(`  → [CHILD] turn ${turnIdx + 1}: respond=${step.respond}`)

    if (step.respond === "compress") {
        return handleCompressStep(model, messages, step, isStream)
    }

    if (step.respond === "tool") {
        const toolName = step.tool ?? "bash"
        log(`  → [CHILD] emitting ${toolName} tool call`)
        return toolUseResponse(model, toolName, step.toolArgs ?? {}, isStream)
    }

    return textResponse(model, step.text ?? "Done.", isStream)
}

function handleTaskStep(model: string, step: ScenarioStep, isStream: boolean): Response {
    const args: Record<string, unknown> = {
        description: step.description ?? "E2E subagent task",
        prompt: step.prompt ?? "Complete the assigned task.",
        subagent_type: step.subagent_type ?? "general",
    }

    log(`  → emitting task tool call (subagent_type=${args.subagent_type})`)
    return toolUseResponse(model, "task", args, isStream)
}

/**
 * Parse <dcp-message-id ...>mNNNNN</dcp-message-id> tags from all messages.
 * Returns an ordered list of unique refs (m00001, m00002, ...).
 */
function parseMessageRefs(messages: any[]): string[] {
    const refs: string[] = []
    const seen = new Set<string>()
    const tagRegex = /<dcp-message-id[^>]*>(m\d+)<\/dcp-message-id>/g

    for (const msg of messages) {
        if (msg?.role === "system") continue
        const text = extractMessageText(msg)
        let match: RegExpExecArray | null
        while ((match = tagRegex.exec(text)) !== null) {
            const ref = match[1]
            if (!seen.has(ref)) {
                seen.add(ref)
                refs.push(ref)
            }
        }
    }

    return refs
}

function extractMessageText(msg: any): string {
    const parts: string[] = []
    if (typeof msg?.content === "string") {
        parts.push(msg.content)
    } else if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
            if (typeof part === "string") parts.push(part)
            else if (part?.text) parts.push(part.text)
            else if (part?.content) parts.push(part.content)
        }
    }
    // ACP injects <dcp-message-id> tags into tool_calls arguments for
    // assistant messages that contain tool calls (no text content).
    if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
            if (tc?.function?.arguments) parts.push(String(tc.function.arguments))
        }
    }
    return parts.join("")
}

/**
 * Resolve a range specification to [startId, endId].
 * - "all": first and last ref
 * - [n, m]: nth and mth ref (0-indexed)
 */
function resolveRange(refs: string[], range: "all" | [number, number]): [string, string] {
    if (range === "all") {
        return [refs[0], refs[refs.length - 1]]
    }
    const [startIdx, endIdx] = range
    const start = refs[Math.min(startIdx, refs.length - 1)]
    const end = refs[Math.min(endIdx, refs.length - 1)]
    return [start, end]
}

// --- Response builders ---

function textResponse(model: string, text: string, isStream: boolean): Response {
    const usage = {
        prompt_tokens: Math.max(1, Math.ceil(text.length / 4)),
        completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
        total_tokens: Math.max(2, Math.ceil(text.length / 2)),
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: text },
                    finish_reason: "stop",
                },
            ],
            usage,
        })
    }

    return sseStream(model, [{ type: "text", content: text }], usage)
}

function compressResponse(
    model: string,
    args: Record<string, unknown>,
    acknowledgeRisk: boolean,
    isStream: boolean,
): Response {
    const fullArgs = { ...args }
    if (acknowledgeRisk) {
       ;(fullArgs as any).acknowledgeRisk = true
    }

    const argsJson = JSON.stringify(fullArgs)
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const usage = {
        prompt_tokens: Math.max(1, Math.ceil(argsJson.length / 4)),
        completion_tokens: Math.max(1, Math.ceil(argsJson.length / 4)),
        total_tokens: Math.max(2, Math.ceil(argsJson.length / 2)),
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: callId,
                                type: "function",
                                function: { name: "compress", arguments: argsJson },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage,
        })
    }

    return sseStream(
        model,
        [{ type: "tool_use", toolName: "compress", callId, args: argsJson }],
        usage,
    )
}

function toolUseResponse(
    model: string,
    toolName: string,
    args: Record<string, unknown>,
    isStream: boolean,
): Response {
    const argsJson = JSON.stringify(args)
    const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    const usage = {
        prompt_tokens: Math.max(1, Math.ceil(argsJson.length / 4)),
        completion_tokens: Math.max(1, Math.ceil(argsJson.length / 4)),
        total_tokens: Math.max(2, Math.ceil(argsJson.length / 2)),
    }

    if (!isStream) {
        return jsonResponse({
            id: `chatcmpl-fake-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                            {
                                id: callId,
                                type: "function",
                                function: { name: toolName, arguments: argsJson },
                            },
                        ],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage,
        })
    }

    return sseStream(
        model,
        [{ type: "tool_use", toolName, callId, args: argsJson }],
        usage,
    )
}

// --- SSE streaming ---

type StreamChunk =
    | { type: "text"; content: string }
    | { type: "tool_use"; toolName: string; callId: string; args: string }

function sseStream(model: string, chunks_data: StreamChunk[], usage: any): Response {
    const id = `chatcmpl-fake-${crypto.randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const encoder = new TextEncoder()

    const readable = new ReadableStream({
        start(controller) {
            for (const chunk of chunks_data) {
                if (chunk.type === "tool_use") {
                    // Tool call: declare in first chunk, args in second
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            role: "assistant",
                                            content: null,
                                            tool_calls: [
                                                {
                                                    index: 0,
                                                    id: chunk.callId,
                                                    type: "function",
                                                    function: { name: chunk.toolName, arguments: "" },
                                                },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: {
                                            tool_calls: [
                                                { index: 0, function: { arguments: chunk.args } },
                                            ],
                                        },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                                usage,
                            }),
                        ),
                    )
                } else {
                    // Text response: split into ~10 word-chunks for realistic streaming
                    const words = chunk.content.split(/(\s+)/)
                    const perChunk = Math.max(1, Math.ceil(words.length / 10))
                    const textChunks: string[] = []
                    for (let i = 0; i < words.length; i += perChunk) {
                        textChunks.push(words.slice(i, i + perChunk).join(""))
                    }

                    // First chunk: role + opening content
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [
                                    {
                                        index: 0,
                                        delta: { role: "assistant", content: textChunks[0] ?? "" },
                                        finish_reason: null,
                                    },
                                ],
                            }),
                        ),
                    )
                    // Subsequent chunks: content deltas
                    for (let i = 1; i < textChunks.length; i++) {
                        controller.enqueue(
                            encoder.encode(
                                sseLine({
                                    id,
                                    object: "chat.completion.chunk",
                                    created,
                                    model,
                                    choices: [
                                        { index: 0, delta: { content: textChunks[i] }, finish_reason: null },
                                    ],
                                }),
                            ),
                        )
                    }
                    // Final chunk: finish_reason + usage
                    controller.enqueue(
                        encoder.encode(
                            sseLine({
                                id,
                                object: "chat.completion.chunk",
                                created,
                                model,
                                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                                usage,
                            }),
                        ),
                    )
                }
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
        },
    })

    return new Response(readable, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
        },
    })
}

function sseLine(obj: any): string {
    return `data: ${JSON.stringify(obj)}\n\n`
}

// --- Startup ---

process.stderr.write(
    `[fake-llm] listening on http://${HOST}:${PORT}\n` +
        `[fake-llm] scenario: ${SCENARIO_PATH}\n` +
        `[fake-llm] ready (pid ${process.pid})\n`,
)
