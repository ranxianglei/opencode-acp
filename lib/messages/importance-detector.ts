/**
 * Importance Detector — two-stage classifier for user messages:
 * 1. Gate: exclude obvious data-input (logs, code, JSON, tool output)
 * 2. Detect: check remaining natural-language text for importance markers (zh+en)
 *
 * Regex patterns are opaque without labels — the per-pattern comments below
 * are the only way to know what each regex matches. Do NOT remove them.
 */

const DATA_INPUT_MIN_CHARS = 2000
const CODE_BLOCK_RATIO_THRESHOLD = 0.4

/** Log output: timestamps, log levels, stack traces */
const LOG_OUTPUT_RE =
    /^\s*(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}[\sT]\d{1,2}:\d{2}|\[?(?:ERROR|ERR|WARN(?:ING)?|FATAL|CRITICAL|Error|Failed|Failure|Exception)\]?\b|at\s+[\w$.]+\s+\(.*:\d+:\d+\)|Traceback \(most recent call last\))/m

/** Diff/conflict output */
const DIFF_OUTPUT_RE = /^(?:diff --git\b|@@\s+-\d+|<<<<<<<|=======|>>>>>>>)/m

/** Tool output: git/npm/docker/HTTP/ls/test results */
const TOOL_OUTPUT_RE =
    /^(?:commit\s+[0-9a-f]{7,40}|(?:Author|Date):\s|npm\s+(?:WARN|ERR!|verb|info)\b|added\s+\d+\s+packages|CONTAINER\s+ID\s+IMAGE|HTTP\/[\d.]+\s+\d{3}\s|\s*[drwx-]{10}\s+\d+|\s*(?:✓|✗)\s)/m

/** Structured data: XML/PEM */
const STRUCTURED_DATA_RE = /^\s*(?:<\?xml|<root>|-----BEGIN\s+[A-Z])/m

function countCodeBlockChars(text: string): number {
    let total = 0
    for (const match of text.matchAll(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)) {
        total += match[0].length
    }
    return total
}

function isLogLine(line: string): boolean {
    return /^\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}[\sT]/.test(line)
}

/**
 * Returns true when the message is predominantly data input (logs, code,
 * structured data, tool output) and should be excluded from importance
 * protection even if it happens to contain an importance keyword.
 */
export function isLikelyDataInput(text: string): boolean {
    const trimmed = text.trim()
    if (!trimmed) return false

    if (trimmed.length >= DATA_INPUT_MIN_CHARS) {
        const lines = trimmed.split("\n")
        const logLines = lines.filter(isLogLine).length
        const nonEmptyLines = lines.filter((l) => l.trim().length > 0).length
        if (nonEmptyLines > 0 && logLines / nonEmptyLines >= 0.5) return true
    }

    if (trimmed.length > 0) {
        const codeChars = countCodeBlockChars(trimmed)
        if (codeChars / trimmed.length >= CODE_BLOCK_RATIO_THRESHOLD) return true
    }

    return (
        DIFF_OUTPUT_RE.test(trimmed) ||
        TOOL_OUTPUT_RE.test(trimmed) ||
        STRUCTURED_DATA_RE.test(trimmed) ||
        LOG_OUTPUT_RE.test(trimmed)
    )
}

