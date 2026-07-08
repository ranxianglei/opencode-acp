import assert from "node:assert/strict"
import test from "node:test"
import {
    isImportantUserMessage,
    isLikelyDataInput,
    detectImportance,
} from "../lib/messages/importance-detector"

test("isLikelyDataInput: returns false for short natural-language text", () => {
    assert.equal(isLikelyDataInput("Remember to fix the bug"), false)
    assert.equal(isLikelyDataInput("记住这一点"), false)
})

test("isLikelyDataInput: returns true for log output with timestamps", () => {
    const log = [
        "2024-01-15 10:30:00 INFO  Starting server",
        "2024-01-15 10:30:01 ERROR Failed to connect",
        "2024-01-15 10:30:02 WARN  Retrying",
        "2024-01-15 10:30:03 INFO  Connected",
        "2024-01-15 10:30:04 DEBUG Running query",
    ].join("\n")
    assert.equal(isLikelyDataInput(log), true)
})

test("isLikelyDataInput: returns true for high code-block ratio", () => {
    const codeHeavy = "Here is the code:\n```python\n" + "x = 1\n".repeat(50) + "```\nDone."
    assert.equal(isLikelyDataInput(codeHeavy), true)
})

test("isLikelyDataInput: returns false for low code-block ratio", () => {
    const textLight = "Make sure you remember this: the config is at /etc/app.conf\n```\nx=1\n```"
    assert.equal(isLikelyDataInput(textLight), false)
})

test("isLikelyDataInput: returns true for diff output", () => {
    const diff = "diff --git a/file.ts b/file.ts\n@@ -1,3 +1,5 @@\n-old line\n+new line"
    assert.equal(isLikelyDataInput(diff), true)
})

test("isLikelyDataInput: returns true for tool output (git log)", () => {
    const gitLog = "commit abc1234\nAuthor: John <john@example.com>\nDate: Mon Jan 1\n\n    Fix bug"
    assert.equal(isLikelyDataInput(gitLog), true)
})

test("detectImportance: returns categories for important text", () => {
    const result = detectImportance("You must never forget this constraint")
    assert.equal(result.important, true)
    assert.ok(result.categories.length > 0)
})

test("detectImportance: returns empty for neutral text", () => {
    const result = detectImportance("The weather is nice today")
    assert.equal(result.important, false)
    assert.equal(result.categories.length, 0)
})

test("isImportantUserMessage: zh importance markers", () => {
    assert.equal(isImportantUserMessage("记住这一点很重要"), true)
    assert.equal(isImportantUserMessage("切记不要用 as any"), true)
    assert.equal(isImportantUserMessage("关键在于并发控制"), true)
    assert.equal(isImportantUserMessage("请记住这个配置"), true)
    assert.equal(isImportantUserMessage("务必先测试再提交"), true)
    assert.equal(isImportantUserMessage("特别注意的是这个参数"), true)
})

test("isImportantUserMessage: zh imperative markers", () => {
    assert.equal(isImportantUserMessage("你必须先运行测试"), true)
    assert.equal(isImportantUserMessage("一定要处理边界情况"), true)
    assert.equal(isImportantUserMessage("绝对不能删除这些文件"), true)
    assert.equal(isImportantUserMessage("无论如何都要在明天前完成"), true)
    assert.equal(isImportantUserMessage("严禁修改这个文件"), true)
})

test("isImportantUserMessage: zh correction markers", () => {
    assert.equal(isImportantUserMessage("不对，应该是用 map 而不是 forEach"), true)
    assert.equal(isImportantUserMessage("你理解错了，我的意思是"), true)
    assert.equal(isImportantUserMessage("我说的是另一个文件"), true)
    assert.equal(isImportantUserMessage("怎么又犯同样的错误"), true)
})

test("isImportantUserMessage: zh reminder markers", () => {
    assert.equal(isImportantUserMessage("我之前提到过这个问题"), true)
    assert.equal(isImportantUserMessage("按照之前说的做"), true)
    assert.equal(isImportantUserMessage("还记得吗，我们讨论过这个"), true)
    assert.equal(isImportantUserMessage("如前所述，需要处理错误"), true)
})

