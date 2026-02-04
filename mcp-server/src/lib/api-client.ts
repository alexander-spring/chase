import type {
  ApiClientConfig,
  BrowserOptions,
  Script,
  ScriptMetadata,
  TaskRecord,
} from './types.js';

const DEFAULT_BASE_URL = 'https://chase-api-264851422957.us-central1.run.app';

/**
 * HTTP client for the Chase API
 */
export class ApiClient {
  private baseUrl: string;
  private defaultApiKey?: string;

  constructor(config: ApiClientConfig = { baseUrl: DEFAULT_BASE_URL }) {
    this.baseUrl = config.baseUrl;
    this.defaultApiKey = config.defaultApiKey;
  }

  /**
   * Get a specific task by ID
   */
  async getTask(taskId: string, apiKey?: string): Promise<TaskRecord> {
    const key = apiKey || this.defaultApiKey;
    if (!key) {
      throw new Error('API key required');
    }

    const response = await fetch(`${this.baseUrl}/tasks/${taskId}`, {
      headers: { 'x-api-key': key },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * List recent tasks
   */
  async listTasks(apiKey?: string): Promise<{ tasks: TaskRecord[] }> {
    const key = apiKey || this.defaultApiKey;
    if (!key) {
      throw new Error('API key required');
    }

    const response = await fetch(`${this.baseUrl}/tasks`, {
      headers: { 'x-api-key': key },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * List stored scripts
   */
  async listScripts(apiKey?: string): Promise<{ scripts: ScriptMetadata[] }> {
    const key = apiKey || this.defaultApiKey;
    if (!key) {
      throw new Error('API key required');
    }

    const response = await fetch(`${this.baseUrl}/scripts`, {
      headers: { 'x-api-key': key },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Get a specific script by ID
   */
  async getScript(scriptId: string, apiKey?: string): Promise<Script> {
    const key = apiKey || this.defaultApiKey;
    if (!key) {
      throw new Error('API key required');
    }

    const response = await fetch(`${this.baseUrl}/scripts/${scriptId}`, {
      headers: { 'x-api-key': key },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Start an automate task (SSE streaming)
   * Returns a Response that can be used to consume the SSE stream
   */
  async startAutomate(
    task: string,
    options: {
      apiKey?: string;
      cdpUrl?: string;
      browserOptions?: BrowserOptions;
    } = {}
  ): Promise<Response> {
    const body: Record<string, unknown> = { task };

    if (options.apiKey || this.defaultApiKey) {
      body.browserCashApiKey = options.apiKey || this.defaultApiKey;
    }
    if (options.cdpUrl) {
      body.cdpUrl = options.cdpUrl;
    }
    if (options.browserOptions) {
      body.browserOptions = options.browserOptions;
    }

    if (!body.browserCashApiKey && !body.cdpUrl) {
      throw new Error('Either apiKey or cdpUrl is required');
    }

    const response = await fetch(`${this.baseUrl}/automate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response;
  }

  /**
   * Start a generate task (SSE streaming)
   * Returns a Response that can be used to consume the SSE stream
   */
  async startGenerate(
    task: string,
    options: {
      apiKey?: string;
      cdpUrl?: string;
      browserOptions?: BrowserOptions;
      skipTest?: boolean;
    } = {}
  ): Promise<Response> {
    const body: Record<string, unknown> = { task };

    if (options.apiKey || this.defaultApiKey) {
      body.browserCashApiKey = options.apiKey || this.defaultApiKey;
    }
    if (options.cdpUrl) {
      body.cdpUrl = options.cdpUrl;
    }
    if (options.browserOptions) {
      body.browserOptions = options.browserOptions;
    }
    if (options.skipTest !== undefined) {
      body.skipTest = options.skipTest;
    }

    if (!body.browserCashApiKey && !body.cdpUrl) {
      throw new Error('Either apiKey or cdpUrl is required');
    }

    const response = await fetch(`${this.baseUrl}/generate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response;
  }

  /**
   * Run a stored script (SSE streaming)
   * Returns a Response that can be used to consume the SSE stream
   */
  async runScript(
    scriptId: string,
    options: {
      apiKey?: string;
      cdpUrl?: string;
      browserOptions?: BrowserOptions;
    } = {}
  ): Promise<Response> {
    const body: Record<string, unknown> = {};

    if (options.apiKey || this.defaultApiKey) {
      body.browserCashApiKey = options.apiKey || this.defaultApiKey;
    }
    if (options.cdpUrl) {
      body.cdpUrl = options.cdpUrl;
    }
    if (options.browserOptions) {
      body.browserOptions = options.browserOptions;
    }

    if (!body.browserCashApiKey && !body.cdpUrl) {
      throw new Error('Either apiKey or cdpUrl is required');
    }

    const response = await fetch(`${this.baseUrl}/scripts/${scriptId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response;
  }
}

/**
 * Create a default API client
 */
export function createApiClient(config?: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}
