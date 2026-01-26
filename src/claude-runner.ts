import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getSystemPrompt } from './prompts/system-prompt.js';
import type { Config } from './config.js';

export interface ClaudeResult {
  success: boolean;
  sessionId: string;
  output: string;
  script: string | null;
  error?: string;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `session-${timestamp}-${random}`;
}

/**
 * Run Claude Code CLI to generate a browser automation script.
 *
 * Claude will:
 * 1. Use snapshot commands to understand the page (for its own understanding)
 * 2. Output a complete bash script in a code block
 *
 * We extract the script from Claude's output, not by capturing individual commands.
 */
export async function runClaudeForScriptGeneration(
  taskPrompt: string,
  config: Config
): Promise<ClaudeResult> {
  const sessionId = generateSessionId();

  // Ensure sessions directory exists
  if (!fs.existsSync(config.sessionsDir)) {
    fs.mkdirSync(config.sessionsDir, { recursive: true });
  }

  // Get the system prompt and combine with task
  const systemPrompt = getSystemPrompt(config.cdpUrl);

  const fullPrompt = `${systemPrompt}

## Your Task

${taskPrompt}`;

  // Write full prompt to a file
  const promptFile = path.join(config.sessionsDir, `${sessionId}-prompt.txt`);
  fs.writeFileSync(promptFile, fullPrompt);

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';

    const env = {
      ...process.env,
      CDP_URL: config.cdpUrl,
    };

    console.log(`\n[claude-gen] Starting Claude Code...`);
    console.log(`[claude-gen] Session ID: ${sessionId}`);

    // Use stream-json for verbose output, allow Bash for snapshots
    const shellCmd = `cat "${promptFile}" | claude -p --model ${config.model} --max-turns ${config.maxTurns} --allowedTools "Bash" --output-format stream-json --verbose`;

    const claude = spawn('bash', ['-c', shellCmd], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    claude.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    claude.stderr?.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      process.stderr.write(text);
    });

    claude.on('close', (code) => {
      // Clean up temp files
      cleanup(promptFile);

      // Extract the script from Claude's output
      const script = extractScriptFromOutput(output);

      if (script) {
        console.log(`\n[claude-gen] Successfully extracted script from Claude's output`);
      } else {
        console.log(`\n[claude-gen] WARNING: Could not extract script from Claude's output`);
      }

      resolve({
        success: code === 0 && script !== null,
        sessionId,
        output,
        script,
        error: code !== 0 ? (errorOutput || `Exit code: ${code}`) : undefined,
      });
    });

    claude.on('error', (err) => {
      cleanup(promptFile);
      resolve({
        success: false,
        sessionId,
        output,
        script: null,
        error: err.message,
      });
    });
  });
}

function cleanup(...files: string[]) {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Extract a bash script from Claude's output.
 * Looks for code blocks containing agent-browser commands.
 */
function extractScriptFromOutput(output: string): string | null {
  // First, try to extract text content from stream-json format
  const textContent = extractTextFromStreamJson(output);

  // Look for bash code blocks in the extracted text
  // Use new RegExp to avoid backtick escaping issues
  const codeBlockPatterns = [
    new RegExp('```bash\\n([\\s\\S]*?)```', 'g'),
    new RegExp('```sh\\n([\\s\\S]*?)```', 'g'),
    new RegExp('```shell\\n([\\s\\S]*?)```', 'g'),
    new RegExp('```\\n(#!/bin/bash[\\s\\S]*?)```', 'g'),
  ];

  let bestScript: string | null = null;
  let bestScore = 0;

  for (const pattern of codeBlockPatterns) {
    let match;
    while ((match = pattern.exec(textContent)) !== null) {
      const script = match[1].trim();
      const score = scoreScript(script);
      if (score > bestScore) {
        bestScore = score;
        bestScript = script;
      }
    }
  }

  if (bestScript) {
    // Ensure it has shebang
    if (!bestScript.startsWith('#!/')) {
      bestScript = '#!/bin/bash\nset -e\n\nCDP="${CDP_URL:?Required}"\n\n' + bestScript;
    }
    return bestScript;
  }

  // Fallback: look for agent-browser commands and construct a script
  const commands = extractAgentBrowserCommands(textContent);
  if (commands.length > 0) {
    // Filter out snapshot commands
    const replayableCommands = commands.filter(cmd => !cmd.includes('snapshot'));
    if (replayableCommands.length > 0) {
      return constructScriptFromCommands(replayableCommands);
    }
  }

  return null;
}

/**
 * Extract text content from stream-json format output
 */
function extractTextFromStreamJson(output: string): string {
  const lines = output.split('\n');
  const textParts: string[] = [];

  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;

    try {
      const json = JSON.parse(line);

      // Extract text from assistant messages
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          }
        }
      }

      // Also check for result messages
      if (json.type === 'result' && json.result) {
        textParts.push(json.result);
      }
    } catch {
      // Not valid JSON, might be raw text
      textParts.push(line);
    }
  }

  return textParts.join('\n');
}

