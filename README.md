# Deep UX Mapper (Open Claw Skill)

Platform/source-code agnostic deep journey mapper for web platforms.

It is designed for:

- route/journey coverage beyond simple nav clicking
- query-param and ID-dependent routes (`userId`, `workspaceId`, `specificationId`, etc.)
- reusable artifacts for E2E generation, smoke testing, critical-path analysis, and copy audits

## What changed in v3

- Automatic semantic journey enumeration from runtime behavior (UI + network).
- Fresh Playwright context per journey to avoid long-session context collapse.
- Runtime entity registry that captures generated IDs and reuses them in dependent routes.
- Route universe + dependency-aware journey ordering (journeys that need IDs wait until producers run).
- LLM-first planning (Anthropic) with strict action-plan schema validation and heuristic fallback.
- Stateful form episodes (fill/validate/submit) to unlock downstream actions.
- Gate detection/satisfaction loops for count and wizard prerequisites.
- Branch handling for destructive actions: `Cancel` then `Confirm` (when enabled).
- Real-time per-journey progress events (stdout + `journey-progress.jsonl`) with name, depth, start, end, milestones, and gate stats.
- Persistent cross-run learning in `artifacts/learnings.md`.

## Install

```bash
cd "/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map"
npm install
npx playwright install chromium
```

## Configure target

Edit `/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map/docs/orchestration.config.json`.

Minimum required:

- `target.baseUrl`
- `target.loginUrl` for authenticated apps
- `target.credentials.email/password` when auth context is enabled

Recommended:

- tune `contexts` to include guest/auth entry points
- keep OTP enabled for email-code login flows
- raise `discovery.maxStates` and `discovery.maxDepth` for deeper maps
- set `ANTHROPIC_API_KEY` for LLM-first planning; without it the mapper falls back and marks `degraded_planning`

LLM env:

```bash
export ANTHROPIC_API_KEY=\"<your-key>\"
```

## Commands

```bash
npm run init
npm run validate-config
npm run discover
npm run map
npm run run
npm run status
```

## Typical run

```bash
npm run validate-config
npm run run
npm run status
```

## Artifacts

All outputs are under `/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map/artifacts`.

Core outputs:

- `journeys.json` / `journeys.md`: semantic journey catalog
- `features.json` / `features.md`: discovered feature interactions
- `route-universe.json`: observed route templates and coverage states
- `entity-registry.json`: generated IDs/tokens captured from URL + API payloads
- `journey-graph.json`: journey dependency graph + unresolved entities
- `critical-paths.json`: ranked high-value paths
- `e2e-specs.json`: generated test-ready journey specs
- `smoke-suite.json`: prioritized smoke checks
- `copy-inventory.json` + `copy-issues.json`: UX copy inventory and issue hints
- `journey-progress.jsonl`: append-only per-journey completion events for live monitoring
- `llm-decisions.jsonl`: LLM plan/fallback decisions with usage and schema status
- `form-ledger.jsonl`: form fill/submit traces and generated values
- `gate-ledger.jsonl`: gate detection and satisfaction attempts
- `journey-milestones.jsonl`: step-level unlock milestones
- `expected-vs-found.json` / `expected-vs-found.md`: inferred capability gaps
- `coverage-frontier.json`: mapping progress + route coverage against target
- `learnings.md`: append-only cross-run memory

## Safety

`safety.allowDestructiveConfirm=true` executes destructive confirm actions. Use only in test/staging accounts.

## Why this avoids premature stopping

This flow does not rely on one long conversational/browser session. It stores discovered graph/entity state to disk and replays journeys independently, which is resilient against context resets and long-run token pressure.
