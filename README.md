# Deep UX Mapper (Open Claw Skill)

Platform-agnostic browser mapping flow that:

- auto-discovers semantic journeys (auth/account/CRUD/settings/collaboration patterns)
- replays each journey in a fresh browser context
- learns from UI copy, icons, and network mutations
- infers expected sibling capabilities (`create -> view/update/delete`)
- tests destructive branches with both `Cancel` and `Confirm`
- persists cross-run memory in `artifacts/learnings.md`

## Why this avoids premature stopping

Instead of one long context-heavy session, this flow writes incremental state to disk and isolates execution by journey. That makes deep mapping resilient to context resets and long runtime.

## Install

```bash
cd "/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map"
npm install
```

## Configure target

Edit:

- `/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map/docs/orchestration.config.json`

Required:

- `target.baseUrl`
- `target.loginUrl` (if auth is needed)
- `target.credentials.email/password` (for authenticated apps)

For OTP flows, keep `target.otp.enabled=true` and complete OTP in the headed browser when prompted.

## Commands

```bash
npm run init
npm run validate-config
npm run discover
npm run map
npm run run
npm run status
```

## Recommended run

```bash
npm run validate-config
npm run run
npm run status
```

## Output artifacts

All outputs are under:

- `/Users/ali/Desktop/Layer0/Open Claw/deep-ux-map/artifacts`

Key files:

- `learnings.md`: append-only memory across fresh-context and async runs
- `journeys.json` + `journeys.md`: auto-enumerated semantic journey catalog
- `features.json` + `features.md`: discovered interaction-level features
- `expected-vs-found.json` + `expected-vs-found.md`: inferred capability gaps
- `coverage-frontier.json`: progress summary
- `graph-edges.jsonl`: raw transition graph
- `runs/*`: per-run screenshots and event logs

## Safety note

`allowDestructiveConfirm=true` executes confirm branch in destructive flows. Use only on test/staging environments or test accounts.

## Journey model

A journey candidate is auto-generated from observed transitions where semantic confidence passes threshold (`semantics.minConfidence`) and includes:

- intent (`login`, `register`, `create`, `update`, `delete`, etc.)
- entity (`account`, `spec`, `project`, etc.)
- replayable step trail
- completion signals (URL change, state fingerprint change, mutation calls)

## Fresh-context behavior

During `map`, each journey runs in a new Playwright context. This keeps runs independent and supports parallel execution (`mapping.concurrency`).
