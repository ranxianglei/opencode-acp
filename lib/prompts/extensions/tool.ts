// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

export const RANGE_FORMAT_EXTENSION = `

THE FORMAT OF COMPRESS

\`\`\`
{
  topic?: string,          // OPTIONAL top-level fallback topic for entries without their own.
  content: [               // One or more ranges to compress
    {
      topic?: string,      // OPTIONAL per-range topic; overrides the top-level fallback.
      startId: string,     // Boundary ID at range start: mNNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
\`\`\`
Each entry needs a topic — either its own or the top-level fallback.`

export const MESSAGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

\`\`\`
{
  topic: string,           // Short label (3-5 words) for the overall batch
  content: [               // One or more messages to compress independently
    {
      messageId: string,   // Raw message ID only: mNNNNN (ignore metadata attributes like priority)
      topic: string,       // Short label (3-5 words) for this one message summary
      summary: string      // Complete technical summary replacing that one message
    }
  ]
}
\`\`\``
