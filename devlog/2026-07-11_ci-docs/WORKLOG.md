# WORKLOG - AGENTS.md CI Documentation Update

- Task ID: `2026-07-11_ci-docs`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-11 18:10

## 1. Summary

Rewrote AGENTS.md Section 5.4 from manual pre-publish checklist to automated CI release workflow documentation.

## 2. Change Log

- `AGENTS.md` Section 5.4: replaced "Pre-Publish Checklist" with "Release Workflow (Automated via CI)"
  - 5.4.1: CI Enforcement (pr-checks.yml + release.yml)
  - 5.4.2: Release Process (step-by-step: branch → bump → PR → merge → tag → auto-publish)
  - 5.4.3: Prerequisites (NPM_TOKEN, branch protection)
  - 5.4.4: Manual Publish (legacy fallback)
- `devlog/2026-07-11_ci-docs/`: REQ.md + WORKLOG.md
