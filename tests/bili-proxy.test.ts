import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BILI_PROXY_MARKER, findBiliProxyProviders } from "../lib/bili-proxy"

describe("BILI_PROXY_MARKER", () => {
    it("is the /bili/ path prefix", () => {
        assert.equal(BILI_PROXY_MARKER, "/bili/")
    })
})

describe("findBiliProxyProviders", () => {
    it("returns [] for undefined, null, and non-object input", () => {
        assert.deepEqual(findBiliProxyProviders(undefined), [])
        assert.deepEqual(findBiliProxyProviders(null), [])
        assert.deepEqual(findBiliProxyProviders("http://x/bili/y"), [])
        assert.deepEqual(findBiliProxyProviders(42), [])
    })

    it("returns [] for an empty provider map", () => {
        assert.deepEqual(findBiliProxyProviders({}), [])
    })

    it("matches a provider whose options.baseURL contains /bili/", () => {
        const matches = findBiliProxyProviders({
            openai: {
                options: {
                    baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1",
                },
            },
        })
        assert.equal(matches.length, 1)
        assert.equal(matches[0].provider, "openai")
        assert.equal(matches[0].baseURL, "http://127.0.0.1:8787/bili/https://api.openai.com/v1")
    })

    it("matches a bare proxy baseURL ending in /bili/", () => {
        const matches = findBiliProxyProviders({
            anthropic: {
                options: { baseURL: "http://proxy-host:8787/bili/" },
            },
        })
        assert.equal(matches.length, 1)
        assert.equal(matches[0].provider, "anthropic")
    })

    it("matches a top-level baseURL (defensive fallback)", () => {
        const matches = findBiliProxyProviders({
            google: {
                baseURL: "http://127.0.0.1:8787/bili/https://generativelanguage.googleapis.com",
            },
        })
        assert.equal(matches.length, 1)
        assert.equal(matches[0].provider, "google")
    })

    it("prefers options.baseURL over top-level baseURL", () => {
        // options.baseURL wins: no marker there → no match even if top-level has one
        const none = findBiliProxyProviders({
            p: {
                baseURL: "http://x/bili/y",
                options: { baseURL: "https://direct.example.com/v1" },
            },
        })
        assert.deepEqual(none, [])

        // options.baseURL wins: marker there → match reports options value
        const some = findBiliProxyProviders({
            p: {
                baseURL: "https://direct.example.com/v1",
                options: { baseURL: "http://x/bili/y" },
            },
        })
        assert.equal(some.length, 1)
        assert.equal(some[0].baseURL, "http://x/bili/y")
    })

    it("returns all matching providers when several route through the proxy", () => {
        const matches = findBiliProxyProviders({
            openai: {
                options: { baseURL: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" },
            },
            anthropic: { options: { baseURL: "https://api.anthropic.com" } },
            google: {
                options: {
                    baseURL: "http://127.0.0.1:8787/bili/https://generativelanguage.googleapis.com",
                },
            },
        })
        assert.deepEqual(
            matches.map((m) => m.provider),
            ["openai", "google"],
        )
    })

    it("returns [] when no provider routes through the proxy", () => {
        assert.deepEqual(
            findBiliProxyProviders({
                openai: { options: { baseURL: "https://api.openai.com/v1" } },
                anthropic: { options: { apiKey: "sk-test" } },
                google: {},
            }),
            [],
        )
    })

    it("ignores non-string and empty baseURL values", () => {
        assert.deepEqual(
            findBiliProxyProviders({
                a: { options: { baseURL: 8787 } },
                b: { options: { baseURL: { host: "x" } } },
                c: { options: { baseURL: "" } },
                d: { options: {} },
                e: null,
                f: "not-an-object",
            }),
            [],
        )
    })

    it("does not match lookalike paths (/bilix/, bilibili.com, /bili without slash)", () => {
        assert.deepEqual(
            findBiliProxyProviders({
                a: { options: { baseURL: "http://x/bilix/v1" } },
                b: { options: { baseURL: "https://bilibili.com/api" } },
                c: { options: { baseURL: "http://x/bili" } },
                d: { options: { baseURL: "https://api.bili.example.com/v1" } },
            }),
            [],
        )
    })
})
