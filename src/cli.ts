import { Command, Option } from "commander";
import { createRequire } from "node:module";
import {
  GitFreshError,
  gitFresh,
  type GitFreshOptions,
  type GitFreshResult,
} from "./index.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

type GitFreshExecutor = (options: GitFreshOptions) => Promise<GitFreshResult>;

export interface CliRuntime {
  execute?: GitFreshExecutor;
  error?: (...values: unknown[]) => void;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  runtime: CliRuntime = {},
): Promise<number> {
  const execute = runtime.execute ?? gitFresh;
  const reportError = runtime.error ?? console.error;
  let exitCode = 0;
  const program = new Command();

  program
    .name("git-fresh")
    .description(
      "Safely refresh a Git working directory while preserving local changes",
    )
    .version(packageJson.version)
    .option(
      "--ignore-env-files",
      "Protect detected environment files from cleanup",
    )
    .option(
      "--yes",
      "Approve the cleanup and protect all detected environment files",
    )
    .option("--dry-run", "Show the safety plan without changing files")
    .addOption(
      new Option(
        "--ignore-glob-files <pattern>",
        "Protect files matching a glob pattern",
      )
        .argParser(collect)
        .default([]),
    )
    .addOption(new Option("--skip-confirmation").hideHelp())
    .action(
      async (options: {
        ignoreEnvFiles?: boolean;
        yes?: boolean;
        dryRun?: boolean;
        ignoreGlobFiles: string[];
        skipConfirmation?: boolean;
      }) => {
        try {
          await execute({
            ignoreEnvFiles: options.ignoreEnvFiles,
            yes: options.yes,
            dryRun: options.dryRun,
            ignoreGlobFiles: options.ignoreGlobFiles,
            skipConfirmation: options.skipConfirmation,
          });
        } catch (error) {
          if (error instanceof GitFreshError) {
            reportError(`Error [${error.code}]: ${error.message}`);
            if (error.details) reportError(error.details);
            exitCode =
              error.code === "NON_INTERACTIVE_CONFIRMATION_REQUIRED" ? 2 : 1;
            return;
          }
          reportError(
            "Error:",
            error instanceof Error ? error.message : String(error),
          );
          exitCode = 1;
        }
      },
    );

  await program.parseAsync([...argv], { from: "user" });
  return exitCode;
}
