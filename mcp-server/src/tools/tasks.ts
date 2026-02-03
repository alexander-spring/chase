import type { ApiClient } from '../lib/api-client.js';

/**
 * Tool definition for get_task
 */
export const getTaskTool = {
  name: 'get_task',
  description: 'Get the status and result of a task by ID. Use this to poll for completion after starting an async task.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID to retrieve.',
      },
      apiKey: {
        type: 'string',
        description: 'Browser.cash API key for authentication. Required.',
      },
    },
    required: ['taskId', 'apiKey'],
  },
};

/**
 * Handle get_task tool call
 */
export async function handleGetTask(
  client: ApiClient,
  args: { taskId: string; apiKey: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await client.getTask(args.taskId, args.apiKey);
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
 * Tool definition for list_tasks
 */
export const listTasksTool = {
  name: 'list_tasks',
  description: 'List recent tasks. Useful for finding task IDs after disconnection or to see task history.',
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
 * Handle list_tasks tool call
 */
export async function handleListTasks(
  client: ApiClient,
  args: { apiKey: string }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const result = await client.listTasks(args.apiKey);
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
