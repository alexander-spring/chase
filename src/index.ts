#!/usr/bin/env node

import 'dotenv/config';
import { loadConfig } from './config.js';
import { runClaudeForScriptGeneration } from './claude-runner.js';
import { runIterativeTest } from './iterative-tester.js';
import { writeScript } from './codegen/bash-generator.js';
import * as path from 'path';

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Extract options
  const outputIndex = args.findIndex(a => a === '--output' || a === '-o');
  let customOutput: string | undefined;
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    customOutput = args[outputIndex + 1];
  }

  const skipRun = args.includes('--skip-run');

  // Get the task prompt (everything that's not a flag)
  const taskPrompt = args
    .filter((a, i) => {
      if (a.startsWith('--') || a.startsWith('-')) return false;
      if (outputIndex !== -1 && i === outputIndex + 1) return false;
      return true;
    })
    .join(' ');

  if (!taskPrompt) {
    console.error('Error: Please provide a task description');
    console.error('Usage: npx claude-gen "Your task description"');
    process.exit(1);
  }

  try {
    // Load configuration
    const config = loadConfig();

    console.log('');
    console.log('='.repeat(60));
    console.log('  Claude-Gen: Browser Automation Script Generator');
    console.log('='.repeat(60));
    console.log('');
    console.log(`Task: ${taskPrompt}`);
    console.log(`Model: ${config.model}`);
    console.log(`CDP URL: ${config.cdpUrl.substring(0, 50)}...`);
    console.log('');

    // Run Claude Code to generate the script
    console.log('[claude-gen] Running Claude Code to generate script...');
    console.log('-'.repeat(60));

    const result = await runClaudeForScriptGeneration(taskPrompt, config);

    console.log('-'.repeat(60));

    if (!result.success || !result.script) {
      console.error(`\n[claude-gen] Failed to generate script`);
      if (result.error) {
        console.error(`[claude-gen] Error: ${result.error}`);
      }
      if (!result.script) {
        console.error('[claude-gen] Could not extract a valid script from Claude\'s output.');
        console.error('[claude-gen] Make sure Claude outputs a bash script in a code block.');
      }
      process.exit(1);
    }

    console.log(`\n[claude-gen] Successfully generated script`);

    // Show a preview of the script
    const scriptLines = result.script.split('\n');
    const previewLines = scriptLines.slice(0, 15);
    console.log('\n[claude-gen] Script preview:');
    console.log('---');
    previewLines.forEach(line => console.log(`  ${line}`));
    if (scriptLines.length > 15) {
      console.log(`  ... (${scriptLines.length - 15} more lines)`);
    }
    console.log('---');

    let finalScriptPath: string;
    let testResult: { success: boolean; iterations: number; skippedDueToStaleCdp?: boolean } | null = null;

    if (!skipRun) {
      // Run iterative testing: test script, fix if needed, repeat
      const iterResult = await runIterativeTest(
        result.script,
        taskPrompt,
        config,
        customOutput
      );

      finalScriptPath = iterResult.finalScriptPath;
      testResult = {
        success: iterResult.success,
        iterations: iterResult.iterations,
        skippedDueToStaleCdp: iterResult.skippedDueToStaleCdp,
      };

      if (iterResult.success) {
        console.log(`\n[claude-gen] Script passed after ${iterResult.iterations} iteration(s)!`);
      } else if (iterResult.skippedDueToStaleCdp) {
        console.log(`\n[claude-gen] Testing skipped - CDP connection unavailable.`);
        console.log(`[claude-gen] Script was generated but needs testing with a fresh CDP_URL.`);
      } else {
        console.log(`\n[claude-gen] Script did not pass after ${iterResult.iterations} attempts.`);
        if (iterResult.lastError) {
          console.log(`[claude-gen] Last error: ${iterResult.lastError.substring(0, 300)}...`);
        }
      }
    } else {
      // Skip testing, just write the script
      finalScriptPath = writeScript(result.script, {
        cdpUrl: config.cdpUrl,
        outputDir: config.outputDir,
        filename: customOutput,
      });
      console.log(`\n[claude-gen] Generated script (testing skipped): ${finalScriptPath}`);
    }

    // Final output
    console.log('\n' + '='.repeat(60));
    if (testResult?.success) {
      console.log('  Script generated and validated successfully!');
    } else if (testResult?.skippedDueToStaleCdp) {
      console.log('  Script generated (testing skipped - CDP unavailable)');
    } else if (testResult) {
      console.log('  Script generated (validation failed after ' + testResult.iterations + ' attempts)');
    } else {
      console.log('  Script generated successfully!');
    }
    console.log('='.repeat(60));
    console.log('');
    console.log(`Script location: ${path.resolve(finalScriptPath)}`);
    console.log('');
    console.log('To run the script:');
    console.log(`  ${finalScriptPath}`);
    console.log('');
    console.log('Or with a custom CDP URL:');
    console.log(`  CDP_URL="wss://..." ${finalScriptPath}`);
    console.log('');

  } catch (error) {
    console.error('\nFatal error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Claude-Gen: Browser Automation Script Generator

Generate repeatable bash scripts from natural language prompts using
Claude Code + agent-browser CLI.

Usage:
  npx claude-gen "Your task description"

Examples:
  npx claude-gen "Go to example.com and get the page title"
  npx claude-gen "Search for 'laptop' on amazon.com and list the first 5 results"
  npx claude-gen "Go to canadagoose.com and extract details of all mens parkas"

Options:
  --output, -o <name>   Custom output filename (without .sh extension)
  --skip-run            Skip automatic script validation
  --help, -h            Show this help message

Environment Variables:
  CDP_URL               WebSocket URL for browser connection (required)
  MODEL                 Claude model to use (default: claude-sonnet-4-20250514)
  MAX_TURNS             Max Claude turns (default: 30)
  OUTPUT_DIR            Directory for generated scripts (default: ./generated)
  SESSIONS_DIR          Directory for session logs (default: ./sessions)
  MAX_FIX_ITERATIONS    Max attempts to fix failing scripts (default: 5)
  FIX_TIMEOUT           Timeout for script execution in ms (default: 180000)
  FIX_REQUEST_TIMEOUT   Timeout for Claude fix requests in ms (default: 120000)

How it works:
  1. Your prompt is sent to Claude Code with agent-browser instructions
  2. Claude uses snapshots to understand the page structure
  3. Claude outputs a complete bash script using replay-safe patterns
  4. The script is tested and iteratively fixed if needed
  5. Final script uses only: open, eval, scroll, sleep (no @eN refs)

Note: Ensure 'agent-browser' and 'claude' CLIs are installed globally.
`);
}

main();
