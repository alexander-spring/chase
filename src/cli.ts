#!/usr/bin/env node

/**
 * Chase CLI
 *
 * A command-line interface for browser automation using the chase API.
 *
 * Usage:
 *   chase automate "Go to example.com and get the title"
 *   chase generate "Scrape products from amazon.com"
 *   chase scripts
 *   chase run <script-id>
 *   chase tasks
 *   chase task <task-id>
 */

import * as https from 'https';
import * as http from 'http';

const API_BASE = process.env.CHASE_API_URL || 'https://chase-api-264851422957.us-central1.run.app';
const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

type OutputMode = 'pretty' | 'json';

function getOutputMode(flags: Record<string, string | boolean>): OutputMode {
  if (flags.pretty) return 'pretty';
  if (flags.json) return 'json';
  // Default to JSON to avoid polluting tool contexts.
  // Use --pretty for human-readable output.
  return 'json';
}

function createPrinters(mode: OutputMode) {
  const writeStdout = (text: string) => process.stdout.write(text);
  const writeStderr = (text: string) => process.stderr.write(text);

  return {
    mode,
    outLine: (line: string = '') => {
      if (mode === 'json') return;
      writeStdout(line + '\n');
    },
    errLine: (line: string = '') => {
      writeStderr(line + '\n');
    },
    logLine: (line: string = '') => {
      // In JSON mode, send logs to stderr (keeps stdout clean).
      if (mode === 'json') {
        writeStderr(line + '\n');
      } else {
        writeStdout(line + '\n');
      }
    },
    json: (obj: unknown) => {
      // Keep stdout as small as possible for tool contexts.
      writeStdout(JSON.stringify(obj) + '\n');
    },
  };
}

function safeLogMessage(message: unknown, maxLen: number = 500): string {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  const oneLine = text.replace(/\r?\n/g, ' ').trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

function getApiKey(): string {
  const key = process.env.BROWSER_CASH_API_KEY;
  if (!key) {
    console.error('Error: BROWSER_CASH_API_KEY environment variable is required');
    console.error('');
    console.error('Set it with:');
    console.error('  export BROWSER_CASH_API_KEY="your-api-key"');
    console.error('');
    console.error('Get an API key at: https://browser.cash');
    process.exit(1);
  }
  return key;
}

function parseArgs(): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const rawArgs = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const valueFlags = new Set(['country', 'type', 'model', 'max-turns', 'max-iterations', 'limit']);

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags[key] = value;
        continue;
      }

      const key = arg.slice(2);
      const next = rawArgs[i + 1];
      if (valueFlags.has(key) && next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] || 'help',
    args: positional.slice(1),
    flags,
  };
}

async function streamRequest(
  endpoint: string,
  body: object,
  onEvent: (type: string, data: unknown) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              onEvent(event.type, event.data);
            } catch {
              // Ignore parse errors
            }
          }
        }
      });

      res.on('end', () => {
        if (buffer.startsWith('data: ')) {
          try {
            const event = JSON.parse(buffer.slice(6));
            onEvent(event.type, event.data);
          } catch {
            // Ignore
          }
        }
        resolve();
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function apiGet(endpoint: string, apiKey: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'x-api-key': apiKey,
      },
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();
  });
}

