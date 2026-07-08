export const COMPRESS_MESSAGE = `Collapse selected individual messages in the conversation into detailed summaries.

THE SUMMARY
Follow the HOW TO COMPRESS rules from the system prompt — keep every listed VERBATIM item, drop every listed noise category, and order by PRIORITY when space is tight. Do not restate the lists here; the system prompt is the single source of truth.

The summary must be self-contained — the original content can be restored via decompress if needed later. Write dense, scannable bullets. Every line must earn its place.

Non-negotiable: preserve verbatim — file paths with line numbers, function/class/type signatures, error messages and stack traces, decisions and their rationale (\"chose X over Y because Z\"), constraints discovered, exact values (versions, config keys, thresholds), user's overall goal + any changes/evolution to it + user intent (quote short messages) + purpose behind each action (experiment hypotheses, task goals). Drop — verbose logs after extracting the error, duplicate file reads, dead-end exploration (keep the lesson in one line), back-and-forth once the decision is captured. When space is tight, priority order: (1) user goals + goal evolution + intent + purpose + constraints, (2) decisions+rationale, (3) exact artifacts, (4) conclusions, (5) lessons learned.
If a message contains no significant technical decisions, code changes, or user requirements, produce a minimal one-line summary rather than a detailed one.

MESSAGE IDS
You specify individual raw messages by ID using the injected IDs visible in the conversation:

- \`mNNNNN\` IDs identify raw messages

Each message has an ID inside XML metadata tags like \`<dcp-message-id priority="high">m0007</dcp-message-id>\`.
The same ID tag appears in every tool output of the message it belongs to — each unique ID identifies one complete message.
Treat these tags as message metadata only, not as content to summarize. Use only the inner \`mNNNNN\` value as the \`messageId\`.
The \`priority\` attribute indicates relative context cost. You MUST compress high-priority messages when their full text is no longer necessary for the active task.
If prior compress-tool results are present, always compress and summarize them minimally only as part of a broader compression pass. Do not invoke the compress tool solely to re-compress an earlier compression result.
Messages marked as \`<dcp-message-id>BLOCKED</dcp-message-id>\` cannot be compressed.

Rules:

- Pick each \`messageId\` directly from injected IDs visible in context.
- Only use raw message IDs of the form \`mNNNNN\`.
- Ignore XML attributes such as \`priority\` when copying the ID; use only the inner \`mNNNNN\` value.
- Do not invent IDs. Use only IDs that are present in context.

BATCHING
Select MANY messages in a single tool call when they are safe to compress.
Each entry should summarize exactly one message, and the tool can receive as many entries as needed in one batch.

GENERAL CLEANUP
Use the topic "general cleanup" for broad cleanup passes.
During general cleanup, compress all medium and high-priority messages that are not relevant to the active task.
Optimize for reducing context footprint, not for grouping messages by topic.
Do not compress away still-active instructions, unresolved questions, or constraints that are likely to matter soon.
Prioritize the earliest messages in the context as they will be the least relevant to the active task.
General cleanup should be done periodically between other normal compression tool passes, not as the primary form of compression.
`
