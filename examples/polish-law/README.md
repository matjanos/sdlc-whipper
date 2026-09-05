# Polish-law conductor test

Request: [request.md](request.md). Backlog: [tickets.json](tickets.json).
Target: `~/code/test-sdlc-app`, an initialized Git repository with a runnable Node placeholder and `.sdlc/config.json` using all fake adapters.

Run from `~/code/sdlc-conductor`:

```sh
export SDL_FAKE_TICKETS="$PWD/examples/polish-law/tickets.json"
pnpm sdlc status --config ../test-sdlc-app/.sdlc/config.json
pnpm sdlc tick --config ../test-sdlc-app/.sdlc/config.json --dry-run
pnpm sdlc ledger --config ../test-sdlc-app/.sdlc/config.json
```

Expected initial status: LAW-1 ready; LAW-2 through LAW-6 blocked. A dry run exercises the fake phase pipeline for LAW-1. To exercise writable offline artifacts/worktrees and simulated publication, omit `--dry-run`. Fake agents do not implement the application and fake PR/preview success does not verify app behavior.

The fixture is the conductor's `Ticket[]` format, **not a Linear bulk-import format**. `LAW-*` identifiers are local test keys. No real Linear issues are created. The fake tracker is in memory: ticket comments/state changes disappear between CLI invocations. To simulate subsequent completed dependencies, edit a working copy of the JSON and update both the completed ticket's `state` and every relation pointing to it to `done`, then point `SDL_FAKE_TICKETS` at that copy. Task branches/artifacts from writable runs persist in the target repository.

For actual implementation, configure the target runtime as `opencode` with valid model-class mappings (see `../sdlc.config.json`) and use the existing live-runtime setup in the conductor README. For real durable tickets, PRs and previews, provision the target GitHub/preview project and create these descriptions as Linear issues, mapping dependencies to their real keys; then select the real adapters and workspace selectors. The starter has no remote or deployed preview.

## Backlog

| Ticket | Deliverable | Depends on |
| --- | --- | --- |
| LAW-1 | Persistent document model + offline seed | — |
| LAW-2 | Latest legislation: ELI / Sejm | LAW-1 |
| LAW-3 | NSA, SAOS, SN, TSUE, TK adapters | LAW-1 |
| LAW-4 | Periodic imports, checkpoints, freshness | LAW-2, LAW-3 |
| LAW-5 | Polish search UI + document details | LAW-1 |
| LAW-6 | Integrated demo, acceptance suite, source readiness | LAW-4, LAW-5 |

LAW-3 deliberately exercises multi-source planning; the conductor may split it into source-sized subtasks. The MVP caps collection at ten recent records per source per run, while the long-term request remains comprehensive legal research.
