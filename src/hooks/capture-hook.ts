#!/usr/bin/env node
/**
 * PostToolUse hook for capturing agent-browser commands
 *
 * This hook is invoked by Claude Code after each Bash tool use.
 * It filters for agent-browser commands and logs them to a session file.
 *
 * Input (stdin): JSON with tool_name, tool_input, tool_output, session_id
 * Output (stdout): JSON with decision (allow/block) and optional reason
 */

import * as fs from 'fs';
import * as path from 'path';

interface HookInput {
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
  tool_output?: string;
  session_id: string;
}

interface CommandLogEntry {
  timestamp: string;
  command: string;
  output: string;
  success: boolean;
}

async function main() {
  // Read input from stdin
  let inputData = '';
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  try {
    const input: HookInput = JSON.parse(inputData);

    // Only process Bash tool calls
    if (input.tool_name !== 'Bash') {
      // Allow other tools to proceed
      console.log(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const command = input.tool_input.command || '';

    // Only log agent-browser commands
    if (command.includes('agent-browser')) {
      const sessionsDir = process.env.CLAUDE_GEN_SESSIONS_DIR || './sessions';
      const sessionFile = path.join(sessionsDir, `${input.session_id}.jsonl`);

      // Ensure sessions directory exists
      if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir, { recursive: true });
      }

      // Determine if command was successful (exit code 0)
      const output = input.tool_output || '';
      const success = !output.includes('Error:') && !output.includes('error:');

      const entry: CommandLogEntry = {
        timestamp: new Date().toISOString(),
        command,
        output: output.substring(0, 1000), // Truncate long outputs
        success,
      };

      // Append to session file
      fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
    }

    // Always allow the command to proceed
    console.log(JSON.stringify({ decision: 'allow' }));
  } catch (error) {
    // On error, still allow the command
    console.error('Hook error:', error);
    console.log(JSON.stringify({ decision: 'allow' }));
  }
}

main();
