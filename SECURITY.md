# Security Policy

`opencode-acp` is an OpenCode plugin that manages conversation context for the model.
Because the plugin runs inside an OpenCode session, a defect here could affect any session
that loads it, so we take reports seriously.

## Supported Versions

We apply security fixes to the **latest release line** published on npm as
[`opencode-acp@latest`](https://www.npmjs.com/package/opencode-acp). Older releases
receive critical security fixes only when they can be backported cleanly.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues or pull
requests.

Report a suspected vulnerability privately using one of the following:

- **GitHub Security Advisory** (preferred): open a private report at
  <https://github.com/ranxianglei/opencode-acp/security/advisories/new>.
- **Email the maintainer**: see the `author` field in [`package.json`](./package.json).

### What to include

- A short description of the issue and its potential impact.
- Steps to reproduce, or a minimal proof-of-concept, where possible.
- The affected version(s) and how you identified them.

We aim to acknowledge receipt within **two business days** and to share a timeline for a
fix. We will credit the reporter in the public advisory unless you prefer to remain
anonymous.

## Scope

This policy covers the `opencode-acp` plugin in this repository, including its runtime
behavior inside an OpenCode session. Please report issues belonging to the upstream
[OpenCode](https://opencode.ai) host or the original
[opencode-dcp](https://github.com/Tarquinen/opencode-dynamic-context-pruning) project to
those projects instead.
