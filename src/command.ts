import { spawn } from "node:child_process";
import { GitFreshError } from "./errors.js";

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  allowedExitCodes: readonly number[] = [0],
): Promise<CommandResult> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      rejectPromise(
        new GitFreshError(
          "GIT_COMMAND_FAILED",
          `Could not run ${commandText(command, args)}: ${error.message}`,
        ),
      );
    });
    child.once("close", (exitCode) => {
      const result: CommandResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: exitCode ?? 1,
      };
      if (!allowedExitCodes.includes(result.exitCode)) {
        const detail =
          result.stderr.toString("utf8").trim() ||
          result.stdout.toString("utf8").trim();
        rejectPromise(
          new GitFreshError(
            "GIT_COMMAND_FAILED",
            `${commandText(command, args)} failed with exit code ${result.exitCode}`,
            detail || undefined,
          ),
        );
        return;
      }
      resolvePromise(result);
    });
  });
}
