import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFreshError, gitFresh } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      const code = exitCode ?? 1;
      if (!allowedExitCodes.includes(code)) {
        rejectPromise(
          new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`),
        );
        return;
      }
      resolvePromise({ stdout, stderr, exitCode: code });
    });
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, cwd)).stdout;
}

async function makeDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(prefix = "git-fresh-test-"): Promise<string> {
  const repository = await makeDirectory(prefix);
  await git(repository, "init", "--quiet");
  await git(repository, "config", "user.name", "Git Fresh Test");
  await git(repository, "config", "user.email", "git-fresh@example.invalid");
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await git(repository, "add", "tracked.txt");
  await git(repository, "commit", "--quiet", "--message", "initial");
  return repository;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function expectGitFreshError(
  operation: Promise<unknown>,
  code: GitFreshError["code"],
): Promise<GitFreshError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(GitFreshError);
    expect((error as GitFreshError).code).toBe(code);
    return error as GitFreshError;
  }
  throw new Error(`Expected GitFreshError ${code}`);
}

afterEach(async () => {
  const completedTestDirectories = temporaryDirectories.splice(0).reverse();
  for (const directory of completedTestDirectories) {
    if (directory.startsWith(tmpdir()))
      await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

describe("safety preflight", () => {
  test("rejects a fake .git directory without deleting data", async () => {
    const directory = await makeDirectory("git-fresh-fake-");
    await mkdir(join(directory, ".git"));
    await writeFile(join(directory, "important.txt"), "keep me\n");

    await expectGitFreshError(
      gitFresh({ cwd: directory, yes: true }),
      "NOT_A_REPOSITORY",
    );

    expect(await readFile(join(directory, "important.txt"), "utf8")).toBe(
      "keep me\n",
    );
  });

  test("requires execution from the repository root", async () => {
    const repository = await createRepository();
    const subdirectory = join(repository, "subdirectory");
    await mkdir(subdirectory);

    await expectGitFreshError(
      gitFresh({ cwd: subdirectory, dryRun: true }),
      "NOT_REPOSITORY_ROOT",
    );
  });

  test("rejects repositories without a commit", async () => {
    const repository = await makeDirectory("git-fresh-unborn-");
    await git(repository, "init", "--quiet");
    await writeFile(join(repository, "important.txt"), "keep me\n");

    await expectGitFreshError(
      gitFresh({ cwd: repository, yes: true }),
      "UNSAFE_REPOSITORY_STATE",
    );
    expect(await exists(join(repository, "important.txt"))).toBe(true);
  });

  test("rejects glob patterns that can escape the repository", async () => {
    const repository = await createRepository();
    await expectGitFreshError(
      gitFresh({ cwd: repository, dryRun: true, ignoreGlobFiles: "../secret" }),
      "INVALID_GLOB_PATTERN",
    );
  });

  test("rejects an active merge conflict without changing the conflict state", async () => {
    const repository = await createRepository();
    const baseBranch = (
      await git(repository, "branch", "--show-current")
    ).trim();
    await git(repository, "branch", "feature");
    await writeFile(join(repository, "tracked.txt"), "main\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "--quiet", "--message", "main change");
    await git(repository, "switch", "--quiet", "feature");
    await writeFile(join(repository, "tracked.txt"), "feature\n");
    await git(repository, "add", "tracked.txt");
    await git(repository, "commit", "--quiet", "--message", "feature change");
    await git(repository, "switch", "--quiet", baseBranch);
    await run("git", ["merge", "feature"], repository, [0, 1]);
    const statusBefore = await git(repository, "status", "--porcelain=v1");

    await expectGitFreshError(
      gitFresh({ cwd: repository, yes: true }),
      "UNSAFE_REPOSITORY_STATE",
    );

    expect(await git(repository, "status", "--porcelain=v1")).toBe(
      statusBefore,
    );
  });
});

describe("transactional refresh", () => {
  test("preserves staged, unstaged, untracked, protected, and existing stash state", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "unstaged.txt"), "initial\n");
    await writeFile(join(repository, "stash-source.txt"), "initial\n");
    await writeFile(join(repository, ".gitignore"), ".env\ncache.bin\n");
    await git(
      repository,
      "add",
      "unstaged.txt",
      "stash-source.txt",
      ".gitignore",
    );
    await git(repository, "commit", "--quiet", "--message", "fixtures");

    await appendFile(join(repository, "stash-source.txt"), "user stash\n");
    await git(repository, "stash", "push", "--message", "user stash");
    const stashBefore = await git(
      repository,
      "stash",
      "list",
      "--format=%H %s",
    );

    await appendFile(join(repository, "tracked.txt"), "staged change\n");
    await git(repository, "add", "tracked.txt");
    await appendFile(join(repository, "unstaged.txt"), "unstaged change\n");
    await writeFile(join(repository, "untracked.txt"), "untracked\n");
    await writeFile(join(repository, ".env"), "secret\n");
    await writeFile(join(repository, "cache.bin"), "remove me\n");
    const statusBefore = await git(repository, "status", "--porcelain=v1");

    const result = await gitFresh({
      cwd: repository,
      yes: true,
      ignoreEnvFiles: true,
    });

    expect(result.outcome).toBe("completed");
    expect(result.removedFiles).toContain("cache.bin");
    expect(await exists(join(repository, "cache.bin"))).toBe(false);
    expect(await readFile(join(repository, ".env"), "utf8")).toBe("secret\n");
    expect(await git(repository, "status", "--porcelain=v1")).toBe(
      statusBefore,
    );
    expect(await git(repository, "stash", "list", "--format=%H %s")).toBe(
      stashBefore,
    );
  }, 30_000);

  test("handles status output larger than one megabyte without losing untracked files", async () => {
    const repository = await createRepository("git-fresh-large-");
    const suffix = "x".repeat(105);
    for (let index = 0; index < 9_000; index += 1) {
      writeFileSync(
        join(
          repository,
          `untracked-${index.toString().padStart(5, "0")}-${suffix}`,
        ),
        "",
      );
    }
    const statusBytes = Buffer.byteLength(
      await git(
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    );
    expect(statusBytes).toBeGreaterThan(1024 * 1024);

    await gitFresh({ cwd: repository, yes: true });

    expect(await exists(join(repository, `untracked-00000-${suffix}`))).toBe(
      true,
    );
    expect(await exists(join(repository, `untracked-08999-${suffix}`))).toBe(
      true,
    );
    expect(await git(repository, "stash", "list")).toBe("");
  }, 120_000);

  test("protects a nested ignored file while removing its ignored siblings", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "secrets/\n");
    await git(repository, "add", ".gitignore");
    await git(repository, "commit", "--quiet", "--message", "ignore secrets");
    await mkdir(join(repository, "secrets", "nested"), { recursive: true });
    await writeFile(join(repository, "secrets", ".env"), "secret\n");
    await writeFile(join(repository, "secrets", "junk.txt"), "junk\n");
    await writeFile(
      join(repository, "secrets", "nested", "junk.txt"),
      "junk\n",
    );

    await gitFresh({
      cwd: repository,
      yes: true,
      ignoreGlobFiles: ["secrets/.env"],
    });

    expect(await readFile(join(repository, "secrets", ".env"), "utf8")).toBe(
      "secret\n",
    );
    expect(await exists(join(repository, "secrets", "junk.txt"))).toBe(false);
    expect(await exists(join(repository, "secrets", "nested"))).toBe(false);
  });

  test("escapes special characters in exact Git clean exclusions", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "secret!/\nsecret dir/\n");
    await git(repository, "add", ".gitignore");
    await git(
      repository,
      "commit",
      "--quiet",
      "--message",
      "ignore special directories",
    );
    await mkdir(join(repository, "secret!"));
    await mkdir(join(repository, "secret dir"));
    await writeFile(join(repository, "secret!", ".env"), "bang\n");
    await writeFile(join(repository, "secret!", "junk"), "junk\n");
    await writeFile(join(repository, "secret dir", ".env"), "space\n");
    await writeFile(join(repository, "secret dir", "junk"), "junk\n");

    await gitFresh({
      cwd: repository,
      yes: true,
      ignoreGlobFiles: ["secret?/.env", "secret dir/.env"],
    });

    expect(await readFile(join(repository, "secret!", ".env"), "utf8")).toBe(
      "bang\n",
    );
    expect(await readFile(join(repository, "secret dir", ".env"), "utf8")).toBe(
      "space\n",
    );
    expect(await exists(join(repository, "secret!", "junk"))).toBe(false);
    expect(await exists(join(repository, "secret dir", "junk"))).toBe(false);
  });

  test("dry-run does not create stashes or remove ignored files", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "cache/\n");
    await git(repository, "add", ".gitignore");
    await git(repository, "commit", "--quiet", "--message", "ignore cache");
    await mkdir(join(repository, "cache"));
    await writeFile(join(repository, "cache", "artifact"), "artifact\n");
    await appendFile(join(repository, "tracked.txt"), "change\n");

    const result = await gitFresh({ cwd: repository, dryRun: true });

    expect(result.outcome).toBe("dry-run");
    expect(await exists(join(repository, "cache", "artifact"))).toBe(true);
    expect(await git(repository, "stash", "list")).toBe("");
  });
});

describe("nested repositories", () => {
  test("does not lose dirty submodule changes or pop an existing stash", async () => {
    const repository = await createRepository();
    const submoduleSource = await createRepository(
      "git-fresh-submodule-source-",
    );
    const portableSourcePath = submoduleSource.replaceAll("\\", "/");
    await git(
      repository,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      portableSourcePath,
      "modules/submodule",
    );
    await git(repository, "commit", "--quiet", "--message", "add submodule");

    await appendFile(join(repository, "tracked.txt"), "user stash\n");
    await git(repository, "stash", "push", "--message", "user stash");
    const stashBefore = await git(
      repository,
      "stash",
      "list",
      "--format=%H %s",
    );

    const submoduleFile = join(
      repository,
      "modules",
      "submodule",
      "tracked.txt",
    );
    await appendFile(submoduleFile, "dirty submodule\n");
    await writeFile(
      join(repository, "modules", "submodule", "untracked.txt"),
      "keep\n",
    );

    await expectGitFreshError(
      gitFresh({ cwd: repository, yes: true }),
      "DIRTY_NESTED_REPOSITORY",
    );

    expect(await readFile(submoduleFile, "utf8")).toContain("dirty submodule");
    expect(
      await exists(join(repository, "modules", "submodule", "untracked.txt")),
    ).toBe(true);
    expect(await git(repository, "stash", "list", "--format=%H %s")).toBe(
      stashBefore,
    );
  }, 30_000);

  test("aborts before mutation when a nested repository is dirty", async () => {
    const repository = await createRepository();
    const nested = join(repository, "nested");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await git(nested, "config", "user.name", "Nested");
    await git(nested, "config", "user.email", "nested@example.invalid");
    await writeFile(join(nested, "tracked.txt"), "initial\n");
    await git(nested, "add", "tracked.txt");
    await git(nested, "commit", "--quiet", "--message", "initial");
    await appendFile(join(nested, "tracked.txt"), "dirty\n");

    await expectGitFreshError(
      gitFresh({ cwd: repository, yes: true }),
      "DIRTY_NESTED_REPOSITORY",
    );
    expect(await readFile(join(nested, "tracked.txt"), "utf8")).toContain(
      "dirty",
    );
  });

  test("leaves a clean nested repository untouched", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), "cache.bin\n");
    await git(repository, "add", ".gitignore");
    await git(repository, "commit", "--quiet", "--message", "ignore cache");
    await writeFile(join(repository, "cache.bin"), "remove\n");

    const nested = join(repository, "nested");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await git(nested, "config", "user.name", "Nested");
    await git(nested, "config", "user.email", "nested@example.invalid");
    await writeFile(join(nested, "tracked.txt"), "nested\n");
    await git(nested, "add", "tracked.txt");
    await git(nested, "commit", "--quiet", "--message", "initial");

    await gitFresh({ cwd: repository, yes: true });

    expect(await readFile(join(nested, "tracked.txt"), "utf8")).toBe(
      "nested\n",
    );
    expect(await exists(join(nested, ".git"))).toBe(true);
    expect(await exists(join(repository, "cache.bin"))).toBe(false);
  });
});
