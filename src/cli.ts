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

const API_BASE = process.env.CHASE_API_URL || 'https://chase-api-gth2quoxyq-uc.a.run.app';

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

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('--')) {
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
      headers: {
        'Content-Type': 'application/json',
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

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║            Chase Browser Automation                  ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Task: ${task}`);
  console.log('');

  const body: Record<string, unknown> = {
    task,
    browserCashApiKey: apiKey,
  };

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
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

  let taskId: string | null = null;
  let result: unknown = null;

  await streamRequest('/automate/stream', body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        taskId = d.taskId as string;
        console.log(`Task ID: ${taskId}`);
        console.log('Status: Running...');
        break;
      case 'log':
        if (!flags.quiet) {
          console.log(`  ${d.message}`);
        }
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        console.error(`Error: ${d.message}`);
        break;
    }
  });

  console.log('');
  if (result) {
    const r = result as Record<string, unknown>;
    if (r.success) {
      console.log('Status: Complete ✓');
      console.log('');
      console.log('Result:');
      console.log(JSON.stringify(r.result, null, 2));
      if (r.summary) {
        console.log('');
        console.log(`Summary: ${r.summary}`);
      }
    } else {
      console.log('Status: Failed ✗');
      console.log(`Error: ${r.error}`);
    }
  }
  console.log('');
}

async function commandGenerate(task: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          Chase Script Generator                      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Task: ${task}`);
  console.log('');

  const body: Record<string, unknown> = {
    task,
    browserCashApiKey: apiKey,
    skipTest: flags['skip-test'] === true,
  };

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
  }

  let taskId: string | null = null;
  let result: unknown = null;

  await streamRequest('/generate/stream', body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        taskId = d.taskId as string;
        console.log(`Task ID: ${taskId}`);
        console.log('Status: Generating...');
        break;
      case 'log':
        if (!flags.quiet) {
          console.log(`  ${d.message}`);
        }
        break;
      case 'iteration_result':
        console.log(`  Iteration ${d.iteration}: ${d.success ? 'passed' : 'failed'}`);
        break;
      case 'script_saved':
        console.log(`  Script saved: ${d.scriptId}`);
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        console.error(`Error: ${d.message}`);
        break;
    }
  });

  console.log('');
  if (result) {
    const r = result as Record<string, unknown>;
    if (r.success) {
      console.log('Status: Complete ✓');
      console.log(`Script ID: ${r.scriptId}`);
      console.log(`Iterations: ${r.iterations}`);
      if (!flags.quiet) {
        console.log('');
        console.log('Script Preview:');
        console.log('─'.repeat(60));
        const lines = (r.script as string).split('\n').slice(0, 20);
        lines.forEach((line) => console.log(line));
        if ((r.script as string).split('\n').length > 20) {
          console.log('... (truncated)');
        }
        console.log('─'.repeat(60));
      }
      console.log('');
      console.log(`Run with: chase run ${r.scriptId}`);
    } else {
      console.log('Status: Failed ✗');
      console.log(`Error: ${r.error || 'Script generation failed'}`);
    }
  }
  console.log('');
}

async function commandScripts(): Promise<void> {
  const apiKey = getApiKey();

  console.log('');
  console.log('Your Scripts:');
  console.log('─'.repeat(60));

  const response = (await apiGet('/scripts', apiKey)) as { scripts: Array<Record<string, unknown>> };

  if (!response.scripts || response.scripts.length === 0) {
    console.log('  No scripts found.');
    console.log('');
    console.log('  Generate one with:');
    console.log('    chase generate "Your task here"');
  } else {
    for (const script of response.scripts) {
      console.log('');
      console.log(`  ID: ${script.id}`);
      console.log(`  Task: ${script.task}`);
      console.log(`  Created: ${script.createdAt}`);
      console.log(`  Status: ${script.success ? '✓ Passed' : '✗ Failed'} (${script.iterations} iterations)`);
    }
  }
  console.log('');
}

