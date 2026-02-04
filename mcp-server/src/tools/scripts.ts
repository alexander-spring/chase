import type { ApiClient } from '../lib/api-client.js';
import type { RunScriptCompleteData, RunScriptRequest } from '../lib/types.js';
import { extractTaskId, consumeStreamUntilComplete } from '../lib/sse-handler.js';

/**
 * Tool definition for list_scripts
 */
export const listScriptsTool = {
  name: 'list_scripts',
  description: 'List all stored automation scripts. Returns metadata for each script including ID, task description, and creation date.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      apiKey: {
        type: 'string',
        description: 'Browser.cash API key for authentication. Required.',
      },
    },
    required: ['apiKey'],
  },
};

/**
 * Handle list_scripts tool call
 */
export async function handleListScripts(
  client: ApiClient,
  args: { apiKey: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await client.listScripts(args.apiKey);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2),
      }],
    };
  }
}

/**
 * Tool definition for get_script
 */
export const getScriptTool = {
  name: 'get_script',
  description: 'Get details of a specific script including its content and metadata.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'The script ID to retrieve.',
      },
      apiKey: {
        type: 'string',
        description: 'Browser.cash API key for authentication. Required.',
      },
    },
    required: ['scriptId', 'apiKey'],
  },
};

/**
 * Handle get_script tool call
 */
export async function handleGetScript(
  client: ApiClient,
  args: { scriptId: string; apiKey: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await client.getScript(args.scriptId, args.apiKey);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2),
      }],
    };
  }
}

/**
 * Tool definition for run_script
 */
export const runScriptTool = {
  name: 'run_script',
  description: 'Execute a stored automation script. The script will run in a browser session and return output.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scriptId: {
        type: 'string',
        description: 'The script ID to run.',
      },
      apiKey: {
        type: 'string',
        description: 'Browser.cash API key for managed browser sessions. Either this or cdpUrl is required.',
      },
      cdpUrl: {
        type: 'string',
        description: 'Direct Chrome DevTools Protocol WebSocket URL for user-provided browsers. Either this or apiKey is required.',
      },
      browserOptions: {
        type: 'object',
        description: 'Browser session options (only used with apiKey)',
        properties: {
          country: { type: 'string', description: '2-letter ISO country code' },
          adblock: { type: 'boolean', description: 'Enable ad-blocking' },
          captchaSolver: { type: 'boolean', description: 'Enable CAPTCHA solving' },
        },
      },
      waitForCompletion: {
        type: 'boolean',
        description: 'Wait for script execution to complete (default: true). Set to false to get taskId immediately for polling.',
      },
      maxWaitSeconds: {
        type: 'number',
        description: 'Maximum seconds to wait for completion. Default: 120',
      },
    },
    required: ['scriptId'],
  },
};

/**
 * Handle run_script tool call
 */
export async function handleRunScript(
  client: ApiClient,
  args: RunScriptRequest
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    scriptId,
    apiKey,
    cdpUrl,
    browserOptions,
    waitForCompletion = true,
    maxWaitSeconds = 120,
  } = args;

  try {
    // Start the streaming request
    const response = await client.runScript(scriptId, { apiKey, cdpUrl, browserOptions });

    if (waitForCompletion) {
      // Wait for the stream to complete
      const { taskId, data } = await consumeStreamUntilComplete<RunScriptCompleteData>(
        response,
        maxWaitSeconds * 1000
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: data.success,
            taskId,
            exitCode: data.exitCode,
            message: data.success
              ? 'Script executed successfully.'
              : `Script failed with exit code ${data.exitCode}`,
          }, null, 2),
        }],
      };
    } else {
      // Just get the taskId and return immediately
      const taskId = await extractTaskId(response);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'started',
            taskId,
            message: `Script execution started. Use get_task with taskId "${taskId}" to check status and retrieve output.`,
          }, null, 2),
        }],
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: message }, null, 2),
      }],
    };
  }
}
