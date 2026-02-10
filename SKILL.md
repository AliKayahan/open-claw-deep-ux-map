---
name: deep-ux-map
description: Use this skill when you need exhaustive platform-agnostic UX mapping that auto-discovers semantic journeys, runs each journey in fresh browser context, tests both cancel/confirm destructive branches, and persists cross-run learnings in learnings.md.
---

# Deep UX Map Skill

Use this skill to map every meaningful feature/navigation/journey of a web app without relying on one long model context.

## When to use

Use for requests like:

- "map every feature on this platform"
- "discover all user journeys end to end"
- "click all hidden controls and overflow menus"
- "find missing expected features from observed product semantics"

## Core behavior

1. Automatically build an interaction graph from UI states and actions.
2. Infer semantic journeys from action text, icon hints, route structure, and network mutations.
3. Replay each journey in a fresh context to avoid context bloat.
4. For destructive actions, test both modal branches (`Cancel`, then `Confirm`) when enabled.
5. Persist cross-run memory in `artifacts/learnings.md` with file-lock-safe append logic.
6. Output structured maps (`journeys`, `features`, `expected-vs-found`, `coverage-frontier`).

## Execution steps

1. Open and edit `docs/orchestration.config.json` for target URL, credentials, and safety flags.
2. Run:
   - `npm run validate-config`
   - `npm run run`
3. Review results in `artifacts/`.

## Important knobs

- `discovery.maxStates`: how deep/wide initial graph scan goes
- `discovery.maxDepth`: depth of queued route expansion
- `mapping.concurrency`: number of fresh-context journey workers
- `safety.allowDestructiveConfirm`: whether confirm branch is executed
- `semantics.minConfidence`: threshold for accepting semantic candidates

## Artifacts to inspect first

- `artifacts/journeys.md`
- `artifacts/features.md`
- `artifacts/expected-vs-found.md`
- `artifacts/learnings.md`

## Prompt references

For delegation patterns, use:

- `docs/subagent-prompts/orchestrator.md`
- `docs/subagent-prompts/journey-worker.md`
