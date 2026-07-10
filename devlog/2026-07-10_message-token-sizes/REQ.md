# REQ: Message Token Size + Type Annotation

## Problem

The model cannot see how many tokens each message consumes. ACP injects a breakdown
listing the largest items, but the model has no per-message size awareness when
scanning the conversation itself.

## Solution

Annotate each `<dcp-message-id>` tag with `tokens` (approximate size) and `type`
(content classification: text/tool/reasoning + tool name).

Before: `<dcp-message-id>m00175</dcp-message-id>`
After:  `<dcp-message-id tokens="20.7K" type="tool:bash">m00175</dcp-message-id>`

## Impact

- Model can self-assess which messages are large without relying on ACP's recommendation list
- Breakdown recommendations can be de-emphasized (suggestion, not directive)
- Compression decisions become smarter — model combines content + size + type