/**
 * Score a script based on how complete it looks
 */
function scoreScript(script: string): number {
  let score = 0;

  // Must have agent-browser commands
  if (!script.includes('agent-browser')) return 0;

  // Bonus for having shebang
  if (script.includes('#!/bin/bash')) score += 10;

  // Bonus for having CDP variable
  if (script.includes('CDP=') || script.includes('$CDP')) score += 10;

  // Bonus for having open command
  if (script.includes('open "http')) score += 20;

  // Bonus for having eval command (data extraction)
  if (script.includes('eval "')) score += 20;

  // Bonus for having FINAL RESULTS section
  if (script.includes('FINAL RESULTS') || script.includes('echo "$')) score += 10;

  // Penalty for snapshot commands (shouldn't be in final script)
  const snapshotCount = (script.match(/snapshot/g) || []).length;
  score -= snapshotCount * 5;

  // Penalty for @eN refs (shouldn't be in final script)
  const refCount = (script.match(/@e\d+/g) || []).length;
  score -= refCount * 10;

  // Count useful commands
  const openCount = (script.match(/\bopen\s+"/g) || []).length;
  const evalCount = (script.match(/\beval\s+"/g) || []).length;
  score += openCount * 5 + evalCount * 10;

  return score;
}

/**
 * Extract agent-browser commands from text
 */
function extractAgentBrowserCommands(text: string): string[] {
  const commands: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comment lines
    if (trimmed.startsWith('#')) continue;

    // Look for agent-browser commands
    if (trimmed.includes('agent-browser') && trimmed.includes('--cdp')) {
      // Extract the command portion
      const match = trimmed.match(/(agent-browser\s+--cdp\s+[^\n]+)/);
      if (match && !commands.includes(match[1])) {
        commands.push(match[1]);
      }
    }
  }

  return commands;
}

/**
 * Construct a script from extracted commands (fallback)
 */
function constructScriptFromCommands(commands: string[]): string {
  const lines = [
    '#!/bin/bash',
    'set -e',
    '',
    '# Generated by claude-gen (fallback mode)',
    'CDP="${CDP_URL:?Required: CDP_URL}"',
    '',
  ];

  for (const cmd of commands) {
    // Normalize CDP variable
    let normalized = cmd
      .replace(/"\$CDP_URL"/g, '"$CDP"')
      .replace(/\$CDP_URL/g, '$CDP');

    lines.push(normalized);

    // Add sleep after navigation
    if (cmd.includes(' open ')) {
      lines.push('sleep 2');
    }
  }

  lines.push('');
  lines.push('echo "Script completed"');

  return lines.join('\n');
}

// Keep the old function for backwards compatibility, but have it use the new one
export async function runClaudeWithOutputParsing(
  taskPrompt: string,
  config: Config
): Promise<ClaudeResult & { commands: string[] }> {
  const result = await runClaudeForScriptGeneration(taskPrompt, config);

  // Extract commands from script for backwards compatibility
  const commands: string[] = [];
  if (result.script) {
    const lines = result.script.split('\n');
    for (const line of lines) {
      if (line.includes('agent-browser') && !line.trim().startsWith('#')) {
        commands.push(line.trim());
      }
    }
  }

  return {
    ...result,
    commands,
  };
}
