import type { ApiClient } from '../lib/api-client.js';
import type { AutomateCompleteData, AutomateRequest, TaskRecord } from '../lib/types.js';
import { extractTaskId, consumeStreamUntilComplete, sleep } from '../lib/sse-handler.js';

/**
 * Tool definition for browser_automate
 */
export const browserAutomateTool = {
  name: 'browser_automate',
  description: 'Perform one-off browser automation task. Claude will navigate to websites, interact with elements, and extract data directly. Returns results immediately (no script generated).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: 'Description of the automation task (e.g., "Go to news.ycombinator.com and extract the top 5 story titles")',
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
        description: 'If true, wait for the task to complete and return results. If false, return taskId immediately for polling. Default: false',
      },
      maxWaitSeconds: {
        type: 'number',
        description: 'Maximum seconds to wait for completion (only used if waitForCompletion is true). Default: 120',
      },
    },
    required: ['task'],
  },
};

/**
 * Handle browser_automate tool call
 */
export async function handleBrowserAutomate(
  client: ApiClient,
  args: AutomateRequest
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { task, apiKey, cdpUrl, browserOptions, waitForCompletion = false, maxWaitSeconds = 120 } = args;

  try {
    // Start the streaming request
    const response = await client.startAutomate(task, { apiKey, cdpUrl, browserOptions });

    if (waitForCompletion) {
      // Wait for the stream to complete
      const { taskId, data } = await consumeStreamUntilComplete<AutomateCompleteData>(
        response,
        maxWaitSeconds * 1000
      );

      if (data.success) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              taskId,
              result: data.result,
              summary: data.summary,
            }, null, 2),
          }],
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              taskId,
              error: data.error || 'Task failed',
            }, null, 2),
          }],
        };
      }
    } else {
      // Just get the taskId and return immediately
      const taskId = await extractTaskId(response);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'started',
            taskId,
            message: `Task started. Use get_task with taskId "${taskId}" to check status and retrieve results.`,
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

/**
 * Poll for task completion
 */
export async function pollForCompletion(
  client: ApiClient,
  taskId: string,
  apiKey: string,
  maxWaitMs: number
): Promise<TaskRecord> {
  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < maxWaitMs) {
    const task = await client.getTask(taskId, apiKey);
    if (task.status === 'completed' || task.status === 'error') {
      return task;
    }
    await sleep(pollInterval);
  }

  throw new Error(`Timeout waiting for task ${taskId}`);
}
