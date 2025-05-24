import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import ora from 'ora';

/**
 * Checks if the current directory is a Git repository
 */
function isGitRepository(): boolean {
  return existsSync('.git');
}

/**
 * Executes a git command and returns the output
 */
function executeGitCommand(command: string): string {
  try {
    return execSync(`git ${command}`, { encoding: 'utf-8', stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Git command failed: ${command}`);
  }
}

/**
 * Checks if there are any changes to stash
 */
function hasChangesToStash(): boolean {
  try {
    const status = executeGitCommand('status --porcelain');
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Removes all files and directories except .git
 */
function removeAllExceptGit(): void {
  const items = readdirSync('.');
  
  for (const item of items) {
    if (item === '.git') {
      continue;
    }
    
    try {
      const stats = statSync(item);
      if (stats.isDirectory()) {
        rmSync(item, { recursive: true, force: true });
      } else {
        rmSync(item, { force: true });
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Could not remove ${item}`));
    }
  }
}

/**
 * Main function that performs the git fresh operation
 */
export async function gitFresh(): Promise<void> {
  console.log(chalk.blue.bold('🚀 Git Fresh - Resetting working directory\n'));

  // Check if we're in a git repository
  if (!isGitRepository()) {
    throw new Error('This is not a Git repository. Please run this command in a Git repository.');
  }

  let stashCreated = false;
  
  try {
    // Step 1: Stash changes if any exist
    if (hasChangesToStash()) {
      const stashSpinner = ora('Stashing current changes...').start();
      try {
        executeGitCommand('stash push -u -m "git-fresh: temporary stash"');
        stashSpinner.succeed(chalk.green('✓ Changes stashed successfully'));
        stashCreated = true;
      } catch (error) {
        stashSpinner.fail(chalk.red('✗ Failed to stash changes'));
        throw new Error('Cannot proceed: Failed to stash changes. Your files are safe, but git-fresh cannot continue without successfully stashing changes.');
      }
    } else {
      console.log(chalk.gray('ℹ No changes to stash'));
    }

    // Step 2: Remove all files except .git
    const removeSpinner = ora('Removing all files except .git...').start();
    removeAllExceptGit();
    removeSpinner.succeed(chalk.green('✓ Files removed successfully'));

    // Step 3: Restore all files from git
    const restoreSpinner = ora('Restoring files from Git...').start();
    executeGitCommand('restore .');
    restoreSpinner.succeed(chalk.green('✓ Files restored successfully'));

    // Step 4: Pop the stash if we created one
    if (stashCreated) {
      const popSpinner = ora('Applying stashed changes...').start();
      try {
        executeGitCommand('stash pop');
        popSpinner.succeed(chalk.green('✓ Stashed changes applied successfully'));
      } catch (error) {
        popSpinner.warn(chalk.yellow('⚠ Could not apply stashed changes (conflicts may exist)'));
        console.log(chalk.yellow('Run "git stash list" to see your stashed changes'));
      }
    }

    console.log(chalk.green.bold('\n🎉 Git working directory reset successfully!'));
    
  } catch (error) {
    throw new Error(`Failed to reset Git working directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}
