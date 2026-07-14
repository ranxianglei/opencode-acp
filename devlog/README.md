# devlog/

Development iteration tracking for **opencode-acp**.

## Purpose

Every development iteration (bug fix, feature, refactor, infra) gets its own folder here. The devlog serves as a persistent, searchable record of what was done, why, and what was learned — complementing git history with structured context.

## Naming Convention

Folder name: `YYYY-MM-DD_short-title`

- Must match the branch name (e.g., branch `2026-05-18_msgid-expansion` → folder `2026-05-18_msgid-expansion/`)
- Use lowercase, hyphens for spaces, no special characters
- Date is the iteration start date

## Required Files

Every devlog entry MUST include at minimum:

| File         | Purpose                                             | When to fill                    |
| ------------ | --------------------------------------------------- | ------------------------------- |
| `REQ.md`     | Problem statement, acceptance criteria, constraints | **BEFORE** implementation       |
| `WORKLOG.md` | Commits, key files, test results, lessons learned   | **DURING/AFTER** implementation |

## Optional Files

| File        | When to include                                                              |
| ----------- | ---------------------------------------------------------------------------- |
| `DESIGN.md` | Required for changes affecting architecture, data flow, or module boundaries |
| `NOTES.md`  | Ad-hoc notes, investigation logs, debugging traces                           |
| `REVIEW.md` | Code review findings (if significant enough to preserve)                     |

## Rules

1. **Every PR MUST have a corresponding devlog entry.** No exceptions.
2. The devlog folder name MUST match the branch name.
3. At minimum, `REQ.md` and `WORKLOG.md` MUST be present.
4. `DESIGN.md` is required for any change affecting architecture, data flow, or module boundaries.
5. Fill `REQ.md` **BEFORE** implementation (it functions like a ticket).
6. Fill `WORKLOG.md` **DURING** and **AFTER** implementation.
7. Commit devlog files alongside code changes — not as a separate afterthought.

## Templates

- [`REQ.template.md`](./REQ.template.md) — Copy to your entry folder as `REQ.md`
- [`WORKLOG.template.md`](./WORKLOG.template.md) — Copy to your entry folder as `WORKLOG.md`
- [`DESIGN.template.md`](./DESIGN.template.md) — Copy when architectural changes are involved

## Directory Layout

```
devlog/
├── README.md                           # This file
├── REQ.template.md                     # Template
├── WORKLOG.template.md                 # Template
├── DESIGN.template.md                  # Template
├── 2026-05-15_acp-rebrand/             # Backfilled: DCP→ACP rebrand
│   ├── REQ.md
│   └── WORKLOG.md
├── 2026-05-16_test-infrastructure/     # Backfilled: test suite from scratch
│   ├── REQ.md
│   └── WORKLOG.md
├── 2026-05-17_ci-setup/                # Backfilled: GitHub Actions CI
│   ├── REQ.md
│   └── WORKLOG.md
└── 2026-05-18_msgid-expansion/         # Backfilled: 4→5 digit ref expansion
    ├── REQ.md
    └── WORKLOG.md
```