test("isImportantUserMessage: zh non-negotiable markers", () => {
    assert.equal(isImportantUserMessage("这是硬性要求，不能更改"), true)
    assert.equal(isImportantUserMessage("强制使用 TypeScript"), true)
    assert.equal(isImportantUserMessage("这是底线，不允许突破"), true)
})

test("isImportantUserMessage: en importance markers", () => {
    assert.equal(isImportantUserMessage("Remember this: the API key is at /etc/key"), true)
    assert.equal(isImportantUserMessage("This is important — don't skip the migration"), true)
    assert.equal(isImportantUserMessage("Key point: always validate input"), true)
    assert.equal(isImportantUserMessage("It's crucial that you handle null values"), true)
    assert.equal(isImportantUserMessage("Note that this only works in production"), true)
    assert.equal(isImportantUserMessage("Keep in mind the rate limit is 100/s"), true)
})

test("isImportantUserMessage: en imperative markers", () => {
    assert.equal(isImportantUserMessage("You must run the tests before committing"), true)
    assert.equal(isImportantUserMessage("Make sure to handle the error case"), true)
    assert.equal(isImportantUserMessage("Ensure that the port is open"), true)
    assert.equal(isImportantUserMessage("It is required to use strict mode"), true)
    assert.equal(isImportantUserMessage("This is mandatory for all PRs"), true)
})

test("isImportantUserMessage: en correction markers", () => {
    assert.equal(isImportantUserMessage("That's wrong, I meant the other file"), true)
    assert.equal(isImportantUserMessage("You misunderstood — I said left, not right"), true)
    assert.equal(isImportantUserMessage("Not what I said. Do it again."), true)
    assert.equal(isImportantUserMessage("I already told you about this issue"), true)
    assert.equal(isImportantUserMessage("Actually, the issue is in the config"), true)
})

test("isImportantUserMessage: en reminder markers", () => {
    assert.equal(isImportantUserMessage("As I mentioned earlier, the timeout is 30s"), true)
    assert.equal(isImportantUserMessage("Like I said before, check the logs first"), true)
    assert.equal(isImportantUserMessage("Per our discussion, use the v2 API"), true)
    assert.equal(isImportantUserMessage("As discussed, we'll deploy on Friday"), true)
})

test("isImportantUserMessage: en non-negotiable markers", () => {
    assert.equal(isImportantUserMessage("This is a deal breaker — must support IE11"), true)
    assert.equal(isImportantUserMessage("Non-negotiable: the build must pass"), true)
    assert.equal(isImportantUserMessage("Under no circumstances should you push to main"), true)
})

test("isImportantUserMessage: excludes log output with importance keyword inside", () => {
    const log = [
        "2024-01-15 10:30:00 ERROR This is important: connection failed",
        "2024-01-15 10:30:01 WARN  Remember to check logs",
        "2024-01-15 10:30:02 INFO  You must restart the server",
        "2024-01-15 10:30:03 DEBUG Critical path reached",
        "2024-01-15 10:30:04 INFO  Done",
    ].join("\n")
    assert.equal(isImportantUserMessage(log), false)
})

test("isImportantUserMessage: excludes code with 'remember' inside", () => {
    const code =
        "Here's the function:\n```python\n# remember this critical value\nCRITICAL = 42\n```\nThat's it."
    assert.equal(isImportantUserMessage(code), false)
})

test("isImportantUserMessage: excludes git diff with 'must' inside", () => {
    const diff =
        "diff --git a/config.ts b/config.ts\n@@ -1,3 +1,3 @@\n-you must not change this\n+you must change this"
    assert.equal(isImportantUserMessage(diff), false)
})

test("isImportantUserMessage: returns false for empty string", () => {
    assert.equal(isImportantUserMessage(""), false)
    assert.equal(isImportantUserMessage("   "), false)
})

test("isImportantUserMessage: returns false for neutral text", () => {
    assert.equal(isImportantUserMessage("The weather is nice today"), false)
    assert.equal(isImportantUserMessage("Can you help me with this?"), false)
    assert.equal(isImportantUserMessage("这是一个普通的句子"), false)
})

test("isImportantUserMessage: mixed zh+en text works", () => {
    assert.equal(isImportantUserMessage("记住: make sure the build passes"), true)
    assert.equal(isImportantUserMessage("This is crucial — 务必处理"), true)
})
