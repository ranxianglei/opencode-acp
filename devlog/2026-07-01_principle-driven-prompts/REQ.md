# Principle-Driven Compression Prompts

## Problem

System prompt had 72 lines of detailed compression rules (7-item priority list, 3 pressure levels, hardcoded thresholds). Models mechanically followed rules regardless of context level — compressing at 6% context, losing critical task details.

## Requirements

- R1: Simplify system prompt to high-level principles (~15 lines)
- R2: Per-message shows only context number (no compression guidance)
- R3: Every 10 percentage points (from 15%): show Tips with tool names (not commands)
- R4: Below 15%: no compression prompts at all
- R5: At 65%+: stronger tone about overflow risk
- R6: Add "BE FRUGAL" section with examples of obvious waste
- R7: Config: minNudgeContextPercent=15, growthPercent=10pp

## Design Philosophy

Minimal intervention. Give smart models principles, not rules. Let them decide when/what to compress.
