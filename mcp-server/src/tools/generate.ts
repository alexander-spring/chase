import type { ApiClient } from '../lib/api-client.js';
import type { GenerateCompleteData, GenerateScriptRequest } from '../lib/types.js';
import { extractTaskId, consumeStreamUntilComplete } from '../lib/sse-handler.js';

/**
 * Tool definition for generate_script
 */
export const generateScriptTool = {
  name: 'generate_script',
  description: 'Generate a reusable browser automation script. Claude will create and test a bash script that can be run multiple times. The script is stored and can be executed later via run_script.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task: {
        type: 'string',
        description: 'Description of what the script should do (e.g., "Go to amazon.com and extract laptop prices")',
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
      skipTest: {
        type: 'boolean',
        description: 'Skip iterative testing of the generated script. Default: false',
      },
      waitForCompletion: {
        type: 'boolean',
        description: 'Wait for script generation to complete (default: true). Set to false to get taskId immediately for polling.',
      },
      maxWaitSeconds: {
        type: 'number',
        description: 'Maximum seconds to wait for completion. Default: 300 (scripts take longer)',
      },
    },
    required: ['task'],
  },
};

/**
 * Handle generate_script tool call
 */
export async function handleGenerateScript(
  client: ApiClient,
  args: GenerateScriptRequest
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const {
    task,
    apiKey,
    cdpUrl,
    browserOptions,
    skipTest = false,
    waitForCompletion = true,
    maxWaitSeconds = 300,
  } = args;

  try {
    // Start the streaming request
    const response = await client.startGenerate(task, { apiKey, cdpUrl, browserOptions, skipTest });

    if (waitForCompletion) {
      // Wait for the stream to complete
      const { taskId, data } = await consumeStreamUntilComplete<GenerateCompleteData>(
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
              scriptId: data.scriptId,
              iterations: data.iterations,
              scriptPreview: data.script ? data.script.substring(0, 500) + '...' : undefined,
              message: data.scriptId
                ? `Script generated and saved with ID "${data.scriptId}". Use run_script to execute it.`
                : 'Script generated successfully.',
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
              error: data.skippedDueToStaleCdp
                ? 'CDP connection unavailable - script generated but not tested'
                : 'Script generation failed',
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
            message: `Script generation started. Use get_task with taskId "${taskId}" to check status and retrieve the script.`,
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
