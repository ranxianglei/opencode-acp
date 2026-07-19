/**
 * Hand-rolled tokenizer for content-coverage metrics.
 *
 * Why hand-rolled:
 * - ACP's @anthropic-ai/tokenizer is BPE — great for cost, bad for word-level recall.
 * - We need word-level tokens (unigrams) for ROUGE-style matching.
 * - No new runtime deps.
 *
 * Tokenization rules:
 * - English: `[a-z][a-z0-9_]+` words, length ≥ 4, not in stopword set
 * - Chinese: every CJK char as a unigram + every adjacent pair as a bigram (excluding stopword pairs)
 * - Punctuation, whitespace, and other scripts are separators (not tokenized)
 */

const ENGLISH_WORD_RE = /[a-z][a-z0-9_]+/g
const CJK_RE = /[\u4e00-\u9fff]/g
const FILE_PATH_RE = /(?:[a-zA-Z0-9_-]+\/){1,}[a-zA-Z0-9_-]+\.[a-zA-Z]{1,5}/g

const STOPWORDS = new Set<string>([
    "the","that","this","these","those","there","their","them","then","than","thats",
    "with","will","would","could","should","from","have","has","had","having","were","what",
    "which","when","where","while","your","yours","theirs","ours","mine","hers","whose",
    "they","them","those","these","this","that","such","some","same","other","another","each",
    "into","onto","upon","over","under","between","through","during","before","after","above",
    "below","among","across","along","around","about","because","since","unless",
    "although","though","whereas","whether","either","neither","both","also","only",
    "just","very","more","most","much","many","less","least","several","enough",
    "make","made","makes","making","take","took","taken","takes","taking","get","got",
    "getting","gets","give","gave","given","gives","giving","come","came","comes","coming",
    "were","been","being","have","make","want","need","using",
    "true","false","null","undefined","void","return","returns","returning","function",
    "const","class","interface","type","typeof","instanceof","import","export",
    "require","module","default","async","await","static","public","private",
    "protected","readonly","partial","abstract","virtual","override","final","super",
    "value","values","param","params","name","names",
    "test","tests","testing","tested","expect","expected","actual","actuals","result",
    "results","output","outputs","input","inputs","data","record","records","item","items",
    "like","want","need","used","uses","said","say","says","went","goes",
    "here","there","where","when","what","who","how","why","which","whose","whom",
    "yourself","myself","itself","themselves","ourselves","himself","herself",
    "yeah","okay","ok","yes","no","not","nor","or","and","but","if","then","else","elif",
    "when","while","for","to","of","in","on","at","by","with","from","into","onto",
    "的","是","了","在","和","与","或","也","都","就","还","又","才","再","已","将","会",
    "能","可","可以","要","想","需要","应该","必须","没","没有","不","非","无","莫",
    "我","你","他","她","它","我们","你们","他们","她们","它们","咱","咱们","自己",
    "这","那","这个","那个","这些","那些","这样","那样","这里","那里","这么","那么",
    "什么","怎么","为什么","哪","哪个","哪些","哪里","怎样","多少","几","多","少",
    "于","从","向","往","到","至","为","对于","关于","至于","由于","因为","所以",
    "但是","但","不过","然而","可是","只是","只有","除了","除非","无论","不管","尽管",
    "虽然","虽说","即使","即便","哪怕","一旦","如果","要是","假如","假使","倘若",
    "之","其","其中","其他","其它","其余","另一","另外","此外","并且","并","且",
    "着","过","吧","吗","呢","啊","哦","嗯","呀","哇","哈","嘛","咯","哟",
])

const ZH_STOPWORD_BIGRAMS = new Set<string>([
    "我们","你们","他们","她们","它们","咱们","这个","那个","这些","那些","什么","怎么",
    "为什么","如何","可以","应该","但是","因为","所以","如果","虽然","即使","尽管",
    "为了","由于","不但","而且","并且","或者","还是","以及","以为","于是","然而",
    "其实","就是","只是","只有","除了","除非","这样","那样","这么","那么","这些",
    "那些","这里","那里","现在","以后","以前","之后","之前","然后","当然","可能",
    "一些","许多","非常","十分","比较","更加","最为","也是","还是","就是","不过",
    "不要","不能","不会","没有","不是","不用","不必","一直","已经","正在","马上",
])

