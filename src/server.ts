#!/usr/bin/env node

import 'dotenv/config';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { Storage } from '@google-cloud/storage';
import { loadConfig } from './config.js';
import { runClaudeForScriptGeneration } from './claude-runner.js';
import { runIterativeTest } from './iterative-tester.js';
import { writeScript } from './codegen/bash-generator.js';
import { getSystemPrompt } from './prompts/system-prompt.js';
import { getAgenticPrompt } from './prompts/agentic-prompt.js';
import {
  createAndWaitForSession,
  stopBrowserSession,
  BrowserSessionOptions,
  BrowserSessionManager,
} from './browser-cash.js';

// Google Cloud Storage setup
const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'claude-gen-scripts';

/**
 * Hash an API key to create a user namespace (ownerId).
 * We use a truncated SHA-256 hash to avoid storing the raw key.
 */
function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex').substring(0, 16);
}

interface ScriptMetadata {
  id: string;
  ownerId: string;
  task: string;
  createdAt: string;
  iterations: number;
  success: boolean;
  scriptSize: number;
}

/**
 * Upload a script to GCS and return its metadata
 */
async function uploadScript(
  scriptContent: string,
  task: string,
  iterations: number,
  success: boolean,
  ownerId: string
): Promise<ScriptMetadata> {
  const id = `script-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
  const bucket = storage.bucket(BUCKET_NAME);

  // Upload the script
  const scriptFile = bucket.file(`scripts/${id}.sh`);
  await scriptFile.save(scriptContent, {
    contentType: 'application/x-sh',
    metadata: {
      task,
      ownerId,
      createdAt: new Date().toISOString(),
      iterations: iterations.toString(),
      success: success.toString(),
    },
  });

  // Save metadata separately for easy listing
  const metadata: ScriptMetadata = {
    id,
    ownerId,
    task,
    createdAt: new Date().toISOString(),
    iterations,
    success,
    scriptSize: scriptContent.length,
  };

  const metaFile = bucket.file(`metadata/${id}.json`);
  await metaFile.save(JSON.stringify(metadata, null, 2), {
    contentType: 'application/json',
  });

  return metadata;
}

/**
 * Get a script from GCS, verifying ownership
 * Uses parallel downloads for better performance
 */
async function getScript(id: string, ownerId: string): Promise<{ content: string; metadata: ScriptMetadata } | null> {
  try {
    const bucket = storage.bucket(BUCKET_NAME);

    // Parallel download of metadata and script content
    const [metaResult, scriptResult] = await Promise.all([
      bucket.file(`metadata/${id}.json`).download(),
      bucket.file(`scripts/${id}.sh`).download(),
    ]);

    const metadata: ScriptMetadata = JSON.parse(metaResult[0].toString());

    // Verify ownership
    if (metadata.ownerId !== ownerId) {
      return null;
    }

    return {
      content: scriptResult[0].toString(),
      metadata,
    };
  } catch {
    return null;
  }
}

/**
 * List scripts from GCS filtered by ownerId
 * Uses parallel batch downloads for better performance
 */
async function listScripts(ownerId: string, limit: number = 50): Promise<ScriptMetadata[]> {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    // Get more files than limit to account for filtering
    const [files] = await bucket.getFiles({ prefix: 'metadata/', maxResults: limit * 3 });

    // Download all files in parallel (much faster than sequential)
    const downloadPromises = files.map(async (file) => {
      try {
        const [content] = await file.download();
        return JSON.parse(content.toString()) as ScriptMetadata;
      } catch {
        return null;
      }
    });

    const allMetadata = await Promise.all(downloadPromises);

    // Filter by owner and remove nulls
    const scripts = allMetadata
      .filter((m): m is ScriptMetadata => m !== null && m.ownerId === ownerId)
      .slice(0, limit);

    // Sort by createdAt descending
    scripts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return scripts;
  } catch {
    return [];
  }
}

// ============================================
// Task Storage System
// ============================================

type TaskStatus = 'pending' | 'running' | 'completed' | 'error';
type TaskType = 'generate' | 'automate' | 'run_script';

interface TaskRecord {
  taskId: string;
  ownerId: string;
  type: TaskType;
  status: TaskStatus;
  task: string;
  createdAt: string;
  updatedAt: string;
  browserSessionId?: string;
  /** For generate tasks */
  scriptId?: string;
  script?: string;
  iterations?: number;
  /** For automate tasks */
  result?: unknown;
  summary?: string;
  /** For run_script tasks */
  exitCode?: number;
  output?: string;
  /** Error info */
  error?: string;
}

/**
 * Generate a unique task ID
 */
function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `task-${timestamp}-${random}`;
}

/**
 * Save a task record to GCS (gracefully handles missing credentials for local dev)
 */
async function saveTask(task: TaskRecord): Promise<void> {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(`tasks/${task.taskId}.json`);
    await file.save(JSON.stringify(task, null, 2), {
      contentType: 'application/json',
    });
  } catch (err) {
    // Gracefully handle GCS errors (e.g., missing credentials in local dev)
    // Task will still work, just won't be persisted for later retrieval
    console.warn(`[saveTask] Could not persist task ${task.taskId} to GCS:`, (err as Error).message);
  }
}

/**
 * Get a task record from GCS, verifying ownership
 */
async function getTask(taskId: string, ownerId: string): Promise<TaskRecord | null> {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const [content] = await bucket.file(`tasks/${taskId}.json`).download();
    const task: TaskRecord = JSON.parse(content.toString());

    // Verify ownership
    if (task.ownerId !== ownerId) {
      return null;
    }

    return task;
  } catch {
    return null;
  }
}

/**
 * List recent tasks from GCS filtered by ownerId
 * Uses parallel batch downloads for better performance
 */
async function listTasks(ownerId: string, limit: number = 50): Promise<TaskRecord[]> {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    // Get more files than limit to account for filtering
    const [files] = await bucket.getFiles({ prefix: 'tasks/', maxResults: limit * 3 });

    // Download all files in parallel (much faster than sequential)
    const downloadPromises = files.map(async (file) => {
      try {
        const [content] = await file.download();
        return JSON.parse(content.toString()) as TaskRecord;
      } catch {
        return null;
      }
    });

    const allTasks = await Promise.all(downloadPromises);

    // Filter by owner and remove nulls
    const tasks = allTasks
      .filter((t): t is TaskRecord => t !== null && t.ownerId === ownerId)
      .slice(0, limit);

    // Sort by createdAt descending
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return tasks;
  } catch {
    return [];
  }
}

// Browser.cash session options for API requests
interface BrowserOptions {
  /** 2-letter country code (e.g., "US") */
  country?: string;
  /** Node type */
  type?: 'consumer_distributed' | 'hosted' | 'testing';
  /** SOCKS5 proxy URL */
  proxyUrl?: string;
  /** Window size (e.g., "1920x1080") */
  windowSize?: string;
  /** Enable ad-blocking */
  adblock?: boolean;
  /** Enable CAPTCHA solver */
  captchaSolver?: boolean;
}

// Request/Response types
interface GenerateRequestBody {
  task: string;
  /** Browser.cash API key - for managed browser sessions (recommended) */
  browserCashApiKey?: string;
  /** Direct CDP URL - for user-provided browsers (local dev or custom setups) */
  cdpUrl?: string;
  /** Browser session options when using browserCashApiKey */
  browserOptions?: BrowserOptions;
  skipTest?: boolean;
  /** Max fix iterations (default: 5) */
  maxIterations?: number;
  /** Max Claude turns per fix attempt (default: 15, capped at 15) */
  maxTurns?: number;
}

interface GenerateResponse {
  success: boolean;
  script?: string;
  iterations?: number;
  scriptPath?: string;
  scriptId?: string;
  error?: string;
  skippedDueToStaleCdp?: boolean;
  /** Browser.cash session ID if a session was created */
  browserSessionId?: string;
}

interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  version: string;
}

// SSE Event types
type SSEEventType =
  | 'start'
  | 'log'
  | 'claude_output'
  | 'script_extracted'
  | 'iteration_start'
  | 'iteration_result'
  | 'complete'
  | 'error'
  | 'output'
  | 'script_saved';

interface SSEEvent {
  type: SSEEventType;
  data: unknown;
  timestamp: string;
}

// Create Fastify instance
const server = Fastify({
  logger: true,
});

// Health check endpoint
server.get('/health', async (_request: FastifyRequest, _reply: FastifyReply): Promise<HealthResponse> => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };
});

// ============================================
// Task Status Endpoints
// ============================================

// Get a specific task's status and result
server.get<{ Params: { taskId: string }; Querystring: { apiKey?: string } }>('/tasks/:taskId', async (request, reply) => {
  const { taskId } = request.params;
  const apiKey = (request.headers['x-api-key'] as string) || request.query.apiKey;

  if (!apiKey) {
    reply.code(401);
    return { error: 'API key required (x-api-key header or apiKey query param)' };
  }

  const ownerId = hashApiKey(apiKey);

  try {
    const task = await getTask(taskId, ownerId);
    if (!task) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    return task;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    reply.code(500);
    return { error: message };
  }
});

// List recent tasks
server.get<{ Querystring: { apiKey?: string } }>('/tasks', async (request, reply) => {
  const apiKey = (request.headers['x-api-key'] as string) || request.query.apiKey;

  if (!apiKey) {
    reply.code(401);
    return { error: 'API key required (x-api-key header or apiKey query param)' };
  }

  const ownerId = hashApiKey(apiKey);

  try {
    const tasks = await listTasks(ownerId);
    return { tasks };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    reply.code(500);
    return { error: message };
  }
});

// CDP connectivity test endpoint
interface TestCdpBody {
  cdpUrl: string;
  testNavigation?: boolean; // Also test if browser can navigate to URLs
  testUrl?: string; // URL to test navigation (default: https://example.com)
}

interface TestCdpResponse {
  success: boolean;
  connected: boolean;
  pageTitle?: string;
  currentUrl?: string;
  error?: string;
  diagnostics?: {
    cdpConnected: boolean;
    browserResponsive: boolean;
    canNavigate: boolean;
    navigationUrl?: string;
    navigationError?: string;
    dnsWorking: boolean;
    browserInfo?: {
      userAgent?: string;
      currentUrl?: string;
      currentTitle?: string;
    };
  };
  timing?: {
    connectionMs: number;
    commandMs: number;
    navigationMs?: number;
    totalMs: number;
  };
}

/**
 * Run a single agent-browser command and return stdout/stderr
 */
function runAgentBrowserCommand(
  cdpUrl: string,
  command: string,
  args: string,
  timeoutMs: number = 30000
): Promise<{ success: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const cmd = `agent-browser --cdp "${cdpUrl}" ${command} ${args}`;

    const proc = spawn('bash', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      resolve({ success: false, stdout, stderr: 'Timeout', code: null });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ success: code === 0, stdout, stderr, code });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, stdout, stderr: err.message, code: null });
    });
  });
}

server.post<{ Body: TestCdpBody }>(
  '/test-cdp',
  {
    schema: {
      body: {
        type: 'object',
        required: ['cdpUrl'],
        properties: {
          cdpUrl: { type: 'string', minLength: 1 },
          testNavigation: { type: 'boolean', default: true },
          testUrl: { type: 'string', default: 'https://example.com' },
        },
      },
    },
  },
  async (request, reply): Promise<TestCdpResponse> => {
    const { cdpUrl, testNavigation = true, testUrl = 'https://example.com' } = request.body;
    const startTime = Date.now();

    request.log.info({ cdpUrl: cdpUrl.substring(0, 50) + '...' }, 'Testing CDP connectivity');

    const diagnostics: TestCdpResponse['diagnostics'] = {
      cdpConnected: false,
      browserResponsive: false,
      canNavigate: false,
      dnsWorking: false,
    };

    const timing: TestCdpResponse['timing'] = {
      connectionMs: 0,
      commandMs: 0,
      totalMs: 0,
    };

    // Test 1: Basic CDP connectivity - get current page info
    const connectStart = Date.now();
    const infoResult = await runAgentBrowserCommand(
      cdpUrl,
      'eval',
      '"JSON.stringify({title: document.title, url: location.href, userAgent: navigator.userAgent})"',
      15000
    );
    timing.connectionMs = Date.now() - connectStart;

    if (infoResult.success && infoResult.stdout) {
      diagnostics.cdpConnected = true;
      diagnostics.browserResponsive = true;

      try {
        let parsed = infoResult.stdout.trim();
        if (parsed.startsWith('"') && parsed.endsWith('"')) {
          parsed = JSON.parse(parsed);
        }
        const browserInfo = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
        diagnostics.browserInfo = {
          userAgent: browserInfo.userAgent,
          currentUrl: browserInfo.url,
          currentTitle: browserInfo.title,
        };

        // Check if current URL indicates an error page
        if (browserInfo.url?.includes('chrome-error://')) {
          diagnostics.dnsWorking = false;
          diagnostics.canNavigate = false;
        }
      } catch {
        diagnostics.browserInfo = { currentTitle: infoResult.stdout.trim() };
      }
    } else {
      return {
        success: false,
        connected: false,
        error: infoResult.stderr || `Failed to connect: exit code ${infoResult.code}`,
        diagnostics,
        timing: { ...timing, totalMs: Date.now() - startTime },
      };
    }

    // Test 2: Navigation test (if requested)
    if (testNavigation) {
      const navStart = Date.now();

      // First, navigate to the test URL
      const navResult = await runAgentBrowserCommand(
        cdpUrl,
        'open',
        `"${testUrl}"`,
        20000
      );

      if (navResult.success) {
        // Wait a moment for the page to load
        await new Promise(r => setTimeout(r, 2000));

        // Check what URL we ended up at
        const checkResult = await runAgentBrowserCommand(
          cdpUrl,
          'eval',
          `"JSON.stringify({url: location.href, title: document.title, body: document.body?.innerText?.substring(0, 200) || ''})"`,
          10000
        );

        timing.navigationMs = Date.now() - navStart;

        if (checkResult.success && checkResult.stdout) {
          try {
            let parsed = checkResult.stdout.trim();
            if (parsed.startsWith('"') && parsed.endsWith('"')) {
              parsed = JSON.parse(parsed);
            }
            const navInfo = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;

            diagnostics.navigationUrl = navInfo.url;

            // Check for common error patterns
            const url = navInfo.url || '';
            const body = navInfo.body || '';

            if (url.includes('chrome-error://') || body.includes('ERR_NAME_NOT_RESOLVED')) {
              diagnostics.canNavigate = false;
              diagnostics.dnsWorking = false;
              diagnostics.navigationError = 'DNS resolution failed (ERR_NAME_NOT_RESOLVED) - browser cannot resolve domain names';
            } else if (body.includes('ERR_CONNECTION_REFUSED')) {
              diagnostics.canNavigate = false;
              diagnostics.dnsWorking = true;
              diagnostics.navigationError = 'Connection refused - target server not reachable';
            } else if (body.includes('ERR_CONNECTION_TIMED_OUT')) {
              diagnostics.canNavigate = false;
              diagnostics.dnsWorking = true;
              diagnostics.navigationError = 'Connection timed out - network issues';
            } else if (body.includes('ERR_')) {
              diagnostics.canNavigate = false;
              const errMatch = body.match(/ERR_[A-Z_]+/);
              diagnostics.navigationError = errMatch ? errMatch[0] : 'Unknown navigation error';
            } else if (url.startsWith('http') && !url.includes('chrome-error')) {
              diagnostics.canNavigate = true;
              diagnostics.dnsWorking = true;
            }
          } catch {
            diagnostics.navigationError = 'Failed to parse navigation result';
          }
        } else {
          diagnostics.navigationError = checkResult.stderr || 'Navigation check failed';
        }
      } else {
        timing.navigationMs = Date.now() - navStart;
        diagnostics.navigationError = navResult.stderr || 'Navigation command failed';
      }
    }

    timing.commandMs = Date.now() - startTime - timing.connectionMs;
    timing.totalMs = Date.now() - startTime;

    // Overall success check
    const overallSuccess = diagnostics.cdpConnected &&
      (!testNavigation || diagnostics.canNavigate);

    return {
      success: overallSuccess,
      connected: diagnostics.cdpConnected,
      pageTitle: diagnostics.browserInfo?.currentTitle,
      currentUrl: diagnostics.browserInfo?.currentUrl,
      error: overallSuccess ? undefined : (diagnostics.navigationError || 'CDP test failed'),
      diagnostics,
      timing,
    };
  }
);

// Generate script endpoint (non-streaming)
server.post<{ Body: GenerateRequestBody }>(
  '/generate',
  {
    schema: {
      body: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', minLength: 1 },
          browserCashApiKey: { type: 'string', minLength: 1 },
          cdpUrl: { type: 'string', minLength: 1 },
          browserOptions: {
            type: 'object',
            properties: {
              country: { type: 'string', minLength: 2, maxLength: 2 },
              type: { type: 'string', enum: ['consumer_distributed', 'hosted', 'testing'] },
              proxyUrl: { type: 'string' },
              windowSize: { type: 'string' },
              adblock: { type: 'boolean' },
              captchaSolver: { type: 'boolean' },
            },
          },
          skipTest: { type: 'boolean', default: false },
        },
      },
    },
  },
  async (request, reply): Promise<GenerateResponse> => {
    const { task, browserCashApiKey, cdpUrl, browserOptions, skipTest } = request.body;
    let browserSession: { sessionId: string; cdpUrl: string } | null = null;
    let effectiveCdpUrl: string | undefined;

    // Validate that either browserCashApiKey or cdpUrl is provided
    if (!browserCashApiKey && !cdpUrl) {
      reply.code(400);
      return {
        success: false,
        error: 'Either browserCashApiKey or cdpUrl is required',
      };
    }

    try {
      if (cdpUrl) {
        // Use direct CDP URL
        effectiveCdpUrl = cdpUrl;
      } else if (browserCashApiKey) {
        // Create browser session via Browser.cash
        const sessionResult = await createAndWaitForSession(browserCashApiKey, browserOptions || {});
        browserSession = { sessionId: sessionResult.session.sessionId, cdpUrl: sessionResult.cdpUrl };
        effectiveCdpUrl = sessionResult.cdpUrl;
      }

      // Load configuration with effective CDP URL
      const config = loadConfig({
        cdpUrl: effectiveCdpUrl!,
        taskDescription: task,
      });

      request.log.info({ task, skipTest }, 'Starting script generation');

      // Generate script using Claude
      const result = await runClaudeForScriptGeneration(task, config);

      if (!result.success || !result.script) {
        request.log.error({ error: result.error }, 'Failed to generate script');

        // Clean up browser session on error (only if we created one)
        if (browserSession && browserCashApiKey) {
          await stopBrowserSession(browserCashApiKey, browserSession.sessionId).catch(() => {});
        }

        reply.code(400);
        return {
          success: false,
          error: result.error || 'Failed to generate script - no valid script in Claude output',
        };
      }

      request.log.info('Script generated successfully');

      // Optionally run iterative testing
      if (!skipTest) {
        request.log.info('Starting iterative testing');
        const testResult = await runIterativeTest(result.script, task, config);

        if (testResult.skippedDueToStaleCdp) {
          request.log.warn('Testing skipped due to stale CDP connection');

          // Clean up browser session (only if we created one)
          if (browserSession && browserCashApiKey) {
            await stopBrowserSession(browserCashApiKey, browserSession.sessionId).catch(() => {});
          }

          return {
            success: false,
            script: testResult.scriptContent,
            iterations: testResult.iterations,
            scriptPath: testResult.finalScriptPath,
            skippedDueToStaleCdp: true,
            error: 'CDP connection unavailable - script generated but not tested',
            browserSessionId: browserSession?.sessionId,
          };
        }

        // Clean up browser session (only if we created one)
        if (browserSession && browserCashApiKey) {
          await stopBrowserSession(browserCashApiKey, browserSession.sessionId).catch(() => {});
        }

        return {
          success: testResult.success,
          script: testResult.scriptContent,
          iterations: testResult.iterations,
          scriptPath: testResult.finalScriptPath,
          error: testResult.success ? undefined : testResult.lastError,
          browserSessionId: browserSession?.sessionId,
        };
      }

      // Skip testing - just write and return the script
      const scriptPath = writeScript(result.script, {
        cdpUrl: config.cdpUrl,
        outputDir: config.outputDir,
      });

      // Clean up browser session (only if we created one)
      if (browserSession && browserCashApiKey) {
        await stopBrowserSession(browserCashApiKey, browserSession.sessionId).catch(() => {});
      }

      return {
        success: true,
        script: result.script,
        scriptPath,
        browserSessionId: browserSession?.sessionId,
      };
    } catch (error) {
      // Clean up browser session on error (only if we created one)
      if (browserSession && browserCashApiKey) {
        await stopBrowserSession(browserCashApiKey, browserSession.sessionId).catch(() => {});
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      request.log.error({ error: message }, 'Request failed');
      reply.code(500);
      return {
        success: false,
        error: message,
      };
    }
  }
);

// SSE Streaming endpoint for real-time logs
server.post<{ Body: GenerateRequestBody }>(
  '/generate/stream',
  {
    schema: {
      body: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', minLength: 1 },
          browserCashApiKey: { type: 'string', minLength: 1 },
          cdpUrl: { type: 'string', minLength: 1 },
          browserOptions: {
            type: 'object',
            properties: {
              country: { type: 'string', minLength: 2, maxLength: 2 },
              type: { type: 'string', enum: ['consumer_distributed', 'hosted', 'testing'] },
              proxyUrl: { type: 'string' },
              windowSize: { type: 'string' },
              adblock: { type: 'boolean' },
              captchaSolver: { type: 'boolean' },
            },
          },
          skipTest: { type: 'boolean', default: false },
          maxIterations: { type: 'integer', minimum: 1, maximum: 20 },
          maxTurns: { type: 'integer', minimum: 1, maximum: 30 },
        },
      },
    },
  },
  async (request, reply) => {
    const { task, browserCashApiKey, cdpUrl, browserOptions, skipTest, maxIterations, maxTurns } = request.body;

    // Validate that either browserCashApiKey or cdpUrl is provided
    if (!browserCashApiKey && !cdpUrl) {
      reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'Either browserCashApiKey or cdpUrl is required' }));
      return;
    }

    // Hash API key to create owner ID (use a placeholder for direct CDP URL users)
    const ownerId = browserCashApiKey ? hashApiKey(browserCashApiKey) : hashApiKey(cdpUrl!);

    // Create task record for persistent storage
    const taskId = generateTaskId();
    const taskRecord: TaskRecord = {
      taskId,
      ownerId,
      type: 'generate',
      status: 'pending',
      task,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (type: SSEEventType, data: unknown) => {
      const event: SSEEvent = {
        type,
        data,
        timestamp: new Date().toISOString(),
      };
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client may have disconnected, ignore write errors
      }
    };

    // Browser session manager for cleanup
    let browserSession: { sessionId: string; cdpUrl: string } | null = null;
    let effectiveCdpUrl: string | undefined;

    // Send immediate acknowledgment (don't block on GCS)
    sendEvent('log', { message: 'Task received, initializing...', level: 'info' });

    try {
      // Save initial task record (non-blocking - don't await)
      saveTask(taskRecord).catch(() => {});

      // Set up browser - either direct CDP URL or create Browser.cash session
      if (cdpUrl) {
        // Use direct CDP URL
        effectiveCdpUrl = cdpUrl;
        sendEvent('log', { message: 'Using direct CDP URL', level: 'info' });
      } else if (browserCashApiKey) {
        // Create browser session via Browser.cash
        sendEvent('log', { message: 'Creating Browser.cash session...', level: 'info' });

        try {
          const result = await createAndWaitForSession(browserCashApiKey, browserOptions || {});
          effectiveCdpUrl = result.cdpUrl;
          browserSession = { sessionId: result.session.sessionId, cdpUrl: result.cdpUrl };
          taskRecord.browserSessionId = result.session.sessionId;

          sendEvent('log', {
            message: `Browser session created: ${result.session.sessionId}`,
            level: 'info',
            browserSessionId: result.session.sessionId,
          });

          // Log viewer URL for debugging (raw CDP URL for manual construction)
          sendEvent('log', {
            message: `CDP URL: ${result.cdpUrl}`,
            level: 'info',
          });
          sendEvent('log', {
            message: `Viewer: https://dash.browser.cash/cdp_tabs?ws=${result.cdpUrl}&theme=light`,
            level: 'info',
          });
        } catch (err) {
          const errorMsg = `Failed to create browser session: ${err instanceof Error ? err.message : 'Unknown error'}`;
          taskRecord.status = 'error';
          taskRecord.error = errorMsg;
          taskRecord.updatedAt = new Date().toISOString();
          saveTask(taskRecord).catch(() => {}); // Non-blocking

          sendEvent('error', { message: errorMsg, phase: 'browser_setup', taskId });
          reply.raw.end();
          return;
        }
      }

      // Update task to running (non-blocking)
      taskRecord.status = 'running';
      taskRecord.updatedAt = new Date().toISOString();
      saveTask(taskRecord).catch(() => {});

      // Load configuration
      const config = loadConfig({
        cdpUrl: effectiveCdpUrl!,
        taskDescription: task,
      });

      // Override settings if provided in request
      if (maxIterations) {
        config.maxFixIterations = maxIterations;
      }
      if (maxTurns) {
        config.maxTurns = Math.min(maxTurns, 30); // Cap at 30 for safety
      }

      sendEvent('start', {
        taskId,
        task,
        model: config.model,
        skipTest,
        maxIterations: config.maxFixIterations,
        maxTurns: config.maxTurns,
        browserSessionId: browserSession?.sessionId,
      });

      // Run streaming script generation
      const result = await runClaudeStreamingGeneration(task, config, sendEvent);

      if (!result.success || !result.script) {
        const errorMsg = result.error || 'Failed to generate script';
        taskRecord.status = 'error';
        taskRecord.error = errorMsg;
        taskRecord.updatedAt = new Date().toISOString();
        await saveTask(taskRecord);

        sendEvent('error', { message: errorMsg, phase: 'generation', taskId });
        reply.raw.end();
        return;
      }

      sendEvent('script_extracted', {
        scriptPreview: result.script.substring(0, 500) + '...',
        scriptLength: result.script.length
      });

      // Run iterative testing if not skipped
      if (!skipTest) {
        const testResult = await runStreamingIterativeTest(
          result.script,
          task,
          config,
          sendEvent
        );

        // Save to GCS if successful
        let savedScript: ScriptMetadata | null = null;
        if (testResult.success) {
          try {
            savedScript = await uploadScript(
              testResult.scriptContent,
              task,
              testResult.iterations,
              testResult.success,
              ownerId
            );
            sendEvent('script_saved', { scriptId: savedScript.id, metadata: savedScript });
          } catch (err) {
            sendEvent('log', {
              message: `Failed to save script to storage: ${err instanceof Error ? err.message : 'Unknown error'}`,
              level: 'warn'
            });
          }
        }

        // Update task record with final result
        taskRecord.status = testResult.success ? 'completed' : 'error';
        taskRecord.script = testResult.scriptContent;
        taskRecord.iterations = testResult.iterations;
        taskRecord.scriptId = savedScript?.id;
        taskRecord.updatedAt = new Date().toISOString();
        if (!testResult.success) {
          taskRecord.error = 'Script testing failed';
        }
        await saveTask(taskRecord);

        sendEvent('complete', {
          taskId,
          success: testResult.success,
          script: testResult.scriptContent,
          iterations: testResult.iterations,
          skippedDueToStaleCdp: testResult.skippedDueToStaleCdp,
          scriptId: savedScript?.id,
          browserSessionId: browserSession?.sessionId,
        });
      } else {
        // Skip testing - just return the script
        const scriptPath = writeScript(result.script, {
          cdpUrl: config.cdpUrl,
          outputDir: config.outputDir,
        });

        // Save to GCS
        let savedScript: ScriptMetadata | null = null;
        try {
          savedScript = await uploadScript(result.script, task, 0, true, ownerId);
          sendEvent('script_saved', { scriptId: savedScript.id, metadata: savedScript });
        } catch (err) {
          sendEvent('log', {
            message: `Failed to save script to storage: ${err instanceof Error ? err.message : 'Unknown error'}`,
            level: 'warn'
          });
        }

        // Update task record with final result
        taskRecord.status = 'completed';
        taskRecord.script = result.script;
        taskRecord.iterations = 0;
        taskRecord.scriptId = savedScript?.id;
        taskRecord.updatedAt = new Date().toISOString();
        await saveTask(taskRecord);

        sendEvent('complete', {
          taskId,
          success: true,
          script: result.script,
          scriptPath,
          scriptId: savedScript?.id,
          browserSessionId: browserSession?.sessionId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      taskRecord.status = 'error';
      taskRecord.error = message;
      taskRecord.updatedAt = new Date().toISOString();
      await saveTask(taskRecord);

      sendEvent('error', { message, phase: 'unknown', taskId });
    } finally {
      // Clean up browser session (only if we created one)
      if (browserSession && browserCashApiKey) {
        try {
          await stopBrowserSession(browserCashApiKey, browserSession.sessionId);
          sendEvent('log', { message: 'Browser session stopped', level: 'info' });
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    reply.raw.end();
  }
);

// ============================================
// Agentic Mode Endpoint
// ============================================

// Request body for agentic automation
interface AutomateRequestBody {
  task: string;
  /** Browser.cash API key - for managed browser sessions (recommended) */
  browserCashApiKey?: string;
  /** Direct CDP URL - for user-provided browsers (local dev or custom setups) */
  cdpUrl?: string;
  /** Browser session options when using browserCashApiKey */
  browserOptions?: BrowserOptions;
  /** Max turns for Claude (default: 30, use 50+ for complex tasks) */
  maxTurns?: number;
  /** Claude model to use (default: claude-opus-4-5-20251101) */
  model?: string;
}

// SSE Streaming endpoint for agentic automation (direct execution, no script generation)
server.post<{ Body: AutomateRequestBody }>(
  '/automate/stream',
  {
    schema: {
      body: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', minLength: 1 },
          browserCashApiKey: { type: 'string', minLength: 1 },
          cdpUrl: { type: 'string', minLength: 1 },
          browserOptions: {
            type: 'object',
            properties: {
              country: { type: 'string', minLength: 2, maxLength: 2 },
              type: { type: 'string', enum: ['consumer_distributed', 'hosted', 'testing'] },
              proxyUrl: { type: 'string' },
              windowSize: { type: 'string' },
              adblock: { type: 'boolean' },
              captchaSolver: { type: 'boolean' },
            },
          },
          maxTurns: { type: 'integer', minimum: 1, maximum: 100 },
          model: { type: 'string' },
        },
      },
    },
  },
  async (request, reply) => {
    const { task, browserCashApiKey, cdpUrl, browserOptions, maxTurns, model } = request.body;

    // Validate that either browserCashApiKey or cdpUrl is provided
    if (!browserCashApiKey && !cdpUrl) {
      reply.raw.writeHead(400, { 'Content-Type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'Either browserCashApiKey or cdpUrl is required' }));
      return;
    }

    // Hash API key to create owner ID (use a placeholder for direct CDP URL users)
    const ownerId = browserCashApiKey ? hashApiKey(browserCashApiKey) : hashApiKey(cdpUrl!);

    // Create task record for persistent storage
    const taskId = generateTaskId();
    const taskRecord: TaskRecord = {
      taskId,
      ownerId,
      type: 'automate',
      status: 'pending',
      task,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (type: SSEEventType, data: unknown) => {
      const event: SSEEvent = {
        type,
        data,
        timestamp: new Date().toISOString(),
      };
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client may have disconnected, ignore write errors
      }
    };

    // Browser session manager for cleanup
    let browserSession: { sessionId: string; cdpUrl: string } | null = null;
    let effectiveCdpUrl: string | undefined;

    // Send immediate acknowledgment (don't block on GCS)
    sendEvent('log', { message: 'Task received, initializing...', level: 'info' });

    try {
      // Save initial task record (non-blocking - don't await)
      saveTask(taskRecord).catch(() => {});

      // Set up browser - either direct CDP URL or create Browser.cash session
      if (cdpUrl) {
        // Use direct CDP URL
        effectiveCdpUrl = cdpUrl;
        sendEvent('log', { message: 'Using direct CDP URL', level: 'info' });
      } else if (browserCashApiKey) {
        // Create browser session via Browser.cash
        sendEvent('log', { message: 'Creating Browser.cash session...', level: 'info' });

        try {
          const result = await createAndWaitForSession(browserCashApiKey, browserOptions || {});
          effectiveCdpUrl = result.cdpUrl;
          browserSession = { sessionId: result.session.sessionId, cdpUrl: result.cdpUrl };
          taskRecord.browserSessionId = result.session.sessionId;

          sendEvent('log', {
            message: `Browser session created: ${result.session.sessionId}`,
            level: 'info',
            browserSessionId: result.session.sessionId,
          });

          // Log viewer URL for debugging (raw CDP URL for manual construction)
          sendEvent('log', {
            message: `CDP URL: ${result.cdpUrl}`,
            level: 'info',
          });
          sendEvent('log', {
            message: `Viewer: https://dash.browser.cash/cdp_tabs?ws=${result.cdpUrl}&theme=light`,
            level: 'info',
          });
        } catch (err) {
          const errorMsg = `Failed to create browser session: ${err instanceof Error ? err.message : 'Unknown error'}`;
          taskRecord.status = 'error';
          taskRecord.error = errorMsg;
          taskRecord.updatedAt = new Date().toISOString();
          saveTask(taskRecord).catch(() => {}); // Non-blocking

          sendEvent('error', { message: errorMsg, phase: 'browser_setup', taskId });
          reply.raw.end();
          return;
        }
      }

      // Update task to running (non-blocking)
      taskRecord.status = 'running';
      taskRecord.updatedAt = new Date().toISOString();
      saveTask(taskRecord).catch(() => {});

      // Load configuration
      const config = loadConfig({
        cdpUrl: effectiveCdpUrl!,
        taskDescription: task,
      });

      // Override maxTurns if provided in request
      if (maxTurns) {
        config.maxTurns = maxTurns;
      }

      // Override model if provided in request
      if (model) {
        config.model = model;
      }

      sendEvent('start', {
        taskId,
        task,
        mode: 'agentic',
        model: config.model,
        browserSessionId: browserSession?.sessionId,
      });

      // Run agentic automation
      const result = await runAgenticAutomation(task, config, sendEvent);

      // Update task record with final result
      taskRecord.status = result.success ? 'completed' : 'error';
      taskRecord.result = result.result;
      taskRecord.summary = result.summary;
      taskRecord.error = result.error;
      taskRecord.updatedAt = new Date().toISOString();
      await saveTask(taskRecord);

      sendEvent('complete', {
        taskId,
        success: result.success,
        result: result.result,
        summary: result.summary,
        error: result.error,
        browserSessionId: browserSession?.sessionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      taskRecord.status = 'error';
      taskRecord.error = message;
      taskRecord.updatedAt = new Date().toISOString();
      await saveTask(taskRecord);

      sendEvent('error', { message, phase: 'unknown', taskId });
    } finally {
      // Clean up browser session (only if we created one)
      if (browserSession && browserCashApiKey) {
        try {
          await stopBrowserSession(browserCashApiKey, browserSession.sessionId);
          sendEvent('log', { message: 'Browser session stopped', level: 'info' });
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    reply.raw.end();
  }
);

// ============================================
// Script Storage & Execution Endpoints
// ============================================

// List all stored scripts
server.get<{ Querystring: { apiKey?: string } }>('/scripts', async (request, reply) => {
  const apiKey = (request.headers['x-api-key'] as string) || request.query.apiKey;

  if (!apiKey) {
    reply.code(401);
    return { error: 'API key required (x-api-key header or apiKey query param)' };
  }

  const ownerId = hashApiKey(apiKey);

  try {
    const scripts = await listScripts(ownerId);
    return { scripts };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    reply.code(500);
    return { error: message };
  }
});

// Get a specific script
server.get<{ Params: { id: string }; Querystring: { apiKey?: string } }>('/scripts/:id', async (request, reply) => {
  const { id } = request.params;
  const apiKey = (request.headers['x-api-key'] as string) || request.query.apiKey;

  if (!apiKey) {
    reply.code(401);
    return { error: 'API key required (x-api-key header or apiKey query param)' };
  }

  const ownerId = hashApiKey(apiKey);

  try {
    const result = await getScript(id, ownerId);
    if (!result) {
      reply.code(404);
      return { error: 'Script not found' };
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    reply.code(500);
    return { error: message };
  }
});

// Run a stored script with SSE streaming
interface RunScriptBody {
  /** Browser.cash API key - for managed browser sessions (recommended) */
  browserCashApiKey?: string;
  /** Direct CDP URL - for user-provided browsers (local dev or custom setups) */
  cdpUrl?: string;
  /** Browser session options when using browserCashApiKey */
  browserOptions?: BrowserOptions;
}

server.post<{ Params: { id: string }; Body: RunScriptBody }>(
  '/scripts/:id/run',
  {
    schema: {
      body: {
        type: 'object',
        properties: {
          browserCashApiKey: { type: 'string', minLength: 1 },
          cdpUrl: { type: 'string', minLength: 1 },
          browserOptions: {
            type: 'object',
            properties: {
              country: { type: 'string', minLength: 2, maxLength: 2 },
              type: { type: 'string', enum: ['consumer_distributed', 'hosted', 'testing'] },
              proxyUrl: { type: 'string' },
              windowSize: { type: 'string' },
              adblock: { type: 'boolean' },
              captchaSolver: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const { id } = request.params;
    const { browserCashApiKey, cdpUrl, browserOptions } = request.body;

    // Validate that either browserCashApiKey or cdpUrl is provided
    if (!browserCashApiKey && !cdpUrl) {
      reply.code(400);
      return { error: 'Either browserCashApiKey or cdpUrl is required' };
    }

    // Hash API key to create owner ID (use a placeholder for direct CDP URL users)
    const ownerId = browserCashApiKey ? hashApiKey(browserCashApiKey) : hashApiKey(cdpUrl!);

    // Get the script (verifies ownership)
    const script = await getScript(id, ownerId);
    if (!script) {
      reply.code(404);
      return { error: 'Script not found' };
    }

    // Create task record for persistent storage
    const taskId = generateTaskId();
    const taskRecord: TaskRecord = {
      taskId,
      ownerId,
      type: 'run_script',
      status: 'pending',
      task: script.metadata.task,
      scriptId: id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (type: SSEEventType, data: unknown) => {
      const event: SSEEvent = {
        type,
        data,
        timestamp: new Date().toISOString(),
      };
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client may have disconnected, ignore write errors
      }
    };

    // Browser session manager for cleanup
    let browserSession: { sessionId: string; cdpUrl: string } | null = null;
    let effectiveCdpUrl: string | undefined;

    // Collect output for task record
    let collectedOutput = '';

    // Save initial task record
    await saveTask(taskRecord);

    // Set up browser - either direct CDP URL or create Browser.cash session
    if (cdpUrl) {
      // Use direct CDP URL
      effectiveCdpUrl = cdpUrl;
      sendEvent('log', { message: 'Using direct CDP URL', level: 'info' });
    } else if (browserCashApiKey) {
      // Create browser session via Browser.cash
      sendEvent('log', { message: 'Creating Browser.cash session...', level: 'info' });

      try {
        const result = await createAndWaitForSession(browserCashApiKey, browserOptions || {});
      effectiveCdpUrl = result.cdpUrl;
      browserSession = { sessionId: result.session.sessionId, cdpUrl: result.cdpUrl };
      taskRecord.browserSessionId = result.session.sessionId;

        sendEvent('log', {
          message: `Browser session created: ${result.session.sessionId}`,
          level: 'info',
          browserSessionId: result.session.sessionId,
        });
      } catch (err) {
        const errorMsg = `Failed to create browser session: ${err instanceof Error ? err.message : 'Unknown error'}`;
        taskRecord.status = 'error';
        taskRecord.error = errorMsg;
        taskRecord.updatedAt = new Date().toISOString();
        await saveTask(taskRecord);

        sendEvent('error', { message: errorMsg, phase: 'browser_setup', taskId });
        reply.raw.end();
        return;
      }
    }

    // Update task to running
    taskRecord.status = 'running';
    taskRecord.updatedAt = new Date().toISOString();
    await saveTask(taskRecord);

    sendEvent('start', {
      taskId,
      scriptId: id,
      task: script.metadata.task,
      scriptSize: script.metadata.scriptSize,
      browserSessionId: browserSession?.sessionId,
    });

    // Write script to temp file
    const tempScript = `/tmp/run-${id}-${Date.now()}.sh`;
    await fsPromises.writeFile(tempScript, script.content);
    await fsPromises.chmod(tempScript, '755');

    try {
      // Execute the script with CDP_URL set
      const proc = spawn('bash', [tempScript], {
        env: {
          ...process.env,
          CDP_URL: effectiveCdpUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout?.on('data', (data) => {
        const text = data.toString();
        collectedOutput += text;
        sendEvent('output', { stream: 'stdout', text });
      });

      proc.stderr?.on('data', (data) => {
        const text = data.toString();
        collectedOutput += `[stderr] ${text}`;
        sendEvent('output', { stream: 'stderr', text });
      });

      proc.on('close', async (code) => {
        // Clean up temp file (fire-and-forget)
        fsPromises.unlink(tempScript).catch(() => {});

        // Clean up browser session (only if we created one)
        if (browserSession && browserCashApiKey) {
          try {
            await stopBrowserSession(browserCashApiKey, browserSession.sessionId);
            sendEvent('log', { message: 'Browser session stopped', level: 'info' });
          } catch {
            // Ignore cleanup errors
          }
        }

        // Update task record with final result
        taskRecord.status = code === 0 ? 'completed' : 'error';
        taskRecord.exitCode = code ?? undefined;
        taskRecord.output = collectedOutput;
        taskRecord.updatedAt = new Date().toISOString();
        if (code !== 0) {
          taskRecord.error = `Script exited with code ${code}`;
        }
        await saveTask(taskRecord);

        sendEvent('complete', {
          taskId,
          exitCode: code,
          success: code === 0,
          browserSessionId: browserSession?.sessionId,
        });
        reply.raw.end();
      });

      proc.on('error', async (err) => {
        // Clean up temp file (fire-and-forget)
        fsPromises.unlink(tempScript).catch(() => {});

        // Clean up browser session (only if we created one)
        if (browserSession && browserCashApiKey) {
          try {
            await stopBrowserSession(browserCashApiKey, browserSession.sessionId);
          } catch {
            // Ignore cleanup errors
          }
        }

        // Update task record with error
        taskRecord.status = 'error';
        taskRecord.error = err.message;
        taskRecord.output = collectedOutput;
        taskRecord.updatedAt = new Date().toISOString();
        await saveTask(taskRecord);

        sendEvent('error', { message: err.message, taskId });
        reply.raw.end();
      });
    } catch (error) {
      // Clean up browser session (only if we created one)
      if (browserSession && browserCashApiKey) {
        try {
          await stopBrowserSession(browserCashApiKey, browserSession.sessionId);
        } catch {
          // Ignore cleanup errors
        }
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      taskRecord.status = 'error';
      taskRecord.error = message;
      taskRecord.updatedAt = new Date().toISOString();
      await saveTask(taskRecord);

      sendEvent('error', { message, taskId });
      reply.raw.end();
    }
  }
);

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `session-${timestamp}-${random}`;
}

/**
 * Streaming version of Claude script generation
 */
async function runClaudeStreamingGeneration(
  taskPrompt: string,
  config: ReturnType<typeof loadConfig>,
  sendEvent: (type: SSEEventType, data: unknown) => void
): Promise<{ success: boolean; script: string | null; error?: string }> {
  const sessionId = generateSessionId();

  // Ensure sessions directory exists
  await fsPromises.mkdir(config.sessionsDir, { recursive: true });

  // Get the system prompt and combine with task
  const systemPrompt = getSystemPrompt(config.cdpUrl);
  const fullPrompt = `${systemPrompt}\n\n## Your Task\n\n${taskPrompt}`;

  sendEvent('log', { message: `Starting Claude session: ${sessionId}`, level: 'info' });

  return new Promise((resolve) => {
    let output = '';

    const env = {
      ...process.env,
      CDP_URL: config.cdpUrl,
    };

    // Spawn Claude directly and pipe prompt via stdin (avoids file I/O)
    const claude = spawn('claude', ['-p', '--model', config.model, '--max-turns', String(config.maxTurns), '--allowedTools', 'Bash', '--output-format', 'stream-json', '--verbose'], {
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

      // Parse and stream each line
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);

          // Stream different event types
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text') {
                sendEvent('claude_output', { type: 'text', content: block.text });
              } else if (block.type === 'tool_use') {
                sendEvent('claude_output', { type: 'tool_use', name: block.name, input: block.input });
              }
            }
          } else if (json.type === 'tool_result') {
            sendEvent('claude_output', { type: 'tool_result', content: json.content?.substring(0, 500) });
          }
        } catch {
          // Non-JSON output, log as raw
          if (line.trim()) {
            sendEvent('log', { message: line, level: 'debug' });
          }
        }
      }
    });

    claude.stderr?.on('data', (data) => {
      const text = data.toString();
      sendEvent('log', { message: text, level: 'warn' });
    });

    claude.on('close', (code) => {
      // Extract the script from Claude's output
      const script = extractScriptFromOutput(output);

      if (script) {
        sendEvent('log', { message: 'Successfully extracted script from Claude output', level: 'info' });
      } else {
        sendEvent('log', { message: 'Could not extract script from Claude output', level: 'warn' });
      }

      resolve({
        success: code === 0 && script !== null,
        script,
        error: code !== 0 ? `Exit code: ${code}` : undefined,
      });
    });

    claude.on('error', (err) => {
      resolve({
        success: false,
        script: null,
        error: err.message,
      });
    });
  });
}

/**
 * Streaming version of iterative testing
 */
async function runStreamingIterativeTest(
  scriptContent: string,
  originalTask: string,
  config: ReturnType<typeof loadConfig>,
  sendEvent: (type: SSEEventType, data: unknown) => void
): Promise<{
  success: boolean;
  iterations: number;
  scriptContent: string;
  skippedDueToStaleCdp?: boolean;
}> {
  const maxIterations = config.maxFixIterations;

  sendEvent('log', { message: `Starting iterative testing (max ${maxIterations} attempts)`, level: 'info' });

  // For now, delegate to the existing implementation
  // In a full implementation, we'd refactor iterative-tester.ts to support streaming
  const result = await runIterativeTest(scriptContent, originalTask, config);

  // Send iteration results
  for (let i = 1; i <= result.iterations; i++) {
    sendEvent('iteration_result', {
      iteration: i,
      maxIterations,
      success: i === result.iterations ? result.success : false,
    });
  }

  return {
    success: result.success,
    iterations: result.iterations,
    scriptContent: result.scriptContent,
    skippedDueToStaleCdp: result.skippedDueToStaleCdp,
  };
}

/**
 * Run agentic automation - Claude performs the task directly and returns results.
 * Unlike script generation mode, this does not create a reusable script.
 */
async function runAgenticAutomation(
  taskPrompt: string,
  config: ReturnType<typeof loadConfig>,
  sendEvent: (type: SSEEventType, data: unknown) => void
): Promise<{ success: boolean; result: unknown; summary?: string; error?: string }> {
  const sessionId = generateSessionId();

  // Get the agentic prompt and combine with task
  const systemPrompt = getAgenticPrompt(config.cdpUrl);
  const fullPrompt = `${systemPrompt}\n\n## Your Task\n\n${taskPrompt}`;

  sendEvent('log', { message: `Starting agentic session: ${sessionId}`, level: 'info' });

  return new Promise((resolve) => {
    let output = '';

    const env = {
      ...process.env,
      CDP_URL: config.cdpUrl,
    };

    // Spawn Claude directly and pipe prompt via stdin (avoids file I/O)
    const claude = spawn('claude', ['-p', '--model', config.model, '--max-turns', String(config.maxTurns), '--allowedTools', 'Bash', '--output-format', 'stream-json', '--verbose'], {
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

      // Parse and stream each line
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const json = JSON.parse(line);

          // Stream different event types
          if (json.type === 'assistant' && json.message?.content) {
            for (const block of json.message.content) {
              if (block.type === 'text') {
                sendEvent('claude_output', { type: 'text', content: block.text });
              } else if (block.type === 'tool_use') {
                sendEvent('claude_output', { type: 'tool_use', name: block.name, input: block.input });
              }
            }
          } else if (json.type === 'tool_result') {
            sendEvent('claude_output', { type: 'tool_result', content: json.content?.substring(0, 500) });
          }
        } catch {
          // Non-JSON output, log as raw
          if (line.trim()) {
            sendEvent('log', { message: line, level: 'debug' });
          }
        }
      }
    });

    claude.stderr?.on('data', (data) => {
      const text = data.toString();
      sendEvent('log', { message: text, level: 'warn' });
    });

    claude.on('close', (code) => {
      // Check if we likely hit max turns limit
      const assistantTurns = output.split('\n').filter((l) => l.includes('"type":"assistant"')).length;
      if (assistantTurns >= config.maxTurns - 1) {
        sendEvent('log', {
          message: `Task may have hit max turns limit (${config.maxTurns}). Consider increasing MAX_TURNS env var or --max-turns flag.`,
          level: 'warn',
        });
      }

      // Extract the JSON result from Claude's output
      const result = extractAgenticResult(output);

      if (result) {
        if (result.success) {
          sendEvent('log', { message: 'Successfully extracted result from Claude output', level: 'info' });
        } else {
          sendEvent('log', { message: 'Task completed with failure status', level: 'warn' });
        }
        resolve({
          success: result.success,
          result: result.data,
          summary: result.summary,
          error: result.success ? undefined : result.error,
        });
      } else {
        // No result could be extracted - provide context for debugging
        const textContent = extractTextFromStreamJson(output);
        const lastOutput = textContent.slice(-500);
        sendEvent('log', {
          message: `Could not extract structured result from Claude output. Last output: ${lastOutput.substring(0, 200)}...`,
          level: 'warn',
        });
        resolve({
          success: false,
          result: null,
          error: code !== 0 ? `Exit code: ${code}` : 'Failed to extract result from output. Claude may not have produced JSON in expected format.',
        });
      }
    });

    claude.on('error', (err) => {
      resolve({
        success: false,
        result: null,
        error: err.message,
      });
    });
  });
}

/**
 * Extract the final JSON result from agentic automation output.
 * Looks for the structured JSON output format in Claude's response.
 * Uses multiple strategies to be resilient to format variations.
 */
function extractAgenticResult(output: string): {
  success: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  attempted?: string;
  rawOutput?: string;
} | null {
  const textContent = extractTextFromStreamJson(output);

  // Strategy 1: Look for JSON code blocks with our expected format (```json ... ```)
  const jsonBlockPattern = /```json\s*([\s\S]*?)```/g;
  let lastValidResult: {
    success: boolean;
    data?: unknown;
    summary?: string;
    error?: string;
    attempted?: string;
  } | null = null;

  let match;
  while ((match = jsonBlockPattern.exec(textContent)) !== null) {
    try {
      const jsonStr = match[1].trim();
      const parsed = JSON.parse(jsonStr);

      // Check if this looks like our expected output format
      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        lastValidResult = {
          success: parsed.success === true,
          data: parsed.data,
          summary: parsed.summary,
          error: parsed.error,
          attempted: parsed.attempted,
        };
      }
    } catch {
      // Not valid JSON, continue looking
    }
  }

  if (lastValidResult) {
    return lastValidResult;
  }

  // Strategy 2: Look for any code blocks with JSON data (``` ... ```)
  const anyJsonPattern = /```(?:json)?\s*([\s\S]*?)```/g;
  while ((match = anyJsonPattern.exec(textContent)) !== null) {
    try {
      const jsonStr = match[1].trim();
      if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) continue;

      const parsed = JSON.parse(jsonStr);

      if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null)) {
        // Check if it has success field (format we expect)
        if ('success' in parsed) {
          return {
            success: parsed.success === true,
            data: parsed.data,
            summary: parsed.summary,
            error: parsed.error,
            attempted: parsed.attempted,
          };
        }
        // Otherwise wrap it
        return {
          success: true,
          data: parsed,
          summary: `Extracted ${Array.isArray(parsed) ? parsed.length + ' items' : 'data'}`,
        };
      }
    } catch {
      // Not valid JSON, continue looking
    }
  }

  // Strategy 3: Look for unfenced JSON objects with success field anywhere in text
  // This handles cases where Claude outputs JSON without code fences
  const unfencedPattern = /\{\s*"success"\s*:\s*(true|false)[\s\S]*?\}(?=\s*$|\s*\n\s*\n|\s*[^,\]}])/g;
  while ((match = unfencedPattern.exec(textContent)) !== null) {
    try {
      // Try to find the complete JSON object by balancing braces
      const startIdx = match.index;
      let depth = 0;
      let endIdx = startIdx;
      for (let i = startIdx; i < textContent.length; i++) {
        if (textContent[i] === '{') depth++;
        else if (textContent[i] === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      const jsonStr = textContent.substring(startIdx, endIdx);
      const parsed = JSON.parse(jsonStr);

      if (typeof parsed === 'object' && parsed !== null && 'success' in parsed) {
        return {
          success: parsed.success === true,
          data: parsed.data,
          summary: parsed.summary,
          error: parsed.error,
          attempted: parsed.attempted,
        };
      }
    } catch {
      // Continue looking
    }
  }

  // Strategy 4: Look for any JSON array/object in the last portion of output
  // Sometimes Claude puts the result at the end without code fences
  const lastChunk = textContent.slice(-3000);
  const jsonMatches = lastChunk.match(/(\[[\s\S]*\]|\{[\s\S]*\})/g);
  if (jsonMatches) {
    // Try from last to first (most likely to be the result)
    for (let i = jsonMatches.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonMatches[i]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return {
            success: true,
            data: parsed,
            summary: `Extracted ${parsed.length} items from output`,
          };
        }
        if (typeof parsed === 'object' && parsed !== null) {
          if ('success' in parsed) {
            return {
              success: parsed.success === true,
              data: parsed.data,
              summary: parsed.summary,
              error: parsed.error,
              attempted: parsed.attempted,
            };
          }
          if (Object.keys(parsed).length > 0) {
            return {
              success: true,
              data: parsed,
              summary: 'Extracted data from output',
            };
          }
        }
      } catch {
        // Not valid JSON
      }
    }
  }

  // Strategy 5: If we have substantial text content but no JSON, return it as a failure with context
  // This helps users understand what happened
  if (textContent.trim().length > 50) {
    return {
      success: false,
      error: 'Could not parse structured JSON result from output',
      data: null,
      summary: 'Task completed but output was not in expected format',
      rawOutput: textContent.slice(-2000), // Last 2000 chars for debugging
    };
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

      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          }
        }
      }

      if (json.type === 'result' && json.result) {
        textParts.push(json.result);
      }
    } catch {
      textParts.push(line);
    }
  }

  return textParts.join('\n');
}

