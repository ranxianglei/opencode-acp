export const COMPRESS_MESSAGE_PROMPT = `You are compressing individual messages into summaries.

For EACH message:
1. Identify the core information (what was the purpose of this message?)
2. Remove redundant content (repeated context, verbose explanations)
3. Preserve essential data:
   - Tool call parameters and results (summarize, don't copy)
   - Code snippets (keep critical ones, summarize the rest)
   - Error details (keep the error type and resolution)
4. Write a concise but complete summary

Each message gets its OWN summary — do not merge messages together.

Your summaries will replace the individual messages. Keep them focused and information-dense.`
