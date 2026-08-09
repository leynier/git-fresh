import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.js";
import {
  GitFreshError,
  type GitFreshOptions,
  type GitFreshResult,
} from "../src/index.js";

function completedResult(): GitFreshResult {
  return {
    outcome: "completed",
    repositoryRoot: "/repository",
    protectedFiles: [],
    removedFiles: [],
  };
}

describe("CLI", () => {
  test("maps command-line flags to the library options", async () => {
    let receivedOptions: GitFreshOptions | undefined;

    const exitCode = await runCli(
      [
        "--ignore-env-files",
        "--yes",
        "--dry-run",
        "--ignore-glob-files",
        ".env.*",
        "--ignore-glob-files",
        "local/**",
        "--skip-confirmation",
      ],
      {
        execute: async (options) => {
          receivedOptions = options;
          return completedResult();
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      ignoreEnvFiles: true,
      yes: true,
      dryRun: true,
      ignoreGlobFiles: [".env.*", "local/**"],
      skipConfirmation: true,
    });
  });

  test("uses exit code 2 and prints details for non-interactive errors", async () => {
    const errors: unknown[][] = [];

    const exitCode = await runCli([], {
      execute: async () => {
        throw new GitFreshError(
          "NON_INTERACTIVE_CONFIRMATION_REQUIRED",
          "Confirmation is required.",
          "Use --yes.",
        );
      },
      error: (...values) => errors.push(values),
    });

    expect(exitCode).toBe(2);
    expect(errors).toEqual([
      [
        "Error [NON_INTERACTIVE_CONFIRMATION_REQUIRED]: Confirmation is required.",
      ],
      ["Use --yes."],
    ]);
  });

  test("uses exit code 1 for GitFresh errors without details", async () => {
    const errors: unknown[][] = [];

    const exitCode = await runCli([], {
      execute: async () => {
        throw new GitFreshError("NOT_A_REPOSITORY", "Not a repository.");
      },
      error: (...values) => errors.push(values),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([["Error [NOT_A_REPOSITORY]: Not a repository."]]);
  });

  test("prints unexpected Error instances", async () => {
    const errors: unknown[][] = [];

    const exitCode = await runCli([], {
      execute: async () => {
        throw new Error("unexpected");
      },
      error: (...values) => errors.push(values),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([["Error:", "unexpected"]]);
  });

  test("prints unexpected non-Error values", async () => {
    const errors: unknown[][] = [];

    const exitCode = await runCli([], {
      execute: async () => {
        throw "unexpected";
      },
      error: (...values) => errors.push(values),
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual([["Error:", "unexpected"]]);
  });
});
