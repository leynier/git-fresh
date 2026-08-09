import confirm from "@inquirer/confirm";
import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { glob } from "glob";
import { runCommand, type CommandResult } from "./command.js";
import { selectEnvironmentFiles } from "./environment-files.js";
import { GitFreshError } from "./errors.js";

export { GitFreshError, type GitFreshErrorCode } from "./errors.js";

export type GitFreshOutcome = "completed" | "dry-run" | "cancelled";

export interface GitFreshOptions {
  cwd?: string;
  ignoreEnvFiles?: boolean;
  ignoreGlobFiles?: string | readonly string[];
  dryRun?: boolean;
  yes?: boolean;
  /** @deprecated Use `yes` instead. */
  skipConfirmation?: boolean;
}

export interface GitFreshResult {
  outcome: GitFreshOutcome;
  repositoryRoot: string;
  protectedFiles: string[];
  removedFiles: string[];
  stashOid?: string;
}

interface ProtectedPath {
  path: string;
  isDirectory: boolean;
}

interface StashEntry {
  oid: string;
  reference: string;
  subject: string;
}

interface GitFreshRuntime {
  runGit: (
    cwd: string,
    args: readonly string[],
    allowedExitCodes?: readonly number[],
  ) => Promise<CommandResult>;
  lstat: typeof lstat;
  realpath: typeof realpath;
  glob: typeof glob;
  selectEnvironmentFiles: typeof selectEnvironmentFiles;
  confirm: typeof confirm;
  inputIsTTY: () => boolean;
  outputIsTTY: () => boolean;
}

const ENV_PATTERNS = [
  ".env",
  ".env.*",
  "*.env",
  ".*.env",
  "**/.env",
  "**/.env.*",
  "**/.*env",
  "**/*.env",
];

async function runGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return await runCommand("git", args, cwd, allowedExitCodes);
}

const defaultRuntime: GitFreshRuntime = {
  runGit,
  lstat,
  realpath,
  glob,
  selectEnvironmentFiles,
  confirm,
  inputIsTTY: () => Boolean(process.stdin.isTTY),
  outputIsTTY: () => Boolean(process.stdout.isTTY),
};

function splitNull(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  if (text.length === 0) return [];
  return text.split("\0").filter(Boolean);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//, "");
}

function errorDetails(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveRepositoryRoot(
  cwd: string,
  runtime: GitFreshRuntime,
): Promise<string> {
  let result: CommandResult;
  try {
    result = await runtime.runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof GitFreshError) {
      throw new GitFreshError(
        "NOT_A_REPOSITORY",
        "This is not a Git repository.",
        error.details,
      );
    }
    throw error;
  }

  const root = await runtime.realpath(result.stdout.toString("utf8").trim());
  const actualCwd = await runtime.realpath(cwd);
  if (root !== actualCwd) {
    throw new GitFreshError(
      "NOT_REPOSITORY_ROOT",
      `Run git-fresh from the repository root: ${root}`,
    );
  }
  return root;
}

function validateGlobPattern(pattern: string): string {
  const normalized = pattern.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    isAbsolute(pattern) ||
    normalized.split("/").includes("..")
  ) {
    throw new GitFreshError(
      "INVALID_GLOB_PATTERN",
      `Glob patterns must stay inside the repository: ${JSON.stringify(pattern)}`,
    );
  }
  return normalized;
}

async function findMatches(
  root: string,
  patterns: readonly string[],
  runtime: GitFreshRuntime,
): Promise<string[]> {
  const matches = new Set<string>();
  for (const rawPattern of patterns) {
    const pattern = validateGlobPattern(rawPattern);
    const found = await runtime.glob(pattern, {
      cwd: root,
      dot: true,
      follow: false,
      ignore: [".git", ".git/**", "node_modules/**"],
      platform: process.platform,
    });
    for (const path of found) {
      const normalized = normalizeRelativePath(path);
      if (normalized !== ".git" && !normalized.startsWith(".git/"))
        matches.add(normalized);
    }
  }
  return [...matches].sort();
}

async function describeProtectedPaths(
  root: string,
  paths: readonly string[],
  runtime: GitFreshRuntime,
): Promise<ProtectedPath[]> {
  const protectedPaths: ProtectedPath[] = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      const stats = await runtime.lstat(resolve(root, path));
      protectedPaths.push({ path, isDirectory: stats.isDirectory() });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new GitFreshError(
          "GIT_COMMAND_FAILED",
          `Could not inspect protected path ${path}.`,
          errorDetails(error),
        );
      }
      // A path can disappear between discovery and planning. Git clean cannot remove it then.
    }
  }
  return protectedPaths;
}

