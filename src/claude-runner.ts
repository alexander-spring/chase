import { spawn } from 'child_process';
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
  const verbose = process.env.CLAUDE_VERBOSE === '1' || process.env.CHASE_VERBOSE === '1';

  // Get the system prompt and combine with task
  const systemPrompt = getSystemPrompt(config.cdpUrl);

  const fullPrompt = `${systemPrompt}

## Your Task

${taskPrompt}`;

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';

    const env = {
      ...process.env,
      CDP_URL: config.cdpUrl,
    };

    if (verbose) {
      console.log(`\n[claude-gen] Starting Claude Code...`);
      console.log(`[claude-gen] Session ID: ${sessionId}`);
    }

    // Spawn Claude directly and pipe prompt via stdin (avoids file I/O)
    const args = ['-p', '--model', config.model, '--max-turns', String(config.maxTurns), '--allowedTools', 'Bash', '--output-format', 'stream-json', '--verbose'];

    const claude = spawn('claude', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Write prompt to stdin and close it
    claude.stdin?.write(fullPrompt);
    claude.stdin?.end();

    claude.stdout?.on('data', (data) => {
      const text = data.toString();
      output += text;
      if (verbose) process.stdout.write(text);
    });

    claude.stderr?.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      if (verbose) process.stderr.write(text);
    });

    claude.on('close', (code) => {
      // Extract the script from Claude's output
      const script = extractScriptFromOutput(output);

      if (verbose) {
        if (script) {
          console.log(`\n[claude-gen] Successfully extracted script from Claude's output`);
        } else {
          console.log(`\n[claude-gen] WARNING: Could not extract script from Claude's output`);
        }
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

// Pre-compiled regex patterns for code block extraction (avoids per-call allocation).
const CODE_BLOCK_PATTERNS = [
  new RegExp('```bash\\n([\\s\\S]*?)```', 'g'),
  new RegExp('```sh\\n([\\s\\S]*?)```', 'g'),
  new RegExp('```shell\\n([\\s\\S]*?)```', 'g'),
  new RegExp('```\\n(#!/bin/bash[\\s\\S]*?)```', 'g'),
];

/**
 * Extract a bash script from Claude's output.
 * Looks for code blocks containing agent-browser commands.
 */
function extractScriptFromOutput(output: string): string | null {
  // First, try to extract text content from stream-json format
  const textContent = extractTextFromStreamJson(output);

  let bestScript: string | null = null;
  let bestScore = 0;

  for (const pattern of CODE_BLOCK_PATTERNS) {
    pattern.lastIndex = 0;
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
