# REQ: Debug Mode — Inject Compression Notification into Chat Session

## Problem

When `debug: true`, compression notifications only appear as transient toast popups (5s duration). Developers cannot scroll back to review what was compressed — the notification disappears.

## Requirement

When debug is on, ALSO inject the compression notification into the user's chat session via `sendIgnoredMessage` (user-visible, model-invisible). Keep the toast for immediate popup feedback alongside the persistent chat record.

## Background

FIX #20 disabled `sendIgnoredMessage` for compress notifications because opencode strips `ignored: true` parts before the LLM call, leaving an empty user message → provider 400 (zhipuai code 1214). The `dropEmptyMessages` backstop (`lib/messages/utils.ts:238`) now catches these empty messages in the transform pipeline before they reach the provider. This makes debug-mode chat injection safe.