function isPathProtected(
  path: string,
  protectedPaths: readonly ProtectedPath[],
): boolean {
  return protectedPaths.some(
    (entry) =>
      path === entry.path ||
      (entry.isDirectory && path.startsWith(`${entry.path}/`)),
  );
}

function escapeGitExclude(path: ProtectedPath): string {
  const escaped = path.path
    .replace(/\\/g, "\\\\")
    .replace(/([*?\[\]#! ])/g, "\\$1");
  return `/${escaped}${path.isDirectory ? "/" : ""}`;
}

function cleanArguments(
  mode: "dry-run" | "force",
  protectedPaths: readonly ProtectedPath[],
): string[] {
  const args = ["clean", mode === "dry-run" ? "-ndx" : "-fdx"];
  for (const protectedPath of protectedPaths)
    args.push("-e", escapeGitExclude(protectedPath));
  const byteLength = Buffer.byteLength(args.join("\0"));
  if (byteLength > 100_000) {
    throw new GitFreshError(
      "GIT_COMMAND_FAILED",
      "Too many protected paths to execute safely. Narrow the protection patterns.",
    );
  }
  return args;
}

async function getStatus(
  root: string,
  runtime: GitFreshRuntime,
): Promise<Buffer> {
  return (
    await runtime.runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ])
  ).stdout;
}

function statusPaths(status: Buffer): string[] {
  const fields = splitNull(status);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record.length < 4) continue;
    paths.push(normalizeRelativePath(record.slice(3)));
    if (
      record[0] === "R" ||
      record[0] === "C" ||
      record[1] === "R" ||
      record[1] === "C"
    ) {
      index += 1;
      if (index < fields.length)
        paths.push(normalizeRelativePath(fields[index]));
    }
  }
  return paths;
}

function isInsideNestedRepository(
  path: string,
  nestedRepositories: readonly string[],
): boolean {
  return nestedRepositories.some(
    (nested) => path === nested || path.startsWith(`${nested}/`),
  );
}

async function assertSafeGitOperationState(
  root: string,
  runtime: GitFreshRuntime,
): Promise<void> {
  try {
    await runtime.runGit(root, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    throw new GitFreshError(
      "UNSAFE_REPOSITORY_STATE",
      "git-fresh requires a repository with at least one commit.",
      error instanceof GitFreshError ? error.details : undefined,
    );
  }

  const conflicts = (
    await runtime.runGit(root, ["diff", "--name-only", "--diff-filter=U", "-z"])
  ).stdout;
  if (conflicts.length > 0) {
    throw new GitFreshError(
      "UNSAFE_REPOSITORY_STATE",
      `Resolve unmerged paths before running git-fresh: ${splitNull(conflicts).join(", ")}`,
    );
  }

  for (const marker of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    const markerPath = (
      await runtime.runGit(root, ["rev-parse", "--git-path", marker])
    ).stdout
      .toString("utf8")
      .trim();
    try {
      await runtime.lstat(resolve(root, markerPath));
      throw new GitFreshError(
        "UNSAFE_REPOSITORY_STATE",
        `Finish or abort the active Git operation (${marker}) before running git-fresh.`,
      );
    } catch (error) {
      if (error instanceof GitFreshError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new GitFreshError(
          "UNSAFE_REPOSITORY_STATE",
          `Could not inspect Git operation marker ${marker}.`,
          errorDetails(error),
        );
      }
    }
  }
}

async function findNestedRepositories(
  root: string,
  runtime: GitFreshRuntime,
): Promise<{ all: string[]; dirty: string[] }> {
  const gitMarkers = await runtime.glob("**/.git", {
    cwd: root,
    dot: true,
    follow: false,
    ignore: [".git", ".git/**"],
    platform: process.platform,
  });
  const all: string[] = [];
  const dirty: string[] = [];
  for (const marker of gitMarkers) {
    const nestedPath = normalizeRelativePath(
      relative(root, resolve(root, marker, "..")),
    );
    if (!nestedPath || nestedPath.startsWith("..")) continue;
    const nestedRoot = await runtime.realpath(resolve(root, nestedPath));
    const rootResult = await runtime
      .runGit(nestedRoot, ["rev-parse", "--show-toplevel"])
      .catch(() => undefined);
    if (!rootResult) {
      // A .git-looking path that is not a repository is handled by git clean normally.
      continue;
    }
    const actualRoot = rootResult.stdout.toString("utf8").trim();
    if ((await runtime.realpath(actualRoot)) !== nestedRoot) continue;
    all.push(nestedPath);
    const status = await getStatus(nestedRoot, runtime);
    if (status.length > 0) dirty.push(nestedPath);
  }
  return {
    all: [...new Set(all)].sort(),
    dirty: [...new Set(dirty)].sort(),
  };
}

async function listStashes(
  root: string,
  runtime: GitFreshRuntime,
): Promise<StashEntry[]> {
  const result = await runtime.runGit(root, [
    "stash",
    "list",
    "--format=%H%x00%gd%x00%gs",
  ]);
  return result.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid, reference, subject] = line.split("\0");
      return { oid, reference, subject };
    })
    .filter((entry) => entry.oid && entry.reference);
}

