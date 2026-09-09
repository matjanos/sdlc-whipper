# Contributing to Whipper

Thanks for helping make autonomous delivery safer and easier to understand.

## Start here

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Use `pnpm whipper --help` to explore the CLI. The fake adapters support offline development without service credentials.

## Design contract

Please preserve these boundaries:

1. Deterministic code owns loops, budgets, state transitions, and side effects. Agents are leaves.
2. Core code speaks domain types, never vendor SDK types or vocabulary.
3. Phase context is assembled only in that phase's `input()` method. The context firewall tests are authoritative.
4. Outside-world mutations go through ports or `src/conductor/actions.ts`.
5. Every loop has a code-enforced bound and a safe escalation path.
6. Merging remains human-only.

See [`AGENTS.md`](AGENTS.md) for the full development guide.

## Pull requests

- Keep changes focused and explain the user-facing outcome.
- Add or update tests for behavior changes.
- Run the commands above before opening a PR.
- Never include credentials, target-repository artifacts, or `.whipper/runs/` data.

Small issues and draft PRs are welcome. If a design affects a port, context boundary, or durable-state rule, open an issue first so the contract can be discussed explicitly.