async function commandAutomate(task: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);
  const verbose = Boolean(flags.verbose);
  const quiet = Boolean(flags.quiet) || (outputMode === 'json' && !verbose);

  if (!quiet) {
    p.logLine('');
    p.logLine('╔═══════════════════════════════════════════════════════════╗');
    p.logLine('║            Chase Browser Automation                  ║');
    p.logLine('╚═══════════════════════════════════════════════════════════╝');
    p.logLine('');
    p.logLine(`Task: ${task}`);
    p.logLine('');
  }

  const body: Record<string, unknown> = {
    task,
    browserCashApiKey: apiKey,
  };

  if (flags.verbose) {
    body.verbose = true;
  }

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
  }
  if (flags.type) {
    body.browserOptions = { ...(body.browserOptions as object || {}), type: flags.type };
  }
  if (flags.adblock) {
    body.browserOptions = { ...(body.browserOptions as object || {}), adblock: true };
  }
  if (flags.captcha) {
    body.browserOptions = { ...(body.browserOptions as object || {}), captchaSolver: true };
  }
  if (flags['max-turns']) {
    body.maxTurns = parseInt(flags['max-turns'] as string, 10);
  }
  if (flags.model) {
    // Support shorthand model names
    const modelMap: Record<string, string> = {
      'haiku': 'claude-haiku-4-5-20251001',
      'sonnet': 'claude-sonnet-4-20250514',
      'opus': 'claude-opus-4-5-20251101',
    };
    const modelName = flags.model as string;
    body.model = modelMap[modelName.toLowerCase()] || modelName;
  }

  let taskId: string | null = null;
  let result: unknown = null;
  let requestErrored = false;
  let browserSessionId: string | null = null;

  await streamRequest('/automate/stream', body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        taskId = d.taskId as string;
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) {
          p.logLine(`Task ID: ${taskId}`);
          p.logLine('Status: Running...');
        }
        break;
      case 'log':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (quiet) break;
        // Server emits levels; default to showing info/warn/error, hide debug unless --verbose.
        if (!verbose && d.level === 'debug') break;
        if (d.message !== undefined) p.logLine(`  ${safeLogMessage(d.message)}`);
        break;
      case 'browser_connected':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) p.logLine(`Viewer: ${d.viewerUrl}`);
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        requestErrored = true;
        if (outputMode === 'pretty' || verbose) p.errLine(`Error: ${safeLogMessage(d.message)}`);
        break;
    }
  });

  if (!result) {
    if (outputMode === 'json') {
      p.json({ success: false, taskId, error: requestErrored ? 'Request failed' : 'No result received' });
    } else {
      p.logLine('');
      p.logLine('Status: Failed ✗');
      p.logLine('Error: No result received');
      p.logLine('');
    }
    process.exitCode = 1;
    return;
  }

  const r = result as Record<string, unknown>;
  const success = Boolean(r.success);

  if (outputMode === 'json') {
    p.json({
      success,
      taskId: (r.taskId as string | undefined) || taskId,
      result: r.result,
      summary: r.summary,
      error: r.error,
      browserSessionId: (r.browserSessionId as string | undefined) || browserSessionId || undefined,
    });
  } else {
    p.logLine('');
    if (success) {
      p.logLine('Status: Complete ✓');
      p.logLine('');
      p.logLine('Result:');
      p.logLine(typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2));
      if (r.summary) {
        p.logLine('');
        p.logLine(`Summary: ${r.summary}`);
      }
    } else {
      p.logLine('Status: Failed ✗');
      p.logLine(`Error: ${r.error}`);
    }
    p.logLine('');
  }

  if (!success) process.exitCode = 1;
}