async function commandRun(scriptId: string, flags: Record<string, string | boolean>): Promise<void> {
  const apiKey = getApiKey();

  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          Chase Script Runner                         ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Script ID: ${scriptId}`);
  console.log('');

  const body: Record<string, unknown> = {
    browserCashApiKey: apiKey,
  };

  if (flags.country) {
    body.browserOptions = { ...(body.browserOptions as object || {}), country: flags.country };
  }

  let result: unknown = null;
  let output = '';

  await streamRequest(`/scripts/${scriptId}/run`, body, (type, data) => {
    const d = data as Record<string, unknown>;
    switch (type) {
      case 'start':
        console.log(`Task ID: ${d.taskId}`);
        console.log('Status: Running...');
        break;
      case 'output':
        output += d.text;
        if (!flags.quiet) {
          process.stdout.write(d.text as string);
        }
        break;
      case 'complete':
        result = d;
        break;
      case 'error':
        console.error(`Error: ${d.message}`);
        break;
    }
  });

  console.log('');
  if (result) {
    const r = result as Record<string, unknown>;
    if (r.success) {
      console.log('Status: Complete ✓');
      if (flags.quiet && output) {
        console.log('Output:');
        console.log(output);
      }
    } else {
      console.log('Status: Failed ✗');
      console.log(`Exit code: ${r.exitCode}`);
    }
  }
  console.log('');
}

async function commandTasks(): Promise<void> {
  const apiKey = getApiKey();

  console.log('');
  console.log('Recent Tasks:');
  console.log('─'.repeat(60));

  const response = (await apiGet('/tasks', apiKey)) as { tasks: Array<Record<string, unknown>> };

  if (!response.tasks || response.tasks.length === 0) {
    console.log('  No tasks found.');
  } else {
    for (const task of response.tasks) {
      console.log('');
      console.log(`  ID: ${task.taskId}`);
      console.log(`  Type: ${task.type}`);
      console.log(`  Status: ${task.status}`);
      console.log(`  Task: ${(task.task as string)?.substring(0, 50)}${(task.task as string)?.length > 50 ? '...' : ''}`);
      console.log(`  Created: ${task.createdAt}`);
    }
  }
  console.log('');
}

async function commandTask(taskId: string): Promise<void> {
  const apiKey = getApiKey();

  console.log('');
  console.log('Task Details:');
  console.log('─'.repeat(60));

  const task = (await apiGet(`/tasks/${taskId}`, apiKey)) as Record<string, unknown>;

  if (task.error) {
    console.log(`  Error: ${task.error}`);
  } else {
    console.log(`  ID: ${task.taskId}`);
    console.log(`  Type: ${task.type}`);
    console.log(`  Status: ${task.status}`);
    console.log(`  Task: ${task.task}`);
    console.log(`  Created: ${task.createdAt}`);
    console.log(`  Updated: ${task.updatedAt}`);

    if (task.status === 'completed') {
      if (task.result) {
        console.log('');
        console.log('  Result:');
        console.log(JSON.stringify(task.result, null, 2).split('\n').map((l) => '    ' + l).join('\n'));
      }
      if (task.script) {
        console.log('');
        console.log(`  Script ID: ${task.scriptId}`);
      }
    } else if (task.status === 'error') {
      console.log(`  Error: ${task.error}`);
    }
  }
  console.log('');
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
  --country <code>    Use a browser from specific country (e.g., US, DE, JP)
  --adblock           Enable ad-blocking
  --captcha           Enable CAPTCHA solving
  --max-turns <n>     Max Claude iterations (default: 30, use 50+ for complex tasks)
  --quiet             Reduce output verbosity
  --skip-test         Skip script testing (generate only)
  --help              Show this help message

ENVIRONMENT:
  BROWSER_CASH_API_KEY   Your Browser.cash API key (required)

Get your API key at: https://browser.cash
`);
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs();

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
        await commandScripts();
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
        await commandTasks();
        break;

      case 'task':
        if (!args[0]) {
          console.error('Error: Task ID required');
          console.error('Usage: chase task <task-id>');
          process.exit(1);
        }
        await commandTask(args[0]);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "chase help" for usage information');
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
