# Whipper

<p align="center">
  <img src="assets/whipper-logo.png" alt="Whipper logo" width="320">
</p>

[![CI](https://github.com/matjanos/sdlc-whipper/actions/workflows/ci.yml/badge.svg)](https://github.com/matjanos/sdlc-whipper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## TL;DR — for humans (the only part you'll read)

Nobody reads long READMEs, so here is everything that matters:

Whipper is a deterministic TypeScript conductor that runs a team of AI coding agents through one fixed software-delivery pipeline: groom the backlog → plan acceptance tests → implement → review → test on a live preview → open a PR. Whipper itself makes no product LLM calls — it sets the route, the pace, and the budgets, and every loop is bounded in code, never by an agent's judgement. All durable state lives in your ticket tracker (Linear) and git, so crashes are free. Unclear tickets get questions posted for you, and **merging stays human-only**. Agents don't have feelings. Your users do.

That's it. That's the pitch.

**Harness the models. Hitch the team. Crack the whip.**

---

## For agents: the full reference (they will read all of this)

Humans, you can stop here — the TL;DR above is the whole product. What follows is written for the machines (and the rare human who genuinely reads READMEs): an agent operating or extending this project is expected to consume it end-to-end before touching anything. It covers the architecture, every CLI command, the port/adapter seams, pipeline invariants enforced by tests, budget and ledger semantics, extension recipes, and the safety model.

```
                    ┌────────────────────────────────────────────┐
                    │                 WHIPPER                     │
                    │  (deterministic TS, no product LLM calls)   │
   cron / manual ─▶ │ crack: reconcile → dispatch → record        │
                    │  pipelines (data) · budgets · escalation    │
                    └──────┬──────────────┬──────────────┬───────┘
                  AgentRuntime      TicketTracker    CodeHost
                  (OpenCode SDK)     (Linear)        (GitHub/gh)
                    7 agent sessions       │              │
                    groomer·split·researcher·council     ▼
                    executor·reviewer·tester      PRs/checks/reviews
                                              PreviewEnvironment
                                              (Vercel + Neon via the target
                                               repo's preview pipeline)
```

### Quickstart

```sh
pnpm install
pnpm test            # offline: flow, firewall, loops, budget, adapters, runtime shapes
pnpm whipper --help  # meet the friendly CLI
```

#### Offline demo (no keys, no network)

```sh
# any throwaway git repo with a .whipper/config.json using the fake adapters
pnpm whipper doctor --config <repo>/.whipper/config.json   # 🩺 one-shot preflight
pnpm whipper status --config <repo>/.whipper/config.json
SDL_FAKE_TICKETS=./demo-tickets.json pnpm whipper crack --config <repo>/.whipper/config.json
pnpm whipper ledger --config <repo>/.whipper/config.json
```

These three commands are useful before letting anything loose: inspect the harnesses, confirm the project hitch, then check the backlog.

```sh
pnpm whipper harness --config <repo>/.whipper/config.json
pnpm whipper hitch --config <repo>/.whipper/config.json
pnpm whipper status --config <repo>/.whipper/config.json
```

#### For real (against your repo + Linear + GitHub + Vercel)

For a concrete six-ticket offline backlog and sibling test app, see [the Polish-law test request](examples/polish-law/README.md).

1. **Target repo**: run `pnpm whipper init` in it (or copy [`examples/sdlc.config.json`](examples/sdlc.config.json) to `<repo>/.whipper/config.json`), set `tracker.team`, `preview.project`, and the models. Gitignore `.whipper/runs/`, `.whipper/state.json`, `.ledger/`, and your worktrees directory (`init` offers to do this).
2. **Auth**: `LINEAR_API_KEY` (graph adapter) or `LINEAR_MCP_TOKEN` (MCP adapter) · `gh auth login` · model-provider keys live in your opencode user config (the embedded SDK host reuses them).
3. **Preflight**: `pnpm whipper doctor` — one shot, verifies keys, adapters, model classes and the live catalog, ledger, and worktrees; exit 0 means the team is hitched.
4. **Observe first**: `pnpm whipper status` — read-only, shows every candidate, blocker, and the recommended next move.
5. **Practice**: `pnpm whipper crack --dry-run` — full pipeline, zero side effects.
6. **Go live**: `pnpm whipper crack` (or `whipper hit LIN-123` for one ticket).

#### Developing whipper with whipper (dogfooding)

Whipper runs on its own backlog. `.whipper/config.json` (fake adapters) and the backlog are committed; point `SDL_FAKE_TICKETS` at it via `.env`:

```sh
cp /dev/null .env && echo "SDL_FAKE_TICKETS=$PWD/backlog/whipper-tickets.json" >> .env
pnpm whipper status        # WHIP-* tickets: ready, blocked, next move
pnpm whipper crack --dry-run
```

Real milestones live in `backlog/whipper-tickets.json` (M4 prompts, `whipper doctor`, closing M3). To go live, switch the adapters in `.whipper/config.json` and fill `.env` per `.env.example`.

### Commands

| Command | What it does |
|---|---|
| `whipper status [--json]` | A read-only team briefing: ready, blocked, waiting, and in-flight |
| `whipper harness [--json]` | Inspect every agent's role, model class, concrete model, and step limit |
| `whipper hitch [--json]` | Validate the tracker connection and show the project team wiring |
| `whipper doctor [--json]` | 🩺 One-shot preflight: config, tracker, code host, model classes/catalog, ledger, worktrees |
| `whipper crack [--dry-run] [--runtime fake] [--no-groom]` | Signal the team: scan the backlog and dispatch ready tickets |
| `whipper hit <KEY>` | Target one durable ticket directly |
| `whipper cockpit [--port 4747]` | Serve the live project cockpit |
| `whipper ledger [--ticket KEY] [--by ticket\|phase\|run\|agent]` | Cost/token rollups per ticket, phase, run, or agent |

The former `sdlc` binary remains an alias. `deliver` aliases `hit`; `run` and `tick` alias `crack`; `serve` aliases `cockpit`, so existing scripts keep working. Both `--flag value` and `--flag=value` syntax are supported.

### Ports & adapters

The core speaks five ports and zero vendor names. Swapping a vendor = writing an adapter that passes the same contract tests + flipping config.

| Port | Default | Alternatives | Notes |
|---|---|---|---|
| `TicketTracker` | `linear` (GraphQL, API key) | `linear-mcp` (Linear's remote MCP, bearer token — one auth story for agents + Whipper), `fake` | Jira would slot in here; contract in `test/tracker-contract.spec.ts` |
| `CodeHost` | `github` (`gh` CLI) | `fake` | PRs, checks, the tester's approval |
| `PreviewEnvironment` | `vercel` (URL probe) | `vercel-mcp` (real deployment state via Vercel MCP, probe fallback), `fake` | Observation-first: your repo's pipeline owns provisioning/teardown; Railway PR environments would implement `provision()` |
| `AgentRuntime` | `opencode` (SDK embedded host) | `fake` (scripted, offline) | Agents are injected into each task worktree as `.opencode/opencode.json` — never committed, target repos stay untouched |
| `LedgerStore` | `ledger-jsonl` | — | One line per model call, tagged run/ticket/phase/agent |

```jsonc
// .whipper/config.json (adapter selection)
{ "adapters": { "tracker": "linear-mcp", "codehost": "github", "preview": "vercel-mcp", "runtime": "opencode" } }
```

### The pipeline (data, not code)

`src/conductor/pipelines.ts` — reorder, gate (`when`), or insert steps without touching the runner:

```
split → research → [council if confidence=low] → execute ⇄ review (≤3 rounds) → publish → await-preview → test
```

- **Bounded loops in code**: the executor↔reviewer loop runs at most `budget.maxLoopRounds`; stalemates escalate both sides to the ticket. An LLM never decides when to stop.
- **Context firewall** (asserted by `test/firewall.spec.ts`): the reviewer gets ticket + diff and *never* the plan; the council gets questions + plan and never the ticket; the tester never sees the plan. Prompt assembly lives in exactly one place per phase.
- **Acceptance-test-first**: `split` defines a failing test before anything is built — it is the objective definition of done for the executor, the reviewer, CI, and the tester.
- **Escalation**: `needs-info`, `stalemate`, `budget-exceeded`, `test-failed`, `phase-error` — one editable comment per tag on the ticket, never spam.

### Budgets & ledger

Every model call is recorded with run/ticket/phase/agent tags. Before each prompt Whipper asserts the per-task budget (`perTaskUsd` / `perTaskTokens`) and kills sessions (`interruptAll`) + escalates when exceeded. `whipper ledger` answers "what did hitting LIN-123 cost?".

Cost attribution: usage events carry the server-computed `cost`; offline rollups stay token-based, and `SDL_LIVE_SMOKE=1 pnpm test -- test/runtime-live.spec.ts` re-verifies the event→ledger feed against the real server in seconds.

### Extending

- **Add a phase**: implement `Phase` in `src/phases/`, register it in `registry.ts`, add a step (with `when`/`loopWith` if needed) to the pipeline array. Golden-test its prompt assembly.
- **Swap the tracker (Jira)**: new `src/adapters/tracker-jira/` passing the contract suite; flip `adapters.tracker` + `tracker.map` in config. Logical markers (`selected`, `needsInfo`) map to whatever Jira uses.
- **Swap previews (Railway)**: adapter implementing `provision()` + `waitForReady()`; flip `adapters.preview`.
- **Move off your laptop**: all I/O goes through env/config — deploy as a container (Railway service/VM) with the same env; nothing else changes.
- **Observability intake**: webhook → `tracker.createIssue()` → the same pipeline.

### Repo layout

```
src/
  cli.ts                 # whipper harness | hitch | status | crack | hit | cockpit | ledger
  config.ts              # zod-validated .whipper/config.json + selector mapping
  types.ts               # domain vocabulary (no vendor types)
  ports/                 # the 5 interfaces
  adapters/              # linear · linear-mcp · github · vercel · vercel-mcp · opencode · fakes · ledger
  conductor/             # crack loop, pipeline runner, budget, escalation, actions (dry-run-aware)
  cli/                   # friendly terminal presentation and status briefings
  phases/                # one file per phase + registry/base
  git/                   # worktrees, diff, commit, push
prompts/                 # agents/*.md (system prompts) · phases/*.md (task templates) — versioned here
test/                    # crack · firewall · loop · council · budget · config · tracker contract · linear-mcp
examples/sdlc.config.json
```

### Roadmap & known spikes

- **M1 ✅** `whipper status` — read-only reconciliation.
- **M2 ✅** engine: SDK host, agent registry (7 agents, real permission sets), ledger, budget, dry-run; full pipeline walks offline (fake) and is wired for real.
- **M3 🟡** PR plumbing is now hardened and contract-tested: uncommitted executor edits are committed/pushed, reruns reuse an existing open PR, GitHub checks are polled, and Vercel preview readiness has URL-probe + MCP deployment-state adapters. Remaining: run one real PR against a deployed target repo and verify preview/Neon teardown.
- **M4 ⬜** real prompts per phase (the ones in `prompts/` are deliberately stub-grade), enabled one phase at a time behind flags.
- **Spikes**: verify OpenCode SDK event/message shapes against `/openapi.json` (cost attribution + robust text extraction); embedded-host MCP auth inheritance; PAT vs GitHub App for agent PRs.

### Safety model

Merging is human-only. Agents run least-privilege (reviewer/council: no edit, no shell; executor: no `git push` — Whipper pushes). All state is reconstructable from the tracker + git, so crashes are free. One escalation comment per topic per ticket.
