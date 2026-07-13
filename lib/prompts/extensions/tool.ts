// These format schemas are kept separate from the editable compress prompts
// so they cannot be modified via custom prompt overrides. The schemas must
// match the tool's input validation and are not safe to change independently.

export const RANGE_FORMAT_EXTENSION = `
THE FORMAT OF COMPRESS

Compress everything ready in ONE call. Pass \`topics\` — an array where each entry groups one or more ranges under a short topic label.

\`\`\`
{
  topics: [               // One or more topics — compress all ready ranges together
    {
      topic: string,      // Short label (3-5 words) for this group - e.g., "Auth System Exploration"
      content: [          // One or more ranges to compress under this topic
        {
          startId: string, // Boundary ID at range start: mNNNNN or bN
          endId: string,   // Boundary ID at range end: mNNNNN or bN
          summary: string  // Complete technical summary replacing all content in range
        }
      ]
    }
  ]
}
\`\`\`

Legacy single-topic \`{ topic, content: [...] }\` is also accepted. Do NOT split into multiple compress calls.`

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
