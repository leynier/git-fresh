import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { glob } from 'glob';
import inquirer from 'inquirer';
import ora from 'ora';

interface GitFreshOptions {
  ignoreEnvFiles?: boolean;
  skipConfirmation?: boolean;
  ignoreGlobFiles?: string;
}

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
 * Finds environment files matching various patterns
 */
async function findEnvFiles(): Promise<string[]> {
  const patterns = [
    '.env',
    '.env.*',
    '*.env',
    '.*.env',
    '**/.env',
    '**/.env.*',
    '**/.*env',
    '**/*.env'
  ];
  
  const envFiles = new Set<string>();
  
  for (const pattern of patterns) {
    try {
      const matches = await glob(pattern, { 
        dot: true,
        ignore: ['node_modules/**', '.git/**']
      });
      matches.forEach(file => envFiles.add(file));
    } catch (error) {
      // Ignore glob errors for individual patterns
    }
  }
  
  return Array.from(envFiles).sort();
}

/**
 * Prompts user to select which env files to ignore
 */
async function selectEnvFilesToIgnore(envFiles: string[]): Promise<string[]> {
  if (envFiles.length === 0) {
    return [];
  }

  console.log(chalk.yellow('\n🔒 Environment files detected:'));
  envFiles.forEach((file: string) => {
    console.log(chalk.gray(`   ${file}`));
  });

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do with these environment files?',
      choices: [
        { name: 'Ignore all (recommended)', value: 'all' },
        { name: 'Select individually', value: 'select' },
        { name: 'Ignore none (remove all)', value: 'none' }
      ],
      default: 'all'
    }
  ]);

  if (action === 'all') {
    return envFiles;
  } else if (action === 'none') {
    return [];
  } else {
    const { selectedFiles } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'selectedFiles',
        message: 'Select files to ignore (keep safe):',
        choices: envFiles.map(file => ({ name: file, value: file, checked: true })),
      }
    ]);
    return selectedFiles;
  }
}

/**
 * Removes all files and directories except .git and ignored files
 */
function removeAllExceptGitAndIgnored(ignoredFiles: string[] = []): void {
  const items = readdirSync('.');
  const ignoredSet = new Set(ignoredFiles);
  
  // Function to check if a path should be preserved
  function shouldPreservePath(itemPath: string): boolean {
    // Always preserve .git
    if (itemPath === '.git') {
      return true;
    }
    
    // Check exact match with ignored files
    if (ignoredSet.has(itemPath)) {
      return true;
    }
    
    // Check if any ignored file is inside this directory
    for (const ignoredFile of ignoredFiles) {
      if (ignoredFile.startsWith(itemPath + '/')) {
        return true;
      }
    }
    
    return false;
  }
  
  // Function to recursively process directories
  function processDirectory(dirPath: string): void {
    try {
      const dirItems = readdirSync(dirPath);
      
      for (const item of dirItems) {
        const itemPath = dirPath === '.' ? item : `${dirPath}/${item}`;
        
        if (shouldPreservePath(itemPath)) {
          continue; // Skip this item as it should be preserved
        }
        
        try {
          const stats = statSync(itemPath);
          if (stats.isDirectory()) {
            // Check if this directory contains any files we need to preserve
            let hasPreservedContent = false;
            for (const ignoredFile of ignoredFiles) {
              if (ignoredFile.startsWith(itemPath + '/')) {
                hasPreservedContent = true;
                break;
              }
            }
            
            if (hasPreservedContent) {
              // Process the directory contents recursively
              processDirectory(itemPath);
            } else {
              // Remove the entire directory
              rmSync(itemPath, { recursive: true, force: true });
            }
          } else {
            // Remove the file
            rmSync(itemPath, { force: true });
          }
        } catch (error) {
          console.warn(chalk.yellow(`Warning: Could not remove ${itemPath}`));
        }
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Could not read directory ${dirPath}`));
    }
  }
  
  // Start processing from the root directory
  processDirectory('.');
}

/**
 * Finds files matching the specified glob pattern
 */
async function findGlobFiles(pattern: string): Promise<string[]> {
  try {
    const matches = await glob(pattern, { 
      dot: true,
      ignore: ['node_modules/**', '.git/**']
    });
    return matches.sort();
  } catch (error) {
    console.warn(chalk.yellow(`Warning: Could not process glob pattern "${pattern}"`));
    return [];
  }
}

/**
 * Main function that performs the git fresh operation
 */
export async function gitFresh(options: GitFreshOptions = {}): Promise<void> {
  console.log(chalk.blue.bold('🚀 Git Fresh - Resetting working directory\n'));

  // Check if we're in a git repository
  if (!isGitRepository()) {
    throw new Error('This is not a Git repository. Please run this command in a Git repository.');
  }

  let filesToIgnore: string[] = [];

  // Handle glob pattern files if provided
  if (options.ignoreGlobFiles) {
    const globFiles = await findGlobFiles(options.ignoreGlobFiles);
    if (globFiles.length > 0) {
      filesToIgnore.push(...globFiles);
      console.log(chalk.green(`🔒 Protecting ${globFiles.length} file(s) matching pattern "${options.ignoreGlobFiles}":`));
      globFiles.forEach(file => {
        console.log(chalk.gray(`   ✓ ${file}`));
      });
    } else {
      console.log(chalk.gray(`ℹ No files found matching pattern "${options.ignoreGlobFiles}"`));
    }
  }

  // Handle environment files if requested
  if (options.ignoreEnvFiles) {
    const envFiles = await findEnvFiles();
    
    if (envFiles.length > 0) {
      if (options.skipConfirmation) {
        filesToIgnore.push(...envFiles);
        console.log(chalk.green(`🔒 Protecting ${envFiles.length} environment file(s) from removal`));
        envFiles.forEach(file => {
          console.log(chalk.gray(`   ✓ ${file}`));
        });
      } else {
        const selectedEnvFiles = await selectEnvFilesToIgnore(envFiles);
        filesToIgnore.push(...selectedEnvFiles);
        if (selectedEnvFiles.length > 0) {
          console.log(chalk.green(`\n🔒 Will protect ${selectedEnvFiles.length} environment file(s):`));
          selectedEnvFiles.forEach(file => {
            console.log(chalk.gray(`   ✓ ${file}`));
          });
        }
      }
    } else {
      console.log(chalk.gray('ℹ No environment files found'));
    }
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

    // Step 2: Remove all files except .git and ignored files
    const removeSpinner = ora('Removing files except .git and protected files...').start();
    removeAllExceptGitAndIgnored(filesToIgnore);
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
    
    if (filesToIgnore.length > 0) {
      console.log(chalk.cyan(`\n🔒 Protected files were preserved and remain untouched.`));
    }
    
  } catch (error) {
    throw new Error(`Failed to reset Git working directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}
