# git-fresh

Quickly reset your Git working directory to a clean state without re-cloning. Stashes, wipes, restores, and pops.

## Why git-fresh?

Many developers have the habit of deleting their entire project and running `git clone` again when they encounter issues with their working directory. This is unnecessary and time-consuming! Instead, `git-fresh` performs the following operations:

1. **Stash** your current changes (if any)
2. **Remove** all files except the `.git` directory
3. **Restore** all files from Git
4. **Pop** the stashed changes back

This achieves the same result as re-cloning but much faster and without losing your Git history or remotes.

## Installation

You can run `git-fresh` directly using npx without installing it globally:

```bash
npx git-fresh
```

Or with other package managers:

```bash
# Using pnpm
pnpm dlx git-fresh

# Using yarn
yarn dlx git-fresh

# Using bun
bunx git-fresh
```

Or install it globally:

```bash
npm install -g git-fresh
# or with bun
bun add -g git-fresh
# or with pnpm
pnpm add -g git-fresh
# or with yarn
yarn global add git-fresh
```

## Usage

Simply run the command in any Git repository:

```bash
npx git-fresh
```

Or if installed globally:

```bash
git-fresh
```

### Command Line Options

You can use various options to customize the behavior of `git-fresh`:

#### `--ignore-env-files`

Protects environment files from being removed during the reset process. This includes files matching patterns like `.env`, `.env.*`, `*.env`, and `.*.env`.

```bash
npx git-fresh --ignore-env-files
```

When this option is used, you'll be prompted to choose which environment files to protect, unless you also use `--skip-confirmation`.

#### `--skip-confirmation`

When used with `--ignore-env-files`, this option skips the interactive confirmation and automatically protects all detected environment files.

```bash
npx git-fresh --ignore-env-files --skip-confirmation
```

#### `--ignore-glob-files <pattern>`

Protects files matching the specified glob pattern from being removed during the reset process. This is useful for protecting specific files or file types that you want to keep.

```bash
# Protect all .config files
npx git-fresh --ignore-glob-files "*.config"

# Protect all files in a specific directory
npx git-fresh --ignore-glob-files "temp/**"

# Protect files with specific extensions
npx git-fresh --ignore-glob-files "**/*.{log,tmp}"
```

#### Combining Options

You can combine multiple options as needed:

```bash
# Protect both env files and custom glob pattern
npx git-fresh --ignore-env-files --ignore-glob-files "*.local" --skip-confirmation
```

### What happens when you run git-fresh?

The tool will output progress information as it performs each step:

```text
🚀 Git Fresh - Resetting working directory

✓ Changes stashed successfully
✓ Files removed successfully  
✓ Files restored successfully
✓ Stashed changes applied successfully

🎉 Git working directory reset successfully!
```

## Example Usage Scenarios

### Scenario 1: Clean repository (no uncommitted changes)

```bash
$ npx git-fresh
🚀 Git Fresh - Resetting working directory

ℹ No changes to stash
✓ Files removed successfully
✓ Files restored successfully

🎉 Git working directory reset successfully!
```

### Scenario 2: Repository with uncommitted changes

```bash
$ npx git-fresh
🚀 Git Fresh - Resetting working directory

✓ Changes stashed successfully
✓ Files removed successfully
✓ Files restored successfully
✓ Stashed changes applied successfully

🎉 Git working directory reset successfully!
```

### Scenario 3: Repository with conflicts during stash pop

```bash
$ npx git-fresh
🚀 Git Fresh - Resetting working directory

✓ Changes stashed successfully
✓ Files removed successfully
✓ Files restored successfully
⚠ Could not apply stashed changes (conflicts may exist)
Run "git stash list" to see your stashed changes

🎉 Git working directory reset successfully!
```

### Before and After

**Before running git-fresh:**

- Modified files: `README.md`, `src/index.js`
- Untracked files: `temp.txt`, `debug.log`
- Deleted files: `old-file.js` (was in git)
- Working directory is "dirty"

**After running git-fresh:**

- All files are restored to their committed state
- All untracked files are preserved (via stash)
- All modified files are preserved (via stash)
- Working directory is "clean" but changes are recoverable
- Git history and remotes are unchanged

## What it does

1. **Checks** if you're in a Git repository
2. **Stashes** any uncommitted changes (including untracked files)
3. **Removes** all files and directories except `.git`
4. **Restores** all files from the Git repository
5. **Applies** the stashed changes back (if any were stashed)

## Requirements

- Node.js 14.0.0 or higher
- Git repository

## Safety

- Your Git history remains intact
- Uncommitted changes are safely stashed and restored
- The `.git` directory is never touched
- If conflicts occur during stash pop, your changes remain in the stash

## Development

This project uses Bun for package management:

```bash
# Install dependencies
bun install

# Build the project
bun run build

# Validate the package is ready
bun run validate
```

### Testing Locally

To test the package locally before publishing:

1. Build the project: `bun run build`
2. Create a test Git repository in a temporary directory
3. Run the CLI directly: `/path/to/git-fresh/dist/cli.js`

### Publishing

To publish the package to npm:

```bash
# Build and validate
bun run validate

# Publish (requires npm account and authentication)
npm publish
```

## Author

Leynier Gutiérrez González

## License

MIT