async function commandGenerate(task: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);
  const verbose = Boolean(flags.verbose);
  const quiet = Boolean(flags.quiet) || (outputMode === 'json' && !verbose);

  if (!quiet) {
    p.logLine('');
    p.logLine('╔═══════════════════════════════════════════════════════════╗');
    p.logLine('║          Chase Script Generator                      ║');
    p.logLine('╚═══════════════════════════════════════════════════════════╝');
    p.logLine('');
    p.logLine(`Task: ${task}`);
    p.logLine('');
  }

  const body: Record<string, unknown> = {
    task,
    browserCashApiKey: apiKey,
    skipTest: flags['skip-test'] === true,
  };

  if (flags.verbose) {
    body.verbose = true;
  }

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
  }
  if (flags.type) {
    body.browserOptions = { ...(body.browserOptions as object || {}), type: flags.type };
  }
  if (flags['max-iterations']) {
    body.maxIterations = parseInt(flags['max-iterations'] as string, 10);
  }
  if (flags['max-turns']) {
    body.maxTurns = parseInt(flags['max-turns'] as string, 10);
  }

  let taskId: string | null = null;
  let result: unknown = null;
  let requestErrored = false;
  let browserSessionId: string | null = null;

  await streamRequest('/generate/stream', body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        taskId = d.taskId as string;
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) {
          p.logLine(`Task ID: ${taskId}`);
          p.logLine('Status: Generating...');
        }
        break;
      case 'log':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (quiet) break;
        if (!verbose && d.level === 'debug') break;
        if (d.message !== undefined) p.logLine(`  ${safeLogMessage(d.message)}`);
        break;
      case 'browser_connected':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) p.logLine(`Viewer: ${d.viewerUrl}`);
        break;
      case 'iteration_result':
        if (!quiet) p.logLine(`  Iteration ${d.iteration}: ${d.success ? 'passed' : 'failed'}`);
        break;
      case 'script_saved':
        if (!quiet) p.logLine(`  Script saved: ${d.scriptId}`);
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        requestErrored = true;
        if (outputMode === 'pretty' || verbose) p.errLine(`Error: ${safeLogMessage(d.message)}`);
        break;
    }
  });

  if (!result) {
    if (outputMode === 'json') {
      p.json({ success: false, taskId, browserSessionId: browserSessionId || undefined, error: requestErrored ? 'Request failed' : 'No result received' });
    } else {
      p.logLine('');
      p.logLine('Status: Failed ✗');
      p.logLine('Error: No result received');
      p.logLine('');
    }
    process.exitCode = 1;
    return;
  }

  const r = result as Record<string, unknown>;
  const success = Boolean(r.success);

  if (outputMode === 'json') {
    p.json({
      success,
      taskId: (r.taskId as string | undefined) || taskId,
      scriptId: r.scriptId,
      iterations: r.iterations,
      script: r.script,
      error: r.error,
      browserSessionId: (r.browserSessionId as string | undefined) || browserSessionId || undefined,
    });
  } else {
    p.logLine('');
    if (success) {
      p.logLine('Status: Complete ✓');
      p.logLine(`Script ID: ${r.scriptId}`);
      p.logLine(`Iterations: ${r.iterations}`);
      if (!quiet) {
        p.logLine('');
        p.logLine('Script Preview:');
        p.logLine('─'.repeat(60));
        const lines = (r.script as string).split('\n').slice(0, 20);
        lines.forEach((line) => p.logLine(line));
        if ((r.script as string).split('\n').length > 20) {
          p.logLine('... (truncated)');
        }
        p.logLine('─'.repeat(60));
      }
      p.logLine('');
      p.logLine(`Run with: chase run ${r.scriptId}`);
    } else {
      p.logLine('Status: Failed ✗');
      p.logLine(`Error: ${r.error || 'Script generation failed'}`);
    }
    p.logLine('');
  }

  if (!success) process.exitCode = 1;
}

async function commandScripts(flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);

  const limit = typeof flags.limit === 'string' ? flags.limit : undefined;
  const response = (await apiGet(limit ? `/scripts?limit=${encodeURIComponent(limit)}` : '/scripts', apiKey)) as {
    scripts: Array<Record<string, unknown>>;
  };
  if (outputMode === 'json') {
    p.json(response);
    return;
  }

  p.outLine('');
  p.outLine('Your Scripts:');
  p.outLine('─'.repeat(60));

  if (!response.scripts || response.scripts.length === 0) {
    p.outLine('  No scripts found.');
    p.outLine('');
    p.outLine('  Generate one with:');
    p.outLine('    chase generate "Your task here"');
  } else {
    for (const script of response.scripts) {
      p.outLine('');
      p.outLine(`  ID: ${script.id}`);
      p.outLine(`  Task: ${script.task}`);
      p.outLine(`  Created: ${script.createdAt}`);
      p.outLine(`  Status: ${script.success ? '✓ Passed' : '✗ Failed'} (${script.iterations} iterations)`);
    }
  }
  p.outLine('');
}