/**
 * Extract a bash script from Claude's output.
 */
function extractScriptFromOutput(output: string): string | null {
  const textContent = extractTextFromStreamJson(output);

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
    if (!bestScript.startsWith('#!/')) {
      bestScript = '#!/bin/bash\nset -e\n\nCDP="${CDP_URL:?Required}"\n\n' + bestScript;
    }
    return bestScript;
  }

  return null;
}

/**
 * Score a script based on how complete it looks
 */
function scoreScript(script: string): number {
  let score = 0;

  if (!script.includes('agent-browser')) return 0;

  if (script.includes('#!/bin/bash')) score += 10;
  if (script.includes('CDP=') || script.includes('$CDP')) score += 10;
  if (script.includes('open "http')) score += 20;
  if (script.includes('eval "')) score += 20;
  if (script.includes('FINAL RESULTS') || script.includes('echo "$')) score += 10;

  const snapshotCount = (script.match(/snapshot/g) || []).length;
  score -= snapshotCount * 5;

  const refCount = (script.match(/@e\d+/g) || []).length;
  score -= refCount * 10;

  const openCount = (script.match(/\bopen\s+"/g) || []).length;
  const evalCount = (script.match(/\beval\s+"/g) || []).length;
  score += openCount * 5 + evalCount * 10;

  return score;
}

// ============================================
// MCP HTTP Transport Endpoint
// ============================================

// MCP tool definitions
const mcpTools = [
  {
    name: 'browser_automate',
    description: 'Perform one-off browser automation task. Claude will navigate to websites, interact with elements, and extract data directly. Returns results immediately (no script generated).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of the automation task' },
        browserOptions: {
          type: 'object',
          description: 'Browser session options',
          properties: {
            country: { type: 'string', description: '2-letter ISO country code' },
            adblock: { type: 'boolean', description: 'Enable ad-blocking' },
            captchaSolver: { type: 'boolean', description: 'Enable CAPTCHA solving' },
          },
        },
        waitForCompletion: { type: 'boolean', description: 'Wait for results (default: true for HTTP MCP)' },
        maxWaitSeconds: { type: 'number', description: 'Max wait time (default: 120)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'generate_script',
    description: 'Generate a reusable browser automation script that can be run multiple times.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of what the script should do' },
        browserOptions: { type: 'object', description: 'Browser session options' },
        skipTest: { type: 'boolean', description: 'Skip iterative testing (default: false)' },
        waitForCompletion: { type: 'boolean', description: 'Wait for script generation (default: true)' },
        maxWaitSeconds: { type: 'number', description: 'Max wait time (default: 300)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_scripts',
    description: 'List all stored automation scripts.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_script',
    description: 'Get details of a specific script including content.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'The script ID' },
      },
      required: ['scriptId'],
    },
  },
  {
    name: 'run_script',
    description: 'Execute a stored automation script.',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: 'The script ID to run' },
        browserOptions: { type: 'object', description: 'Browser session options' },
        waitForCompletion: { type: 'boolean', description: 'Wait for execution (default: true)' },
        maxWaitSeconds: { type: 'number', description: 'Max wait time (default: 120)' },
      },
      required: ['scriptId'],
    },
  },
  {
    name: 'get_task',
    description: 'Get the status and result of a task by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List recent tasks.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

interface McpToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// Helper to consume SSE stream and wait for completion
async function consumeMcpStream(
  response: {
    raw: { writeHead: (code: number, headers: Record<string, string>) => void; write: (data: string) => void; end: () => void };
  },
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
  maxWaitMs: number
): Promise<{ success: boolean; data: unknown; error?: string }> {
  const apiUrl = `http://localhost:${process.env.PORT || 3000}${endpoint}`;

  return new Promise(async (resolve) => {
    try {
      const fetchResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, browserCashApiKey: apiKey }),
      });

      if (!fetchResponse.ok) {
        const error = await fetchResponse.json().catch(() => ({ error: 'Request failed' }));
        resolve({ success: false, data: null, error: (error as { error?: string }).error || 'Request failed' });
        return;
      }

      const reader = fetchResponse.body?.getReader();
      if (!reader) {
        resolve({ success: false, data: null, error: 'No response body' });
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const timeout = setTimeout(() => {
        reader.cancel();
        resolve({ success: false, data: null, error: 'Timeout' });
      }, maxWaitMs);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === 'complete') {
                clearTimeout(timeout);
                resolve({ success: event.data?.success ?? true, data: event.data });
                return;
              }
              if (event.type === 'error') {
                clearTimeout(timeout);
                resolve({ success: false, data: null, error: event.data?.message || 'Error' });
                return;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }

      clearTimeout(timeout);
      resolve({ success: false, data: null, error: 'Stream ended without completion' });
    } catch (err) {
      resolve({ success: false, data: null, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  });
}

