import { describe, expect, test } from "bun:test";
import { runCommand } from "../src/command.js";
import { GitFreshError } from "../src/index.js";

describe("command runner", () => {
  test("reports an executable that cannot be started", async () => {
    try {
      await runCommand(
        "git-fresh-command-that-does-not-exist",
        ["--flag"],
        process.cwd(),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GitFreshError);
      expect((error as GitFreshError).code).toBe("GIT_COMMAND_FAILED");
      expect((error as GitFreshError).message).toContain(
        "Could not run git-fresh-command-that-does-not-exist --flag",
      );
      return;
    }
    throw new Error("Expected the missing executable to fail");
  });
});
