# `whipper init` — default config generator

Date: 2026-09-09
Status: approved design, pending implementation

## Problem

The CLI expects `.whipper/config.json` (discovered by walking up from cwd, or via `--config`), but there is no way to generate one. Onboarding is "find `examples/sdlc.config.json` in the whipper checkout, copy it by hand to the target repo, then edit it" — easy to get wrong (wrong directory, forgotten `tracker.team`/`preview.project`, stale template).

## Goal

A new `whipper init` command that generates a valid `.whipper/config.json` in the current repo, filling in what flags provide and clearly listing what remains to edit.

Non-goals: no interactive wizard, no environment sniffing, no live validation of Linear/Vercel workspaces (that is `whipper hitch`'s job after a config exists).

## CLI surface

```
whipper init [--team <KEY>] [--preview-project <name>] [--fake] [--force] [--config <path>]
```

| Flag | Effect |
| --- | --- |
| `--team <KEY>` | Fills `tracker.team`. Default: the placeholder `"TEAM"`. |
| `--preview-project <name>` | Fills `preview.project`. Default: the placeholder `"your-project"`. |
| `--fake` | Generate the all-fakes config (`tracker/codehost/preview/runtime = "fake"`), matching the README offline-demo flow. |
| `--force` | Overwrite an existing config file. Without it, `init` refuses and exits with an error. |
| `--config <path>` | Destination file. Default: `<cwd>/.whipper/config.json`. |

## Behavior

1. **Destination resolution**: `--config` wins; otherwise `.whipper/config.json` under the current working directory. `init` does NOT walk up the tree — it writes where it is told.
2. **Generated content is built in code**, not copied from `examples/`. A new `src/init.ts` exports `initConfig(opts)` returning the config object. Rationale: `examples/` may not ship with an installed npm package, and an in-code default is unit-testable and cannot drift from the schema silently. The generated object mirrors `examples/sdlc.config.json`:
   - real adapters by default: `linear`, `github`, `vercel`, `opencode`;
   - explicit `tracker.map` (same selector defaults the schema applies anyway — spelled out so the file is self-documenting);
   - model classes `reasoner`/`workhorse` mapped to the anthropic ids used in the example; `agents` roles wired to those classes;
   - `--fake` switches the four adapters to `fake` (models stay as valid references; fakes ignore them).
3. **Placeholders**: values not provided via flags are emitted as placeholder strings (`tracker.team: "TEAM"`, `preview.project: "your-project"`). `initConfig` returns the list of fields left as placeholders so the CLI can print them.
4. **Overwrite guard**: if the destination exists and `--force` is absent → `ConfigError`-style failure, non-zero exit, file untouched.
5. **Gitignore assist**: if `<cwd>/.gitignore` exists, append (once, idempotent) a `# sdlc-whipper` block with `.whipper/runs/`, `.whipper/state.json`, `.ledger/` — but only lines not already present. No `.gitignore` in cwd → skip silently.
6. **Round-trip validation**: after writing, `init` loads the file through the existing zod schema (`loadConfig`). `init` can never emit a config the CLI cannot parse.
7. **Output**: the written path, the adapter set, the list of placeholders to edit, the env keys to set (`LINEAR_API_KEY` or `LINEAR_MCP_TOKEN`, `gh auth login`), and the suggested next commands (`whipper status`, `whipper crack --dry-run`).

## Wiring

- `src/init.ts` (new): `initConfig(opts: InitOptions): { config: unknown; placeholders: string[] }` and `initGitignore(dir: string): boolean`. Pure fs + object construction; no CLI concerns.
- `src/cli.ts`: `init` is dispatched **before** `loadConfig()` (next to alias resolution), because it runs when no config exists yet. It does not depend on `loadDotEnv()` results.
- `src/cli/ui.ts`: `renderInit(result, ui)` and a help-text entry under **FIRST RIDE** (`whipper init` → `whipper status` → `whipper crack --dry-run`), keeping presentation out of `cli.ts` per existing convention.
- The `--config` flag already parses in `parseArgs`; `init` reads it directly with `flagString`.

## Error handling

| Situation | Result |
| --- | --- |
| Destination exists, no `--force` | Error: path + hint to use `--force`; exit non-zero |
| Destination not writable | Error surfaced from fs with path context |
| Post-write validation fails | Bug guard — error includes the zod issue list (would indicate schema drift) |

## Testing (`test/init.spec.ts`, pure fs, no git fixtures)

1. Generated file passes `loadConfig` (round-trip).
2. `--team` / `--preview-project` values land in the file; omitted ones are reported as placeholders.
3. `--fake` produces the four `fake` adapters.
4. Refuses to overwrite without `--force`; overwrites with it.
5. Gitignore block appended once; re-run with `--force` does not duplicate lines; missing `.gitignore` is skipped.

## Out of scope

Interactive wizard, environment sniffing, live workspace validation, migrating a legacy `.sdlc/config.json`.