async function applyCreatedStash(
  root: string,
  oid: string,
  runtime: GitFreshRuntime,
): Promise<void> {
  try {
    await runtime.runGit(root, ["stash", "apply", "--index", oid]);
  } catch (error) {
    const details = error instanceof GitFreshError ? error.details : undefined;
    throw new GitFreshError(
      "STASH_APPLY_FAILED",
      `Could not restore the saved changes. The stash was kept as ${oid}.`,
      details,
    );
  }
}

async function dropCreatedStash(
  root: string,
  oid: string,
  runtime: GitFreshRuntime,
): Promise<void> {
  const entry = (await listStashes(root, runtime)).find(
    (stash) => stash.oid === oid,
  );
  if (!entry) {
    throw new GitFreshError(
      "STATE_VERIFICATION_FAILED",
      `The temporary stash ${oid} could not be located and was not removed.`,
    );
  }
  await runtime.runGit(root, ["stash", "drop", entry.reference]);
}

function printPlan(
  root: string,
  changedEntries: number,
  removedFiles: readonly string[],
  protectedFiles: readonly string[],
): void {
  console.log(chalk.blue.bold("Git Fresh safety plan"));
  console.log(`Repository: ${root}`);
  console.log(`Changes to preserve: ${changedEntries}`);
  console.log(`Ignored files to remove: ${removedFiles.length}`);
  console.log(`Protected paths: ${protectedFiles.length}`);
  for (const path of removedFiles.slice(0, 20))
    console.log(chalk.gray(`  remove ${path}`));
  if (removedFiles.length > 20)
    console.log(chalk.gray(`  …and ${removedFiles.length - 20} more`));
  for (const path of protectedFiles.slice(0, 20))
    console.log(chalk.green(`  protect ${path}`));
  if (protectedFiles.length > 20)
    console.log(chalk.gray(`  …and ${protectedFiles.length - 20} more`));
}

function unchangedResult(
  outcome: "dry-run" | "cancelled",
  repositoryRoot: string,
  protectedFiles: string[],
  removedFiles: string[],
): GitFreshResult {
  return { outcome, repositoryRoot, protectedFiles, removedFiles };
}

function unexpectedStashDetails(
  stashes: readonly StashEntry[],
): string | undefined {
  if (stashes.length === 0) return undefined;
  return `Unexpected new stashes: ${stashes.map((entry) => entry.oid).join(", ")}`;
}