/** Strip fenced/inline code blocks so keywords inside code don't false-positive. */
function stripCodeBlocks(text: string): string {
    return text
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/~~~[\s\S]*?~~~/g, " ")
        .replace(/`[^`\n]+`/g, " ")
}

// --- Chinese importance markers ---

/** zh: importance/emphasis */
const ZH_IMPORTANCE_RE =
    /记住这个|这一点?很重要|关键(?:在于|是|点|性)|切记|核心是|最重要的是|特别注意|重点是?|请记住|牢牢?记住|牢记|务必记住|要紧的是|重中之重|千万(?:记住|要|注意|别)|尤其(?:要|注意)|格外注意|我再强调一遍|反复强调|特别提醒|至关重要|极其重要|不可忽视|请务必|千万别忘了|一定要记牢/g

/** zh: imperative/constraint */
const ZH_IMPERATIVE_RE =
    /你必须|你需要确保|你一定要|一定要|一定不(?:要|能)|绝对不?能|不管怎样|无论如何|务必(?:做到|记住|先|要|请)?|必须(?:确保|做到)?|请?确保|请?保证|要保证|切不可|万不可|千万不?能|千万别|绝不?能|绝不允许|绝对禁止|严禁|不能忘记|不要忘了|别忘了|务(?:须|求)/g

/** zh: error correction/frustration */
const ZH_CORRECTION_RE =
    /不对|又错了|错了|应该是|我说的是|不是这个意思|你(?:理解错|弄错|搞错|又搞错)了|误解了|我之前说过了|怎么(?:又|总是|老是)|而不是|不是[这样那样]|我不是这个意思|你(?:又|又搞)|反复说|说了多少遍了|我都说了|跟你说过|跟你说多少次了|不是让你|我(?:要|想要)的是|你搞反了|搞混了|别(?:再|老是)|又说错了/g

/** zh: reminder/reference to past context */
const ZH_REMINDER_RE =
    /我之前(?:提到|要求|强调(?:过)?)|按照之前(?:说的|的要求)|按照(?:约定|我们说好的)|还记得(?:吗|我说的吗)?|上面(?:说过|提到)|我强调过|之前(?:说过|讨论(?:的|过)|确定的|定的|告诉你的|强调的)|如前所述|如上所述|前面(?:提到|强调过|说的)|刚才说的|刚才提到的|我刚才说|我早就说过|早前说过|一开始就说了|我反复说过|我开头就说过|我一开始就|上次说过的|前文提到|别忘了之前|我早已说过|记得吗/g

/** zh: non-negotiable requirement */
const ZH_NONNEGOTIABLE_RE =
    /硬性(?:要求|规定|条件)|强制(?:性|要求|规定)?|不(?:允许|接受|容妥协|可妥协|可违背|可违反|可更改|可变通|可逾越|容违背)|禁止|必须(?:遵守|满足|执行|做到|坚持)|没得商量|死要求|铁律|底线|红线|一律(?:不得|不允许)?|明令禁止|绝不妥协|绝对不行|刚性要求|硬指标|一定要满足|断无商量/g

// --- English importance markers ---

/** en: importance/emphasis */
const EN_IMPORTANCE_RE =
    /\b(?:remember this|this is important|key point|the key thing|crucial|critical|essential|vital|make sure|don't forget|do not forget|note that|take note|please note|keep in mind|bear in mind|above all|most importantly|of utmost importance|it's vital that|it is vital that|this matters|this really matters|pay attention to|worth noting|it's worth noting|the most important|above all else|this is key|the key is)\b/gi

/** en: imperative/constraint */
const EN_IMPERATIVE_RE =
    /\b(?:you must|you must not|you need to|you have to|you are required to|make sure to|be sure to|ensure that|ensure you|it is required|it is mandatory|must have|needs to be|you should always|you should never|no matter what|at all costs|it's imperative that|it is imperative|you are to|make certain|double check|be careful to)\b/gi

/** en: error correction/frustration */
const EN_CORRECTION_RE =
    /\b(?:that's wrong|that is wrong|no,?\s+i meant|i meant|incorrect|that's incorrect|not what i said|that's not what i said|you misunderstood|you misunderstood me|i already told you|i told you|stop doing|stop doing that|i said|that's not right|that is not right|that's not correct|you got it wrong|you're wrong|you are wrong|that's a mistake|misunderstood|i didn't say that|i did not say that|that's backwards|correction|actually,?\s+(?:no|wrong|the|this|it|that|we|i|you)\b)\b/gi

/** en: reminder/reference to past context */
const EN_REMINDER_RE =
    /\b(?:as i mentioned|as i mentioned earlier|like i said before|like i said|as i said|per our discussion|as discussed|as we discussed|remember when|i mentioned earlier|as previously stated|as noted earlier|as we went over|going back to|to recap|as before|i said earlier|as i said before|like we talked about|as we talked about|earlier i said|as i noted|from earlier)\b/gi

/** en: non-negotiable requirement */
const EN_NONNEGOTIABLE_RE =
    /\b(?:deal breaker|dealbreaker|deal-breaker|non-negotiable|nonnegotiable|hard requirement|hard requirements|under no circumstances|absolutely must|no exceptions|without exception|set in stone|not optional|this is non-negotiable|strictly required|firm requirement|absolute requirement|this is a must|cannot compromise|can't compromise|no compromises|mandatory requirement|ironclad|this is mandatory|no ifs,?\s*ands,?\s*or buts)\b/gi

const ALL_IMPORTANCE_PATTERNS: RegExp[] = [
    ZH_IMPORTANCE_RE,
    ZH_IMPERATIVE_RE,
    ZH_CORRECTION_RE,
    ZH_REMINDER_RE,
    ZH_NONNEGOTIABLE_RE,
    EN_IMPORTANCE_RE,
    EN_IMPERATIVE_RE,
    EN_CORRECTION_RE,
    EN_REMINDER_RE,
    EN_NONNEGOTIABLE_RE,
]

export type ImportanceCategory =
    | "importance"
    | "imperative"
    | "correction"
    | "reminder"
    | "nonnegotiable"

export interface ImportanceResult {
    important: boolean
    categories: ImportanceCategory[]
    matchedPatterns: string[]
}

const CATEGORY_CHECKS: Array<{ category: ImportanceCategory; regex: RegExp }> = [
    { category: "importance", regex: ZH_IMPORTANCE_RE },
    { category: "imperative", regex: ZH_IMPERATIVE_RE },
    { category: "correction", regex: ZH_CORRECTION_RE },
    { category: "reminder", regex: ZH_REMINDER_RE },
    { category: "nonnegotiable", regex: ZH_NONNEGOTIABLE_RE },
    { category: "importance", regex: EN_IMPORTANCE_RE },
    { category: "imperative", regex: EN_IMPERATIVE_RE },
    { category: "correction", regex: EN_CORRECTION_RE },
    { category: "reminder", regex: EN_REMINDER_RE },
    { category: "nonnegotiable", regex: EN_NONNEGOTIABLE_RE },
]

export function detectImportance(text: string): ImportanceResult {
    const stripped = stripCodeBlocks(text)
    const categories: ImportanceCategory[] = []
    const matchedPatterns: string[] = []

    for (const { category, regex } of CATEGORY_CHECKS) {
        regex.lastIndex = 0
        const matches = stripped.match(regex)
        if (!matches || matches.length === 0) continue

        if (!categories.includes(category)) categories.push(category)
        for (const m of matches) {
            const lower = m.toLowerCase().trim()
            if (!matchedPatterns.includes(lower)) matchedPatterns.push(lower)
        }
    }

    return { important: categories.length > 0, categories, matchedPatterns }
}

/**
 * Main entry point: returns true when a user message should be
 * hard-excluded from compression (important instruction detected).
 */
export function isImportantUserMessage(text: string): boolean {
    if (!text || !text.trim()) return false
    if (isLikelyDataInput(text)) return false
    return detectImportance(text).important
}
