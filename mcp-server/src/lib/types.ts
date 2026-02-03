/**
 * Browser session configuration options
 */
export interface BrowserOptions {
  /** 2-letter ISO country code */
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

/**
 * Script metadata from GCS storage
 */
export interface ScriptMetadata {
  id: string;
  ownerId: string;
  task: string;
  createdAt: string;
  iterations: number;
  success: boolean;
  scriptSize: number;
}

/**
 * Full script with content and metadata
 */
export interface Script {
  content: string;
  metadata: ScriptMetadata;
}

/**
 * Task status values
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'error';

/**
 * Task type values
 */
export type TaskType = 'generate' | 'automate' | 'run_script';

/**
 * Task record from GCS storage
 */
export interface TaskRecord {
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
 * SSE event from streaming endpoints
 */
export interface SSEEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

/**
 * Start event data
 */
export interface StartEventData {
  taskId: string;
  task?: string;
  mode?: string;
  model?: string;
  skipTest?: boolean;
  browserSessionId?: string;
}

/**
 * Complete event data for automate
 */
export interface AutomateCompleteData {
  taskId: string;
  success: boolean;
  result?: unknown;
  summary?: string;
  error?: string;
  browserSessionId?: string;
}

/**
 * Complete event data for generate
 */
export interface GenerateCompleteData {
  taskId: string;
  success: boolean;
  script?: string;
  iterations?: number;
  scriptId?: string;
  skippedDueToStaleCdp?: boolean;
  browserSessionId?: string;
}

/**
 * Complete event data for run_script
 */
export interface RunScriptCompleteData {
  taskId: string;
  exitCode: number;
  success: boolean;
  browserSessionId?: string;
}

/**
 * Request body for browser_automate tool
 */
export interface AutomateRequest {
  task: string;
  apiKey?: string;
  cdpUrl?: string;
  browserOptions?: BrowserOptions;
  waitForCompletion?: boolean;
  maxWaitSeconds?: number;
}

/**
 * Request body for generate_script tool
 */
export interface GenerateScriptRequest {
  task: string;
  apiKey?: string;
  cdpUrl?: string;
  browserOptions?: BrowserOptions;
  skipTest?: boolean;
  waitForCompletion?: boolean;
  maxWaitSeconds?: number;
}

/**
 * Request body for run_script tool
 */
export interface RunScriptRequest {
  scriptId: string;
  apiKey?: string;
  cdpUrl?: string;
  browserOptions?: BrowserOptions;
  waitForCompletion?: boolean;
  maxWaitSeconds?: number;
}

/**
 * Result when a task is started (async mode)
 */
export interface TaskStartedResult {
  taskId: string;
  status: 'started';
  message: string;
}

/**
 * API client configuration
 */
export interface ApiClientConfig {
  baseUrl: string;
  defaultApiKey?: string;
}
