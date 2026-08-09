# git-fresh

Safely refresh a Git working directory without re-cloning or losing local changes.

`git-fresh` saves tracked and untracked changes in a uniquely identified stash, removes ignored build artifacts and caches, restores the committed tree, and reapplies that exact stash with its staged state. It verifies the result before removing the temporary stash.

## Requirements

- Node.js 22.13.0 or newer
- Git
- A repository with at least one commit
- Run the command from the repository root

## Installation

Run it without installing:

```bash
npx git-fresh
```

Or install it globally:

```bash
npm install --global git-fresh
git-fresh
```

## Safe workflow

Preview the exact operation first:

```bash
git-fresh --dry-run
```

Execute interactively:

```bash
git-fresh
```

The default answer to the destructive confirmation is **No**. For automation, acknowledge the cleanup explicitly:

```bash
git-fresh --yes
```

When no terminal is available, the command requires `--yes` and exits with code 2 otherwise.

## Protecting files

Protect detected environment files:

```bash
git-fresh --ignore-env-files
```

Without `--yes`, the interactive command lets you protect all, none, or selected environment files. With `--yes`, all detected environment files are protected.

Protect one or more glob patterns by repeating the option:

```bash
git-fresh \
  --ignore-glob-files '.env.production' \
  --ignore-glob-files 'local-config/**'
```

Patterns must be relative and cannot escape the repository. Protected files can live inside otherwise ignored directories; their ignored siblings are still removed.

### Options

```text
--dry-run                       Show the safety plan without changing files
--yes                           Approve cleanup and protect all detected env files
--ignore-env-files              Protect detected environment files
--ignore-glob-files <pattern>   Protect a glob pattern; may be repeated
```

`--skip-confirmation` remains as a deprecated alias for `--yes` in v2.

## What is preserved and removed

Preserved:

- Git history, branches, remotes, and existing stashes
- Staged and unstaged tracked changes
- Untracked, non-ignored files
- Explicitly protected ignored files
- Clean submodules and nested repositories

Removed permanently:

- Ignored files and directories that were not explicitly protected, such as dependency folders, build output, caches, and logs

Because local changes are reapplied, `git status` can still be dirty after a successful refresh. “Fresh” refers to rebuilding the committed tree and ignored artifacts, not discarding the developer's work.

## Safety guarantees

- A directory merely named `.git` is not accepted as a repository.
- Any Git inspection error blocks cleanup instead of being interpreted as a clean tree.
- Dirty submodules or nested repositories abort the operation before mutation.
- Active merges, rebases, cherry-picks, conflicts, and repositories without commits are rejected.
- Only the temporary stash created by the current run can be applied or removed.
- The original staged state is restored with `git stash apply --index`.
- Cleanup, restore, or verification failures return a nonzero status.

If restoring changes fails, the error includes the retained stash OID. Inspect it with:

```bash
git stash show --stat <oid>
git stash apply --index <oid>
```

The stash is never deleted until the restored Git status matches the pre-cleanup status.

## Library API

```ts
import { gitFresh, GitFreshError } from "git-fresh";

try {
  const result = await gitFresh({
    cwd: "/path/to/repository",
    dryRun: true,
    ignoreEnvFiles: true,
    ignoreGlobFiles: ["local-config/**"],
  });
  console.log(result.outcome, result.removedFiles);
} catch (error) {
  if (error instanceof GitFreshError) {
    console.error(error.code, error.message);
  }
}
```

`gitFresh` returns `completed`, `dry-run`, or `cancelled`, plus the repository root, protected paths, ignored files selected for removal, and the temporary stash OID when one was created.

## Exit codes

- `0`: completed, dry-run, or user cancellation without mutation
- `1`: safety preflight or operational failure
- `2`: non-interactive execution attempted without `--yes`

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:coverage
bun run build
bun run audit
```

`bun run test` enforces 100% coverage for lines, functions, and statements and writes an LCOV report to `coverage/lcov.info`. The explicit `bun run test:coverage` command produces the same report for discoverability.

The test suite combines focused unit tests with disposable Git repositories and covers the CLI, interactive environment-file selection, large status output, staged and unstaged changes, existing stashes, protected files, invalid repositories, and nested repository safety. The two-line executable wrapper in `src/bin.ts` is the only coverage exclusion; its delegated CLI behavior is fully tested through `runCli` and exercised by the package smoke test in CI.

## License

MIT