async function commandRun(scriptId: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);
  const verbose = Boolean(flags.verbose);
  const quiet = Boolean(flags.quiet) || (outputMode === 'json' && !verbose);

  if (!quiet) {
    p.logLine('');
    p.logLine('╔═══════════════════════════════════════════════════════════╗');
    p.logLine('║          Chase Script Runner                         ║');
    p.logLine('╚═══════════════════════════════════════════════════════════╝');
    p.logLine('');
    p.logLine(`Script ID: ${scriptId}`);
    p.logLine('');
  }

  const body: Record<string, unknown> = {
    browserCashApiKey: apiKey,
  };

  if (flags.verbose) {
    body.verbose = true;
  }

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
  }
  if (flags.type) {
    body.browserOptions = { ...(body.browserOptions as object || {}), type: flags.type };
  }

  let result: unknown = null;
  let output = '';
  let requestErrored = false;
  let browserSessionId: string | null = null;

  await streamRequest(`/scripts/${scriptId}/run`, body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) {
          p.logLine(`Task ID: ${d.taskId}`);
          p.logLine('Status: Running...');
        }
        break;
      case 'output':
        output += d.text;
        if (!quiet && outputMode === 'pretty') process.stdout.write(d.text as string);
        break;
      case 'browser_connected':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (!quiet) p.logLine(`Viewer: ${d.viewerUrl}`);
        break;
      case 'log':
        if (typeof d.browserSessionId === 'string') browserSessionId = d.browserSessionId;
        if (quiet) break;
        if (!verbose && d.level === 'debug') break;
        if (d.message !== undefined) p.logLine(`  ${safeLogMessage(d.message)}`);
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        requestErrored = true;
        if (outputMode === 'pretty' || verbose) p.errLine(`Error: ${safeLogMessage(d.message)}`);
        break;
    }
  });

  if (!result) {
    if (outputMode === 'json') {
      p.json({ success: false, scriptId, error: requestErrored ? 'Request failed' : 'No result received', output });
    } else {
      p.logLine('');
      p.logLine('Status: Failed ✗');
      p.logLine('Error: No result received');
      p.logLine('');
    }
    process.exitCode = 1;
    return;
  }

  const r = result as Record<string, unknown>;
  const success = Boolean(r.success);

  if (outputMode === 'json') {
    p.json({
      success,
      taskId: r.taskId,
      scriptId,
      exitCode: r.exitCode,
      output: output || r.output,
      error: r.error,
      browserSessionId: (r.browserSessionId as string | undefined) || browserSessionId || undefined,
    });
  } else {
    p.logLine('');
    if (success) {
      p.logLine('Status: Complete ✓');
      if (quiet && output) {
        p.logLine('Output:');
        p.logLine(output);
      }
    } else {
      p.logLine('Status: Failed ✗');
      p.logLine(`Exit code: ${r.exitCode}`);
    }
    p.logLine('');
  }

  if (!success) process.exitCode = 1;
}

async function commandTasks(flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);

  const limit = typeof flags.limit === 'string' ? flags.limit : undefined;
  const response = (await apiGet(limit ? `/tasks?limit=${encodeURIComponent(limit)}` : '/tasks', apiKey)) as {
    tasks: Array<Record<string, unknown>>;
  };
  if (outputMode === 'json') {
    p.json(response);
    return;
  }

  p.outLine('');
  p.outLine('Recent Tasks:');
  p.outLine('─'.repeat(60));

  if (!response.tasks || response.tasks.length === 0) {
    p.outLine('  No tasks found.');
  } else {
    for (const task of response.tasks) {
      p.outLine('');
      p.outLine(`  ID: ${task.taskId}`);
      p.outLine(`  Type: ${task.type}`);
      p.outLine(`  Status: ${task.status}`);
      p.outLine(`  Task: ${(task.task as string)?.substring(0, 50)}${(task.task as string)?.length > 50 ? '...' : ''}`);
      p.outLine(`  Created: ${task.createdAt}`);
    }
  }
  p.outLine('');
}