export interface TokenizeOptions {
    english?: boolean
    zhUnigrams?: boolean
    /** ZH bigrams reduce false positives — single chars like 的/了 are noisy even after stopword removal. */
    zhBigrams?: boolean
}

const DEFAULT_OPTS: Required<TokenizeOptions> = {
    english: true,
    zhUnigrams: true,
    zhBigrams: true,
}

export function tokenize(text: string, opts: TokenizeOptions = {}): string[] {
    if (!text || typeof text !== "string") return []
    const options = { ...DEFAULT_OPTS, ...opts }
    const tokens: string[] = []
    const lower = text.toLowerCase()

    if (options.english) {
        const matches = lower.match(ENGLISH_WORD_RE)
        if (matches) {
            for (const w of matches) {
                if (w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
                    tokens.push(w)
                }
            }
        }
    }

    if (options.zhUnigrams || options.zhBigrams) {
        const cjkChars = text.match(CJK_RE)
        if (cjkChars && cjkChars.length > 0) {
            const cjkStr = cjkChars.join("")
            if (options.zhUnigrams) {
                for (const c of cjkStr) {
                    if (!STOPWORDS.has(c)) tokens.push(c)
                }
            }
            if (options.zhBigrams) {
                for (let i = 0; i < cjkStr.length - 1; i++) {
                    const bg = cjkStr.slice(i, i + 2)
                    if (!ZH_STOPWORD_BIGRAMS.has(bg) && !STOPWORDS.has(bg[0]!) && !STOPWORDS.has(bg[1]!)) {
                        tokens.push(bg)
                    }
                }
            }
        }
    }

    return tokens
}

export function termFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>()
    for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    return tf
}

export function topKByTf(tokens: string[], k: number): string[] {
    if (tokens.length === 0 || k <= 0) return []
    const tf = termFrequency(tokens)
    const sorted = [...tf.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        return a[0].localeCompare(b[0])
    })
    return sorted.slice(0, k).map((e) => e[0])
}

export function extractFilePaths(text: string): Set<string> {
    if (!text) return new Set()
    const paths = new Set<string>()
    const matches = text.match(FILE_PATH_RE)
    if (matches) {
        for (const m of matches) paths.add(m)
    }
    return paths
}

/**
 * ROUGE-1 recall: fraction of original unigrams that also appear in summary.
 * Uses unique-token sets (type-level), not token counts.
 */
export function rouge1Recall(summaryTokens: string[], originalTokens: string[]): number {
    if (originalTokens.length === 0) return 0
    const summarySet = new Set(summaryTokens)
    const originalSet = new Set(originalTokens)
    let hit = 0
    for (const t of originalSet) if (summarySet.has(t)) hit++
    return hit / originalSet.size
}

export function rouge1Precision(summaryTokens: string[], originalTokens: string[]): number {
    if (summaryTokens.length === 0) return 0
    const summarySet = new Set(summaryTokens)
    const originalSet = new Set(originalTokens)
    let hit = 0
    for (const t of summarySet) if (originalSet.has(t)) hit++
    return hit / summarySet.size
}

export function rouge1F1(summaryTokens: string[], originalTokens: string[]): number {
    const r = rouge1Recall(summaryTokens, originalTokens)
    const p = rouge1Precision(summaryTokens, originalTokens)
    if (r + p === 0) return 0
    return (2 * r * p) / (r + p)
}

export function topKRecall(summaryTokens: string[], originalTokens: string[], k: number): number {
    if (originalTokens.length === 0 || k <= 0) return 0
    const top = topKByTf(originalTokens, k)
    if (top.length === 0) return 0
    const summarySet = new Set(summaryTokens)
    let hit = 0
    for (const t of top) if (summarySet.has(t)) hit++
    return hit / top.length
}

export function jaccardSimilarity(a: string[], b: string[]): number {
    const setA = new Set(a)
    const setB = new Set(b)
    if (setA.size === 0 && setB.size === 0) return 0
    let inter = 0
    for (const t of setA) if (setB.has(t)) inter++
    return inter / (setA.size + setB.size - inter)
}
