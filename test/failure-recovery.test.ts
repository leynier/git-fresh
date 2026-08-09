import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat as fileLstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { glob as fileGlob } from "glob";
import { runCommand, type CommandResult } from "../src/command.js";
import { createGitFresh, GitFreshError } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function realRunGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return await runCommand("git", args, cwd, allowedExitCodes);
}

function commandResult(stdout = ""): CommandResult {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode: 0 };
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "git-fresh-failure-"));
  temporaryDirectories.push(repository);
  await realRunGit(repository, ["init", "--quiet"]);
  await realRunGit(repository, ["config", "user.name", "Git Fresh Test"]);
  await realRunGit(repository, [
    "config",
    "user.email",
    "git-fresh@example.invalid",
  ]);
  await writeFile(join(repository, "tracked.txt"), "initial\n");
  await realRunGit(repository, ["add", "tracked.txt"]);
  await realRunGit(repository, ["commit", "--quiet", "--message", "initial"]);
  return repository;
}

async function expectFailure(
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
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("injected safety failures", () => {
  test("preserves unexpected repository discovery errors", async () => {
    const unexpected = new Error("unexpected discovery failure");
    const execute = createGitFresh({
      runGit: async () => {
        throw unexpected;
      },
    });

    await expect(execute({ cwd: process.cwd(), dryRun: true })).rejects.toBe(
      unexpected,
    );
  });

  test("reports protected paths that cannot be inspected", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "protected.txt"), "keep\n");
    const execute = createGitFresh({
      lstat: (async (path) => {
        if (String(path).endsWith("protected.txt")) {
          throw "inspection denied";
        }
        return await fileLstat(path);
      }) as typeof fileLstat,
    });

    const error = await expectFailure(
      execute({
        cwd: repository,
        dryRun: true,
        ignoreGlobFiles: "protected.txt",
      }),
      "GIT_COMMAND_FAILED",
    );

    expect(error.details).toBe("inspection denied");
  });

  test("rejects a protection list larger than the safe command limit", async () => {
    const repository = await createRepository();
    const protectedPaths = Array.from(
      { length: 1_100 },
      (_, index) => `protected-${index}-${"x".repeat(90)}`,
    );
    const execute = createGitFresh({
      glob: (async (pattern, options) =>
        pattern === "protected-*"
          ? protectedPaths
          : await fileGlob(pattern, options)) as typeof fileGlob,
      lstat: (async (path) => {
        if (String(path).includes("protected-")) {
          return { isDirectory: () => false };
        }
        return await fileLstat(path);
      }) as typeof fileLstat,
    });

    await expectFailure(
      execute({
        cwd: repository,
        dryRun: true,
        ignoreGlobFiles: "protected-*",
      }),
      "GIT_COMMAND_FAILED",
    );
  });

  test("parses both paths in a tracked rename", async () => {
    const repository = await createRepository();
    await realRunGit(repository, ["mv", "tracked.txt", "renamed.txt"]);

    const result = await createGitFresh()({ cwd: repository, dryRun: true });

    expect(result.outcome).toBe("dry-run");
  });

  test("reports Git operation markers that cannot be inspected", async () => {
    const repository = await createRepository();
    const execute = createGitFresh({
      lstat: (async (path) => {
        if (String(path).endsWith("MERGE_HEAD")) {
          const error = new Error("marker denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await fileLstat(path);
      }) as typeof fileLstat,
    });

    const error = await expectFailure(
      execute({ cwd: repository, dryRun: true }),
      "UNSAFE_REPOSITORY_STATE",
    );

    expect(error.details).toBe("marker denied");
  });

  test("ignores nested .git-shaped directories that are not repositories", async () => {
    const repository = await createRepository();
    await mkdir(join(repository, "nested", ".git"), { recursive: true });
    let nestedRepositoryChecked = false;
    const execute = createGitFresh({
      glob: (async (pattern, options) =>
        pattern === "**/.git"
          ? ["nested/.git"]
          : await fileGlob(pattern, options)) as typeof fileGlob,
      runGit: async (cwd, args, allowedExitCodes) => {
        if (
          basename(cwd) === "nested" &&
          args[0] === "rev-parse" &&
          args[1] === "--show-toplevel"
        ) {
          nestedRepositoryChecked = true;
          throw new GitFreshError("GIT_COMMAND_FAILED", "not a repository");
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    const result = await execute({ cwd: repository, dryRun: true });

    expect(result.outcome).toBe("dry-run");
    expect(nestedRepositoryChecked).toBe(true);
  });
});

describe("interactive outcomes", () => {
  test("requires confirmation in a non-interactive process", async () => {
    const repository = await createRepository();

    await expectFailure(
      createGitFresh()({ cwd: repository }),
      "NON_INTERACTIVE_CONFIRMATION_REQUIRED",
    );
  });

  test("allows an interactive user to select environment files and cancel", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, ".gitignore"), ".env\n");
    await realRunGit(repository, ["add", ".gitignore"]);
    await realRunGit(repository, [
      "commit",
      "--quiet",
      "--message",
      "ignore env",
    ]);
    await writeFile(join(repository, ".env"), "secret\n");
    let detectedFiles: readonly string[] = [];
    const execute = createGitFresh({
      inputIsTTY: () => true,
      outputIsTTY: () => true,
      selectEnvironmentFiles: async (files) => {
        detectedFiles = files;
        return [...files];
      },
      confirm: async () => false,
    });

    const result = await execute({ cwd: repository, ignoreEnvFiles: true });

    expect(result.outcome).toBe("cancelled");
    expect(detectedFiles).toContain(".env");
    expect(await readFile(join(repository, ".env"), "utf8")).toBe("secret\n");
  });

  test("continues when an interactive user confirms", async () => {
    const repository = await createRepository();
    const execute = createGitFresh({
      inputIsTTY: () => true,
      outputIsTTY: () => true,
      confirm: async () => true,
    });

    const result = await execute({ cwd: repository });

    expect(result.outcome).toBe("completed");
  });

  test("checks the real output TTY after an injected input TTY", async () => {
    const repository = await createRepository();
    const execute = createGitFresh({ inputIsTTY: () => true });

    await expectFailure(
      execute({ cwd: repository }),
      "NON_INTERACTIVE_CONFIRMATION_REQUIRED",
    );
  });
});

describe("transaction recovery failures", () => {
  test("aborts when Git does not create the expected stash", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "stash" && args[1] === "push") return commandResult();
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    await expectFailure(
      execute({ cwd: repository, yes: true }),
      "STASH_NOT_CREATED",
    );
  });

  test("reports multiple unexpected stashes", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    let stashListCalls = 0;
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "stash" && args[1] === "push") return commandResult();
        if (args[0] === "stash" && args[1] === "list") {
          stashListCalls += 1;
          if (stashListCalls === 2) {
            return commandResult(
              "first\0stash@{0}\0unexpected first\nsecond\0stash@{1}\0unexpected second\n",
            );
          }
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    const error = await expectFailure(
      execute({ cwd: repository, yes: true }),
      "STASH_NOT_CREATED",
    );

    expect(error.details).toContain("first, second");
  });

  test("retains the stash when applying it fails", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "stash" && args[1] === "apply") {
          throw new GitFreshError(
            "GIT_COMMAND_FAILED",
            "apply failed",
            "conflict",
          );
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    const error = await expectFailure(
      execute({ cwd: repository, yes: true }),
      "STASH_APPLY_FAILED",
    );

    expect(error.details).toBe("conflict");
  });

  test("reports a stash that disappears before it can be dropped", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    let stashListCalls = 0;
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "stash" && args[1] === "list") {
          stashListCalls += 1;
          if (stashListCalls === 3) return commandResult();
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    await expectFailure(
      execute({ cwd: repository, yes: true }),
      "STATE_VERIFICATION_FAILED",
    );
  });

  test("detects a status mismatch after restoring the stash", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    let statusCalls = 0;
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "status") {
          statusCalls += 1;
          if (statusCalls === 2) return commandResult("?? different.txt\0");
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    await expectFailure(
      execute({ cwd: repository, yes: true }),
      "STATE_VERIFICATION_FAILED",
    );
  });

  test("restores the stash after a post-stash cleanup failure", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "clean" && args[1] === "-fdx") {
          throw new GitFreshError("GIT_COMMAND_FAILED", "cleanup failed");
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    const error = await expectFailure(
      execute({ cwd: repository, yes: true }),
      "GIT_COMMAND_FAILED",
    );

    expect(error.message).toContain("Recovery stash:");
    expect(await readFile(join(repository, "untracked.txt"), "utf8")).toContain(
      "change",
    );
  });

  test("keeps the original failure when recovery also fails", async () => {
    const repository = await createRepository();
    await writeFile(join(repository, "untracked.txt"), "change\n");
    const execute = createGitFresh({
      runGit: async (cwd, args, allowedExitCodes) => {
        if (args[0] === "clean" && args[1] === "-fdx") {
          throw new GitFreshError("GIT_COMMAND_FAILED", "cleanup failed");
        }
        if (args[0] === "stash" && args[1] === "apply") {
          throw new Error("recovery failed");
        }
        return await realRunGit(cwd, args, allowedExitCodes);
      },
    });

    const error = await expectFailure(
      execute({ cwd: repository, yes: true }),
      "GIT_COMMAND_FAILED",
    );

    expect(error.message).toContain("cleanup failed");
    expect(error.message).toContain("Recovery stash:");
  });
});
