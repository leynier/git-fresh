#!/usr/bin/env node

import { Command } from 'commander';
import packageJson from '../package.json';
import { gitFresh } from './index';

const program = new Command();

program
  .name('git-fresh')
  .description('Quickly reset your Git working directory to a clean state without re-cloning')
  .version(packageJson.version)
  .option('--ignore-env-files', 'Protect environment files (.env, .env.*, *.env, .*.env) from being removed')
  .option('--skip-confirmation', 'Skip confirmation when ignoring env files (ignores all by default)')
  .option('--ignore-glob-files <pattern>', 'Protect files matching the specified glob pattern from being removed')
  .action(async (options) => {
    try {
      await gitFresh({
        ignoreEnvFiles: options.ignoreEnvFiles,
        skipConfirmation: options.skipConfirmation,
        ignoreGlobFiles: options.ignoreGlobFiles
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
