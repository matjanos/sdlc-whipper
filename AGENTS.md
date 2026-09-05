# AGENTS.md — developing sdlc-conductor

## What this repo is

A deterministic conductor orchestrating LLM agents through an autonomous SDLC pipeline. The design contract (see README + `~/.opencode/plan/autonomous-sdlc-framework.md`): **the conductor is deterministic code; agents are leaves; every loop is bounded in code; all durable state lives in the ticket tracker + git.**

## Commands

- `pnpm sdlc …` — run the CLI (`status | tick | deliver | ledger`)
- `pnpm test` — vitest; `pnpm typecheck` — tsc; `pnpm build` — emit to `dist/`
- Offline demo: fake adapters + `SDL_FAKE_TICKETS=path/to/tickets.json pnpm sdlc tick --config …`

## Non-negotiables

1. **The core never imports vendor SDKs or speaks vendor vocabulary.** `src/conductor/`, `src/phases/`, `src/ports/` see only domain types (`src/types.ts`). Adapters translate. A Jira/GitLab/Railway swap must be adapter-only work.
2. **The context firewall is law.** Each phase's prompt is assembled in exactly one place (its `input()`). The reviewer never receives the plan/council/execution context; the council never receives the ticket. `test/firewall.spec.ts` encodes this — if your change breaks it, the change is wrong, not the test.
3. **Loops and budgets are enforced in conductor code**, never delegated to an LLM's judgement. New loop? Add a bound (`maxRounds`) and a stalemate escalation.
4. **All outside-world mutations go through `src/conductor/actions.ts`** (dry-run-aware) or a port. No phase calls a vendor API directly. Never hardcode workspace state/label names — everything maps through `tracker.map` selectors and is validated by `discoverWorkspace()`.
5. **Adapters are defensive about external shape drift.** MCP tool names are resolved by candidate lists; SDK payloads are read through tolerant extractors with local structural types (see `runtime-opencode`) — vendor types must not leak into `src/`.

## Conventions

- TypeScript, ESM, strict. Relative imports use `.js` extensions (NodeNext).
- Model references are **classes** (`reasoner`, `workhorse`) mapped to concrete ids in each repo's `.sdlc/config.json` — never hardcode model ids in code or prompts.
- Prompts live in `prompts/agents/*.md` (system prompts, injected into worktrees by the runtime adapter) and `prompts/phases/*.md` (task templates with `{{vars}}`). Output contracts are fenced-```json verdict blocks parsed by `extractVerdict`/`validateVerdict`.
- Adding a phase: file in `src/phases/` importing from `base.ts`, register in `registry.ts`, add a pipeline step, add prompt(s), extend the firewall test if the phase has isolation requirements.
- New adapter: implement the port, add a shared contract test (run it against the fake and — env-gated — against the real service), register in `src/adapters/index.ts`, extend the config enum.
- Tests: fakes for all ports (in `src/adapters/*-fake`, reusable offline); temp git repos under `os.tmpdir()` for worktree flows (give each temp repo its own `worktrees.directory` — they collide otherwise).
- Errors that are expected flow control (`EscalationError`, `BudgetExceededError`, `VerdictParseError`) live in `src/types.ts`/`src/phases/shared.ts`; the runner maps them to statuses, phases never swallow them.

## Current state (be honest in PRs)

M1+M2 skeleton plus M3 plumbing hardening: ports, contracts, PR idempotency, GitHub checks, and Vercel preview observation are real and tested; **prompts are stub-grade by design** until M4. The OpenCode runtime's event/message extraction is defensive and needs the M2 spike verification against a live server (`/openapi.json`) before cost attribution (`costUsd`) is trustworthy. A real deployed target-repo PR is still required to close M3.
