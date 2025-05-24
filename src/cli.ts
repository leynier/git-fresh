#!/usr/bin/env node

import { gitFresh } from './index';

async function main() {
  try {
    await gitFresh();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
