---
name: deep-ux-map
description: Use this skill when you need exhaustive platform-agnostic UX mapping that auto-discovers semantic journeys, handles generated ID dependencies, runs each journey in fresh browser context, tests cancel/confirm destructive branches, and persists cross-run learnings.
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
3. Capture runtime entity values (`userId`, `workspaceId`, `specificationId`, etc.) from URLs and API JSON.
4. Resolve templated routes using captured entities and defer blocked journeys until dependencies are produced.
5. Use LLM-first planning (Anthropic) with strict schema validation and heuristic fallback on failure.
6. Execute form episodes (field fill + submit) to unlock downstream actions.
7. Detect and satisfy gates (counts, min-fields, wizard steps, required selections).
8. Run platform-agnostic mission/critic loops to behave like a curious human explorer.
9. Replay each journey in a fresh context to avoid context bloat.
10. For destructive actions, test both modal branches (`Cancel`, then `Confirm`) when enabled.
11. Persist cross-run memory in `artifacts/learnings.md` with file-lock-safe append logic.
12. Emit per-journey completion updates with name, depth, start, end, milestones, gate stats, and mission progress.
13. Output structured maps for journey analysis and test generation.

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
- `contexts`: guest/auth context definitions and seeds
- `coverage.targetPct`: target route coverage percentage
- `planning.mode`: `llm-first` or `heuristic-fallback`
- `llm.apiKeyEnv`: env key used to access Anthropic API
- `gates.maxSatisfyAttempts`: loop cap when satisfying unlock requirements
- `mission.*`: platform-agnostic “human-like” progression knobs (repeatable creates, chat turns, branch exploration)
- `safety.allowDestructiveConfirm`: whether confirm branch is executed
- `semantics.minConfidence`: threshold for accepting semantic candidates

## Artifacts to inspect first

- `artifacts/journeys.md`
- `artifacts/features.md`
- `artifacts/journey-graph.json`
- `artifacts/entity-registry.json`
- `artifacts/e2e-specs.json`
- `artifacts/smoke-suite.json`
- `artifacts/llm-decisions.jsonl`
- `artifacts/form-ledger.jsonl`
- `artifacts/gate-ledger.jsonl`
- `artifacts/journey-milestones.jsonl`
- `artifacts/expected-vs-found.md`
- `artifacts/learnings.md`

## Prompt references

For delegation patterns, use:

- `docs/subagent-prompts/orchestrator.md`
- `docs/subagent-prompts/journey-worker.md`
