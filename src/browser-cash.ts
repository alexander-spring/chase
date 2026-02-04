/**
 * Browser.cash API Client
 *
 * Handles creating, managing, and stopping browser sessions via the Browser.cash API.
 */

const BROWSER_CASH_API_URL = process.env.BROWSER_CASH_API_URL || 'https://api.browser.cash';

export interface BrowserSessionOptions {
  /** Target a specific node */
  nodeId?: string;
  /** 2-letter country code (e.g., "US") */
  country?: string;
  /** Node type: consumer_distributed, hosted, testing */
  type?: 'consumer_distributed' | 'hosted' | 'testing';
  /** SOCKS5 proxy URL */
  proxyUrl?: string;
  /** Window size (e.g., "1920x1080") */
  windowSize?: string;
  /** Browser profile settings */
  profile?: {
    name: string;
    persist?: boolean;
  };
  /** Enable ad-blocking */
  adblock?: boolean;
  /** Enable CAPTCHA solver */
  captchaSolver?: boolean;
}

export interface BrowserSession {
  sessionId: string;
  status: 'starting' | 'active' | 'completed' | 'error';
  servedBy: string;
  createdAt: string;
  stoppedAt: string | null;
  cdpUrl: string | null;
}

export interface BrowserCashError {
  error: string;
}

/**
 * Create a new browser session
 */
export async function createBrowserSession(
  apiKey: string,
  options: BrowserSessionOptions = {}
): Promise<BrowserSession> {
  const response = await fetch(`${BROWSER_CASH_API_URL}/v1/browser/session`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const error = await response.json() as BrowserCashError;
    throw new Error(`Browser.cash API error: ${error.error || response.statusText}`);
  }

  return response.json() as Promise<BrowserSession>;
}

/**
 * Get an existing browser session
 */
export async function getBrowserSession(
  apiKey: string,
  sessionId: string
): Promise<BrowserSession> {
  const response = await fetch(
    `${BROWSER_CASH_API_URL}/v1/browser/session?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json() as BrowserCashError;
    throw new Error(`Browser.cash API error: ${error.error || response.statusText}`);
  }

  return response.json() as Promise<BrowserSession>;
}

/**
 * Stop a browser session
 */
export async function stopBrowserSession(
  apiKey: string,
  sessionId: string
): Promise<{ success: boolean }> {
  const response = await fetch(
    `${BROWSER_CASH_API_URL}/v1/browser/session?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    }
  );

  if (!response.ok) {
    const error = await response.json() as BrowserCashError;
    throw new Error(`Browser.cash API error: ${error.error || response.statusText}`);
  }

  return response.json() as Promise<{ success: boolean }>;
}

/**
 * Wait for a session to become active and return the session with CDP URL
 * Uses adaptive polling: fast at start, slows down over time
 */
export async function waitForSessionReady(
  apiKey: string,
  sessionId: string,
  timeoutMs: number = 30000
): Promise<{ session: BrowserSession; cdpUrl: string }> {
  const startTime = Date.now();
  // Adaptive polling: start fast (200ms), then slow down
  const pollIntervals = [200, 300, 500, 750, 1000, 1500, 2000];
  let pollIndex = 0;

  while (Date.now() - startTime < timeoutMs) {
    const session = await getBrowserSession(apiKey, sessionId);

    if (session.status === 'active' && session.cdpUrl) {
      return { session, cdpUrl: session.cdpUrl };
    }

    if (session.status === 'error') {
      throw new Error('Browser session failed to start');
    }

    if (session.status === 'completed') {
      throw new Error('Browser session already completed');
    }

    // Use adaptive delay
    const delay = pollIntervals[Math.min(pollIndex, pollIntervals.length - 1)];
    await new Promise(resolve => setTimeout(resolve, delay));
    pollIndex++;
  }

  throw new Error(`Timeout waiting for browser session to become ready`);
}

/**
 * Create a browser session and wait for it to be ready
 */
export async function createAndWaitForSession(
  apiKey: string,
  options: BrowserSessionOptions = {},
  timeoutMs: number = 30000
): Promise<{ session: BrowserSession; cdpUrl: string }> {
  const session = await createBrowserSession(apiKey, options);

  // If session is already active with CDP URL, return immediately
  if (session.status === 'active' && session.cdpUrl) {
    return { session, cdpUrl: session.cdpUrl };
  }

  // Otherwise wait for it to be ready - returns both session and cdpUrl
  return waitForSessionReady(apiKey, session.sessionId, timeoutMs);
}

/**
 * Helper to manage a browser session lifecycle for script execution
 */
export class BrowserSessionManager {
  private apiKey: string;
  private session: BrowserSession | null = null;
  private cdpUrl: string | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async start(options: BrowserSessionOptions = {}): Promise<string> {
    const result = await createAndWaitForSession(this.apiKey, options);
    this.session = result.session;
    this.cdpUrl = result.cdpUrl;
    return this.cdpUrl;
  }

  async stop(): Promise<void> {
    if (this.session) {
      try {
        await stopBrowserSession(this.apiKey, this.session.sessionId);
      } catch {
        // Ignore errors when stopping - session may already be stopped
      }
      this.session = null;
      this.cdpUrl = null;
    }
  }

  getSessionId(): string | null {
    return this.session?.sessionId || null;
  }

  getCdpUrl(): string | null {
    return this.cdpUrl;
  }

  isActive(): boolean {
    return this.session?.status === 'active' && this.cdpUrl !== null;
  }
}