async function executeGitFresh(
  options: GitFreshOptions = {},
  runtime: GitFreshRuntime,
): Promise<GitFreshResult> {
  const requestedCwd = resolve(options.cwd ?? process.cwd());
  const root = await resolveRepositoryRoot(requestedCwd, runtime);
  const yes = options.yes === true || options.skipConfirmation === true;
  await assertSafeGitOperationState(root, runtime);

  const nestedRepositories = await findNestedRepositories(root, runtime);
  if (nestedRepositories.dirty.length > 0) {
    throw new GitFreshError(
      "DIRTY_NESTED_REPOSITORY",
      `Nested repositories have changes: ${nestedRepositories.dirty.join(", ")}`,
    );
  }

  const patterns =
    typeof options.ignoreGlobFiles === "string"
      ? [options.ignoreGlobFiles]
      : [...(options.ignoreGlobFiles ?? [])];
  const protectedMatches = await findMatches(root, patterns, runtime);

  if (options.ignoreEnvFiles) {
    const envFiles = await findMatches(root, ENV_PATTERNS, runtime);
    if (yes || options.dryRun || !runtime.inputIsTTY()) {
      protectedMatches.push(...envFiles);
    } else {
      protectedMatches.push(
        ...(await runtime.selectEnvironmentFiles(envFiles)),
      );
    }
  }

  const protectedPaths = await describeProtectedPaths(
    root,
    protectedMatches,
    runtime,
  );
  const protectedFiles = protectedPaths.map((entry) => entry.path);
  const ignoredFiles = splitNull(
    (
      await runtime.runGit(root, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    ).stdout,
  ).map(normalizeRelativePath);
  const removedFiles = ignoredFiles
    .filter(
      (path) =>
        !isPathProtected(path, protectedPaths) &&
        !isInsideNestedRepository(path, nestedRepositories.all),
    )
    .sort();
  const initialStatus = await getStatus(root, runtime);
  const changedEntries = splitNull(initialStatus).length;
  const hasStashableChanges = statusPaths(initialStatus).some(
    (path) => !isInsideNestedRepository(path, nestedRepositories.all),
  );

  await runtime.runGit(root, cleanArguments("dry-run", protectedPaths));
  printPlan(root, changedEntries, removedFiles, protectedFiles);

  if (options.dryRun) {
    return unchangedResult("dry-run", root, protectedFiles, removedFiles);
  }

  if (!yes) {
    if (!runtime.inputIsTTY() || !runtime.outputIsTTY()) {
      throw new GitFreshError(
        "NON_INTERACTIVE_CONFIRMATION_REQUIRED",
        "Interactive confirmation is unavailable. Re-run with --yes or --dry-run.",
      );
    }
    const accepted = await runtime.confirm({
      message: "Proceed with this cleanup?",
      default: false,
    });
    if (!accepted) {
      console.log(chalk.yellow("Cancelled. No files were changed."));
      return unchangedResult("cancelled", root, protectedFiles, removedFiles);
    }
  }

  const previousStashOids = new Set(
    (await listStashes(root, runtime)).map((entry) => entry.oid),
  );
  let createdStashOid: string | undefined;
  let restored = initialStatus.length === 0;

  try {
    if (hasStashableChanges) {
      const message = `git-fresh:${new Date().toISOString()}:${randomUUID()}`;
      await runtime.runGit(root, [
        "stash",
        "push",
        "--include-untracked",
        "--message",
        message,
      ]);
      const newStashes = (await listStashes(root, runtime)).filter(
        (entry) => !previousStashOids.has(entry.oid),
      );
      const createdStash =
        newStashes.find((entry) => entry.subject.endsWith(`: ${message}`)) ??
        (newStashes.length === 1 ? newStashes[0] : undefined);
      if (!createdStash) {
        throw new GitFreshError(
          "STASH_NOT_CREATED",
          "Git reported changes but did not create a new stash. No cleanup was performed.",
          unexpectedStashDetails(newStashes),
        );
      }
      createdStashOid = createdStash.oid;
    }

    await runtime.runGit(root, cleanArguments("force", protectedPaths));
    await runtime.runGit(root, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ".",
    ]);

    if (createdStashOid) {
      await applyCreatedStash(root, createdStashOid, runtime);
      restored = true;
      const finalStatus = await getStatus(root, runtime);
      if (!finalStatus.equals(initialStatus)) {
        throw new GitFreshError(
          "STATE_VERIFICATION_FAILED",
          `The restored Git status differs from the original state. Stash ${createdStashOid} was kept.`,
        );
      }
      await dropCreatedStash(root, createdStashOid, runtime);
    }
  } catch (error) {
    if (
      createdStashOid &&
      !restored &&
      !(error instanceof GitFreshError && error.code === "STASH_APPLY_FAILED")
    ) {
      try {
        await applyCreatedStash(root, createdStashOid, runtime);
      } catch {
        // The original error and retained stash OID are more useful than a second failure.
      }
    }
    if (
      error instanceof GitFreshError &&
      createdStashOid &&
      !error.message.includes(createdStashOid)
    ) {
      throw new GitFreshError(
        error.code,
        `${error.message} Recovery stash: ${createdStashOid}.`,
        error.details,
      );
    }
    throw error;
  }

  console.log(
    chalk.green.bold("Git working directory refreshed successfully."),
  );
  return {
    outcome: "completed",
    repositoryRoot: root,
    protectedFiles,
    removedFiles,
    stashOid: createdStashOid,
  };
}

/** @internal Creates an isolated executor for deterministic adapter tests. */
export function createGitFresh(
  overrides: Partial<GitFreshRuntime> = {},
): (options?: GitFreshOptions) => Promise<GitFreshResult> {
  const runtime = { ...defaultRuntime, ...overrides };
  return async (options = {}) => await executeGitFresh(options, runtime);
}

export const gitFresh = createGitFresh();
