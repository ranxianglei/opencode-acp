export const COMPRESS_RANGE_PROMPT = `You are compressing a range of messages into a high-fidelity summary.

INSTRUCTIONS:
1. Read ALL messages in the specified range carefully
2. Create a summary that preserves EVERY essential detail:
   - Decisions made and WHY (not just what)
   - File paths, function names, variable names
   - Error messages and how they were resolved
   - User requirements, constraints, and preferences
   - Key code snippets or configurations
   - Architectural choices and their trade-offs
3. Use clear structure: topic, then bullet points of key facts
4. Do NOT lose any information that could be needed later
5. Include recovery breadcrumbs (file paths, function signatures, variable names)

FORMAT:
Topic: [brief topic name]
- [key fact with specific details]
- [another key fact]
...

ANTI-PATTERNS (avoid):
- "Discussed implementation details" (too vague — what details?)
- "Fixed the bug" (which bug? how?)
- "Reviewed code" (what was found?)

Your summary will replace the original messages. Make it dense but complete.`
