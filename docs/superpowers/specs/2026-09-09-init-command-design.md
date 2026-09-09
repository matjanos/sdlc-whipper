# `whipper init` — default config generator

Date: 2026-09-09
Status: approved design, revision B (interactive wizard via `@clack/prompts`), pending implementation

## Problem

The CLI expects `.whipper/config.json` (discovered by walking up from cwd, or via `--config`), but there is no way to generate one. Onboarding is "find `examples/sdlc.config.json` in the whipper checkout, copy it by hand to the target repo, then edit it" — easy to get wrong (wrong directory, forgotten `tracker.team`/`preview.project`, stale template).

## Goal

A new `whipper init` command that generates a valid `.whipper/config.json` in the current repo — interactively when a terminal is attached, flag-driven otherwise — and clearly lists what remains to edit.

Non-goals: no environment sniffing, no live validation of Linear/Vercel workspaces (that is `whipper hitch`'s job after a config exists).

## CLI framework decision

`@clack/prompts` is adopted for interactive prompts (text / select / confirm / spinner / intro-outro). It is a prompting toolkit, **not** a command router: top-level dispatch (`status`, `crack`, `hit`, …) stays on the existing tiny argv parser (`src/util/args.ts`), which clack does not replace. `init` is the only command using prompts in this revision; its look is consistent with the existing emoji CLI skin.

## CLI surface

```
whipper init [--team <KEY>] [--preview-project <name>] [--fake] [--force] [--config <path>] [--yes]
```

| Flag | Effect |
| --- | --- |
| `--team <KEY>` | Pre-fills `tracker.team`; skips its prompt. |
| `--preview-project <name>` | Pre-fills `preview.project`; skips its prompt. |
| `--fake` | Pre-selects the all-fakes adapter set (README offline-demo flow); skips the adapter prompt. |
| `--force` | Overwrite an existing config without asking. |
| `--config <path>` | Destination file. Default: `<cwd>/.whipper/config.json`. |
| `--yes` | Non-interactive mode: skip every prompt, accept flags + defaults, emit placeholders for anything unset. |

## Behavior

1. **Destination resolution**: `--config` wins; otherwise `.whipper/config.json` under the current working directory. `init` does NOT walk up the tree — it writes where it is told.
2. **Interactive flow** (TTY, no `--yes`), powered by `@clack/prompts`:
   - `intro` banner;
   - `select`: adapter mode — real (`linear`/`github`/`vercel`/`opencode`) vs all-fakes; `--fake` skips;
   - `text`: tracker team key (default `"TEAM"`); skipped when `--team` given;
   - `text`: preview project (default `"your-project"`); skipped when `--preview-project` given;
   - if the destination exists: `confirm` overwrite (without `--force`);
   - `spinner` around write + round-trip validation;
   - `outro` with next steps; `log.warn` lines for placeholders left to edit; `log.info` for env keys to set.
   - **Cancellation**: every prompt's result goes through `isCancel`; on cancel → clack `cancel("init cancelled")` and exit 0. No partial file is written (write happens once, after all prompts).
3. **Non-interactive fallback** (no TTY or `--yes`): no prompts at all — flags + defaults produce the template, placeholders reported in the final output. This keeps CI, pipes, and tests deterministic.
4. **Generated content is built in code**, not copied from `examples/`. Rationale: `examples/` may not ship with an installed npm package, and an in-code default is unit-testable and cannot drift from the schema silently. The generated object mirrors `examples/sdlc.config.json`:
   - real adapters by default: `linear`, `github`, `vercel`, `opencode`;
   - explicit `tracker.map` (same selector defaults the schema applies anyway — spelled out so the file is self-documenting);
   - model classes `reasoner`/`workhorse` mapped to the anthropic ids used in the example; `agents` roles wired to those classes;
   - fake mode switches the four adapters to `fake` (models stay as valid references; fakes ignore them).
5. **Overwrite guard**: if the destination exists, interactive mode asks via `confirm`; non-interactive mode refuses with an error unless `--force`. The file is never touched on refusal.
6. **Gitignore assist**: if `<cwd>/.gitignore` exists, append (once, idempotent) a `# sdlc-whipper` block with `.whipper/runs/`, `.whipper/state.json`, `.ledger/` — but only lines not already present. No `.gitignore` in cwd → skip silently.
7. **Round-trip validation**: after writing, the file is loaded through the existing zod schema (`loadConfig`). `init` can never emit a config the CLI cannot parse.

## Wiring

- `src/init.ts` (new, **pure**): `buildConfig(opts)` returns `{ config: unknown; placeholders: string[] }`; `applyGitignore(dir)` returns whether it modified the file. Object construction + fs only — no prompts, no CLI concerns. This is the unit-testable core.
- `src/cli/init.ts` (new): `runInit(flags)` — clack orchestration, non-interactive detection (`process.stdout.isTTY` / `--yes`), flags parsing via `flagString`/`flagBool`. Thin by design: all decisions come from `src/init.ts` data.
- `src/cli.ts`: `init` is dispatched **before** `loadConfig()` (next to alias resolution), because it runs when no config exists yet. It does not depend on `loadDotEnv()` results.
- `src/cli/ui.ts`: help-text entry under **FIRST RIDE** (`whipper init` → `whipper status` → `whipper crack --dry-run`).
- Dependency: `@clack/prompts` added to `dependencies` (ESM-native, no transitive deps).

## Error handling

| Situation | Result |
| --- | --- |
| User cancels a prompt (Ctrl+C / esc) | clack `cancel` message, exit 0, nothing written |
| Destination exists, non-interactive, no `--force` | Error: path + hint to use `--force`; exit non-zero |
| Destination not writable | Error surfaced from fs with path context |
| cwd is not inside a git repo | Round-trip validation fails with the existing "target repo must be a git checkout" message — correct, since the conductor requires git anyway |
| Post-write validation fails | Bug guard — error includes the zod issue list (would indicate schema drift) |

## Testing (`test/init.spec.ts`, pure fs, no TTY driving)

The clack layer is kept thin and unmocked; everything under test lives in `src/init.ts` and the non-interactive path of `runInit`.

1. `buildConfig` output passes `loadConfig` (round-trip, real + fake adapter variants).
2. Flag values land in the file; omitted ones are reported as placeholders.
3. Non-interactive `runInit` (`--yes`) writes the file; refuses overwrite without `--force`; overwrites with it.
4. Gitignore block appended once; re-run does not duplicate lines; missing `.gitignore` is skipped.
5. Non-TTY + no flags → same as `--yes` (no hang, deterministic output).

## Out of scope

Environment sniffing, live workspace validation, migrating a legacy `.sdlc/config.json`, retrofitting other commands with prompts.