// MCP HTTP endpoint
server.post<{ Body: McpRequest; Headers: { 'x-api-key'?: string } }>(
  '/mcp',
  async (request, reply) => {
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        id: request.body?.id || null,
        error: { code: -32001, message: 'x-api-key header required' },
      });
    }

    const { jsonrpc, id, method, params } = request.body;

    if (jsonrpc !== '2.0') {
      return reply.code(400).send({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC version' },
      });
    }

    const ownerId = hashApiKey(apiKey);

    // Handle MCP methods
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'claude-gen', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: mcpTools },
        };

      case 'tools/call': {
        const { name, arguments: args = {} } = (params || {}) as McpToolCallParams;
        const maxWait = ((args.maxWaitSeconds as number) || 120) * 1000;

        try {
          let result: { success: boolean; data: unknown; error?: string };

          switch (name) {
            case 'browser_automate':
              result = await consumeMcpStream(reply, apiKey, '/automate/stream', {
                task: args.task,
                browserOptions: args.browserOptions,
              }, maxWait);
              break;

            case 'generate_script':
              result = await consumeMcpStream(reply, apiKey, '/generate/stream', {
                task: args.task,
                browserOptions: args.browserOptions,
                skipTest: args.skipTest,
              }, ((args.maxWaitSeconds as number) || 300) * 1000);
              break;

            case 'run_script':
              result = await consumeMcpStream(reply, apiKey, `/scripts/${args.scriptId}/run`, {
                browserOptions: args.browserOptions,
              }, maxWait);
              break;

            case 'list_scripts': {
              const scripts = await listScripts(ownerId);
              result = { success: true, data: { scripts } };
              break;
            }

            case 'get_script': {
              const script = await getScript(args.scriptId as string, ownerId);
              if (!script) {
                result = { success: false, data: null, error: 'Script not found' };
              } else {
                result = { success: true, data: script };
              }
              break;
            }

            case 'get_task': {
              const task = await getTask(args.taskId as string, ownerId);
              if (!task) {
                result = { success: false, data: null, error: 'Task not found' };
              } else {
                result = { success: true, data: task };
              }
              break;
            }

            case 'list_tasks': {
              const tasks = await listTasks(ownerId);
              result = { success: true, data: { tasks } };
              break;
            }

            default:
              return {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Unknown tool: ${name}` },
              };
          }

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }],
            },
          };
        } catch (err) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : 'Unknown error' },
          };
        }
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }
);

// Start server
async function start() {
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await server.listen({ port, host });
    console.log(`
===========================================
  Claude-Gen HTTP API Server
===========================================

Server running at http://${host}:${port}

Endpoints:
  GET  /health            - Health check
  POST /mcp               - MCP HTTP transport (for Claude Desktop/Cursor)
  POST /test-cdp          - Test CDP connectivity
  POST /generate          - Generate browser automation script (JSON response)
  POST /generate/stream   - Generate with real-time SSE streaming
  POST /automate/stream   - Agentic mode: perform task and return results directly

  GET  /scripts           - List all stored scripts
  GET  /scripts/:id       - Get a specific script
  POST /scripts/:id/run   - Run a stored script with SSE streaming

  GET  /tasks             - List recent tasks (for result retrieval)
  GET  /tasks/:taskId     - Get task status and result (if client disconnects)

MCP Integration (Claude Code):
  claude mcp add --transport http claude-gen https://claude-gen-api-264851422957.us-central1.run.app/mcp -H "x-api-key: YOUR_API_KEY"

Browser Authentication (choose one):
  - cdpUrl: Direct WebSocket CDP URL
  - browserCashApiKey: Browser.cash API key (creates session automatically)

Example requests:

  # Generate with Browser.cash API key (recommended)
  curl -X POST http://localhost:${port}/generate/stream \\
    -H "Content-Type: application/json" \\
    -d '{
      "task": "Go to example.com and get the title",
      "browserCashApiKey": "your-api-key",
      "browserOptions": {"country": "US", "adblock": true}
    }'

  # Generate with direct CDP URL (legacy)
  curl -X POST http://localhost:${port}/generate/stream \\
    -H "Content-Type: application/json" \\
    -d '{"task": "Go to example.com and get the title", "cdpUrl": "wss://..."}'

  # Run stored script with Browser.cash
  curl -X POST http://localhost:${port}/scripts/script-abc123/run \\
    -H "Content-Type: application/json" \\
    -d '{"browserCashApiKey": "your-api-key"}'

Environment variables:
  PORT               - Server port (default: 3000)
  HOST               - Server host (default: 0.0.0.0)
  GCS_BUCKET         - GCS bucket for script storage (default: claude-gen-scripts)
  BROWSER_CASH_API_URL - Browser.cash API URL (default: https://api.browser.cash)
  ANTHROPIC_API_KEY  - Required for Claude API calls
  MODEL              - Claude model (default: claude-opus-4-5-20251101)
  MAX_TURNS          - Max Claude turns (default: 15)
  MAX_FIX_ITERATIONS - Max fix attempts (default: 5)
`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

start();