async function commandTask(taskId: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);

  const task = (await apiGet(`/tasks/${taskId}`, apiKey)) as Record<string, unknown>;
  if (outputMode === 'json') {
    p.json(task);
    return;
  }

  p.outLine('');
  p.outLine('Task Details:');
  p.outLine('─'.repeat(60));

  if (task.error) {
    p.outLine(`  Error: ${task.error}`);
  } else {
    p.outLine(`  ID: ${task.taskId}`);
    p.outLine(`  Type: ${task.type}`);
    p.outLine(`  Status: ${task.status}`);
    p.outLine(`  Task: ${task.task}`);
    p.outLine(`  Created: ${task.createdAt}`);
    p.outLine(`  Updated: ${task.updatedAt}`);

    if (task.status === 'completed') {
      if (task.result) {
        p.outLine('');
        p.outLine('  Result:');
        p.outLine(JSON.stringify(task.result, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
      }
      if (task.script) {
        p.outLine('');
        p.outLine(`  Script ID: ${task.scriptId}`);
      }
    } else if (task.status === 'error') {
      p.outLine(`  Error: ${task.error}`);
    }
  }
  p.outLine('');
}

function printHelp(): void {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║          Chase: AI Browser Automation                ║
╚═══════════════════════════════════════════════════════════╝

USAGE:
  chase <command> [options]

COMMANDS:
  automate <task>     Perform a one-off browser automation task
  generate <task>     Generate a reusable automation script
  scripts             List your saved scripts
  run <script-id>     Run a saved script
  tasks               List your recent tasks
  task <task-id>      Get details of a specific task
  help                Show this help message

EXAMPLES:
  chase automate "Go to example.com and get the page title"
  chase automate "Extract the top 10 stories from Hacker News"
  chase generate "Scrape product prices from amazon.com/dp/B09V3KXJPB"
  chase scripts
  chase run script-abc123
  chase task task-xyz789

OPTIONS:
  --country <code>      Use a browser from specific country (e.g., US, DE, JP)
  --type <type>         Browser node type (consumer_distributed, hosted, testing)
  --limit <n>           Limit list size for scripts/tasks (default: 50)
  --adblock             Enable ad-blocking
  --captcha             Enable CAPTCHA solving
  --max-turns <n>       Max Claude turns (automate: default 30, generate fix: capped at 15)
  --max-iterations <n>  Max fix iterations for generate (default: 5)
  --quiet               Reduce output verbosity
  --verbose             Show debug logs (and enable verbose server-side streaming)
  --json                Emit JSON only on stdout (default)
  --pretty              Human-readable output
  --skip-test           Skip script testing (generate only)
  --help                Show this help message

ENVIRONMENT:
  BROWSER_CASH_API_KEY   Your Browser.cash API key (required)

Get your API key at: https://browser.cash
`);
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs();
  const outputMode = getOutputMode(flags);
  const p = createPrinters(outputMode);

  if (flags.help || command === 'help') {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'automate':
        if (!args[0]) {
          console.error('Error: Task description required');
          console.error('Usage: chase automate "Your task here"');
          process.exit(1);
        }
        await commandAutomate(args.join(' '), flags);
        break;

      case 'generate':
        if (!args[0]) {
          console.error('Error: Task description required');
          console.error('Usage: chase generate "Your task here"');
          process.exit(1);
        }
        await commandGenerate(args.join(' '), flags);
        break;

      case 'scripts':
        await commandScripts(flags);
        break;

      case 'run':
        if (!args[0]) {
          console.error('Error: Script ID required');
          console.error('Usage: chase run <script-id>');
          process.exit(1);
        }
        await commandRun(args[0], flags);
        break;

      case 'tasks':
        await commandTasks(flags);
        break;

      case 'task':
        if (!args[0]) {
          console.error('Error: Task ID required');
          console.error('Usage: chase task <task-id>');
          process.exit(1);
        }
        await commandTask(args[0], flags);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "chase help" for usage information');
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (outputMode === 'json') {
      p.json({ success: false, command, args, error: message });
      process.exitCode = 1;
      return;
    }
    console.error('Error:', message);
    process.exit(1);
  }
}

main();
