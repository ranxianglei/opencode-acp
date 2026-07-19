import assert from "node:assert/strict"
import test from "node:test"

import {
    tokenize,
    termFrequency,
    topKByTf,
    extractFilePaths,
    rouge1Recall,
    rouge1Precision,
    rouge1F1,
    topKRecall,
    jaccardSimilarity,
} from "../lib/compress/quality-gate/tokenizer"

test("tokenize returns empty for empty input", () => {
    assert.deepEqual(tokenize(""), [])
    assert.deepEqual(tokenize(undefined as unknown as string), [])
})

test("tokenize extracts English words of length >= 4", () => {
    const tokens = tokenize("the quick brown fox jumps swiftly past lazy dogs running")
    const set = new Set(tokens)
    assert.ok(set.has("quick"), "quick (5 chars) should be kept")
    assert.ok(set.has("brown"), "brown (5 chars) should be kept")
    assert.ok(set.has("jumps"), "jumps (5 chars) should be kept")
    assert.ok(set.has("swiftly"), "swiftly (7 chars) should be kept")
    assert.ok(set.has("lazy"), "lazy (4 chars) should be kept")
    assert.ok(set.has("dogs"), "dogs (4 chars) should be kept")
    assert.ok(set.has("running"), "running (7 chars) should be kept")
    assert.ok(!set.has("the"), "'the' should be stopworded")
    assert.ok(!set.has("fox"), "'fox' (3 chars) should be too short")
})

test("tokenize lowercases input", () => {
    const tokens = new Set(tokenize("Compression Pipeline Framework"))
    assert.ok(tokens.has("compression"))
    assert.ok(tokens.has("pipeline"))
    assert.ok(tokens.has("framework"))
})

test("tokenize filters pure-digit tokens", () => {
    const tokens = new Set(tokenize("version 12345 and 9999"))
    assert.ok(!tokens.has("12345"))
    assert.ok(!tokens.has("9999"))
})

test("tokenize keeps alphanumeric words like 'utf8' and 'b32encoder'", () => {
    const tokens = new Set(tokenize("utf8 b32encoder file5"))
    assert.ok(tokens.has("utf8"))
    assert.ok(tokens.has("b32encoder"))
    assert.ok(tokens.has("file5"))
})

test("tokenize extracts Chinese unigrams and bigrams", () => {
    const tokens = tokenize("模型压缩质量门")
    const set = new Set(tokens)
    const unigrams = ["模", "型", "压", "缩", "质", "量", "门"]
    for (const c of unigrams) assert.ok(set.has(c), `unigram ${c} should be present`)
    const bigrams = ["模型", "型压", "压缩", "缩质", "质量", "量门"]
    for (const bg of bigrams) assert.ok(set.has(bg), `bigram ${bg} should be present`)
})

test("tokenize filters Chinese stopwords", () => {
    const tokens = new Set(tokenize("我们的压缩"));
    assert.ok(!tokens.has("我"), "'我' is a stopword");
    assert.ok(tokens.has("压"), "'压' is content");
    assert.ok(tokens.has("缩"), "'缩' is content");
    assert.ok(!tokens.has("我们"), "'我们' is a stopword bigram");
    assert.ok(tokens.has("压缩"), "'压缩' is content bigram");
})

test("tokenize handles mixed EN+ZH input", () => {
    const tokens = new Set(tokenize("Compression 压缩 quality 质量 gate"))
    assert.ok(tokens.has("compression"))
    assert.ok(tokens.has("quality"))
    assert.ok(tokens.has("压"))
    assert.ok(tokens.has("缩"))
    assert.ok(tokens.has("质"))
})

test("tokenize english=false skips english words", () => {
    const tokens = new Set(tokenize("compression 压缩", { english: false }))
    assert.ok(!tokens.has("compression"))
    assert.ok(tokens.has("压"))
})

test("tokenize zhBigrams=false disables bigram extraction", () => {
    const tokens = new Set(tokenize("压缩", { zhBigrams: false }))
    assert.ok(tokens.has("压"))
    assert.ok(tokens.has("缩"))
    assert.ok(!tokens.has("压缩"))
})

test("termFrequency counts occurrences", () => {
    const tf = termFrequency(tokenize("quality quality quality compression compression"))
    assert.equal(tf.get("quality"), 3)
    assert.equal(tf.get("compression"), 2)
})

