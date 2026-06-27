# REQ: ACP v2 Architecture Design

## Background

ACP is forked from DCP (AGPL-3.0). To relicense to MIT, we need a clean-room rewrite that replaces all AGPL-derived code with independently-authored implementations.

## Requirement

Design the target architecture for the v2 rewrite before implementation begins.

## Goals

1. Decompose monolithic modules (hooks.ts 507 LOC, config.ts 1125 LOC)
2. Design composable pipeline stages (replace hardcoded 23-step sequence)
3. Establish explicit state mutation patterns
4. Define module boundaries and dependency rules
5. Plan the migration strategy (lib-v2/ parallel development)
6. Ensure AGPL compliance (clean-room protocol)

## Success Criteria

- DESIGN.md covers: module structure, data flow, state management, config system, dependency rules, migration plan
- Dual-agent review passes (architecture soundness + practical engineering)
- Design is actionable — implementation can begin immediately after approval

## Non-Goals

- Implementation of any v2 code (Phase 2b+)
- Changing the plugin hook contract (OpenCode's 5 hooks stay)
- Changing the CompressionBlock data structure
- Changing the 473 behavioral tests (they ARE the spec)
