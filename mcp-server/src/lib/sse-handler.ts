import type { SSEEvent, StartEventData } from './types.js';

/**
 * Parse SSE line into an event object
 */
function parseSSELine(line: string): SSEEvent | null {
  if (!line.startsWith('data: ')) {
    return null;
  }

  try {
    return JSON.parse(line.slice(6));
  } catch {
    return null;
  }
}

/**
 * Consume SSE stream just to get the taskId from the start event
 * Cancels the stream after getting the taskId
 */
export async function extractTaskId(response: Response): Promise<string> {
  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error('Stream ended without receiving taskId');
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseSSELine(line);
        if (event?.type === 'start') {
          const data = event.data as StartEventData;
          if (data.taskId) {
            // Got what we need, cancel the stream
            await reader.cancel();
            return data.taskId;
          }
        }
        if (event?.type === 'error') {
          const data = event.data as { message?: string };
          throw new Error(data.message || 'Unknown error');
        }
      }
    }
  } catch (error) {
    // Make sure to cancel on error
    await reader.cancel().catch(() => {});
    throw error;
  }
}

/**
 * Consume SSE stream and wait for completion
 * Returns the complete event data
 */
export async function consumeStreamUntilComplete<T>(
  response: Response,
  timeoutMs: number = 120000
): Promise<{ taskId: string; data: T }> {
  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let taskId: string | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const readPromise = (async (): Promise<{ taskId: string; data: T }> => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error('Stream ended without completion event');
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const event = parseSSELine(line);
          if (!event) continue;

          if (event.type === 'start') {
            const data = event.data as StartEventData;
            taskId = data.taskId;
          }

          if (event.type === 'complete') {
            if (!taskId) {
              throw new Error('Received complete without start event');
            }
            return { taskId, data: event.data as T };
          }

          if (event.type === 'error') {
            const data = event.data as { message?: string };
            throw new Error(data.message || 'Unknown error');
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  })();

  return Promise.race([readPromise, timeoutPromise]);
}

/**
 * Helper to sleep for a given duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