test("topKByTf returns top K by frequency, ties broken alphabetically", () => {
    const tokens = tokenize("alpha alpha beta beta gamma delta delta delta epsilon")
    const top3 = topKByTf(tokens, 3)
    assert.ok(top3.includes("delta"), "delta (3 occurrences) should be in top 3")
    assert.ok(top3.includes("alpha"), "alpha (2) should be in top 3")
    assert.ok(top3.includes("beta"), "beta (2) should be in top 3 (alphabetical tiebreak)")
})

test("topKByTf with k=0 returns empty", () => {
    assert.deepEqual(topKByTf(["a", "b", "c"], 0), [])
})

test("topKByTf with empty input returns empty", () => {
    assert.deepEqual(topKByTf([], 5), [])
})

test("extractFilePaths captures lib/foo.ts style paths", () => {
    const paths = extractFilePaths("see lib/hooks.ts and src/index.ts:12 and deep/dir/file.py")
    assert.ok(paths.has("lib/hooks.ts"))
    assert.ok(paths.has("src/index.ts"))
    assert.ok(paths.has("deep/dir/file.py"))
})

test("extractFilePaths ignores bare filenames without slash", () => {
    const paths = extractFilePaths("foo.ts and bar.py without path")
    assert.equal(paths.size, 0, "bare filenames should not match (need at least one slash)")
})

test("extractFilePaths returns empty for input without paths", () => {
    assert.equal(extractFilePaths("just plain text").size, 0)
    assert.equal(extractFilePaths("").size, 0)
})

test("rouge1Recall: identical token sets -> 1.0", () => {
    const tokens = ["quality", "gate", "compression"]
    assert.equal(rouge1Recall(tokens, tokens), 1.0)
})

test("rouge1Recall: disjoint token sets -> 0.0", () => {
    assert.equal(rouge1Recall(["alpha"], ["beta", "gamma"]), 0.0)
})

test("rouge1Recall: summary covers half of original unique tokens -> 0.5", () => {
    const summary = ["compression", "gate"]
    const original = ["compression", "gate", "quality", "threshold"]
    assert.equal(rouge1Recall(summary, original), 0.5)
})

test("rouge1Recall: empty original -> 0", () => {
    assert.equal(rouge1Recall(["alpha"], []), 0)
})

test("rouge1Precision: identical token sets -> 1.0", () => {
    const tokens = ["quality", "gate"]
    assert.equal(rouge1Precision(tokens, tokens), 1.0)
})

test("rouge1Precision: empty summary -> 0", () => {
    assert.equal(rouge1Precision([], ["alpha", "beta"]), 0)
})

test("rouge1F1: identical sets -> 1.0", () => {
    const tokens = ["alpha", "beta"]
    assert.equal(rouge1F1(tokens, tokens), 1.0)
})

test("rouge1F1: disjoint sets -> 0", () => {
    assert.equal(rouge1F1(["alpha"], ["beta"]), 0)
})

test("rouge1F1: partial overlap yields intermediate value", () => {
    // summary={a,b}, original={b,c,d} -> recall=1/3, precision=1/2, F1=0.4
    const r = rouge1F1(["a", "b"], ["b", "c", "d"])
    assert.ok(r > 0 && r < 1)
    assert.ok(Math.abs(r - 0.4) < 0.01, `expected ~0.4, got ${r}`)
})

test("topKRecall: summary covers all top-K -> 1.0", () => {
    const summary = ["alpha", "beta", "gamma"]
    const original = ["alpha", "alpha", "beta", "beta", "gamma", "gamma", "delta"]
    assert.equal(topKRecall(summary, original, 3), 1.0)
})

test("topKRecall: summary covers none -> 0.0", () => {
    assert.equal(topKRecall(["delta"], ["alpha", "beta", "gamma"], 3), 0.0)
})

test("topKRecall: K larger than original unique count", () => {
    const summary = ["alpha"]
    const original = ["alpha", "beta"]
    assert.equal(topKRecall(summary, original, 10), 0.5)
})

test("jaccardSimilarity: identical sets -> 1.0", () => {
    const tokens = ["a", "b", "c"]
    assert.equal(jaccardSimilarity(tokens, tokens), 1.0)
})

test("jaccardSimilarity: disjoint sets -> 0.0", () => {
    assert.equal(jaccardSimilarity(["a"], ["b"]), 0.0)
})

test("jaccardSimilarity: half overlap -> 1/3", () => {
    const j = jaccardSimilarity(["a", "b"], ["b", "c"])
    assert.ok(Math.abs(j - 1 / 3) < 0.01)
})

test("jaccardSimilarity: both empty -> 0", () => {
    assert.equal(jaccardSimilarity([], []), 0)
})
