export interface Config {
  cdpUrl: string;
  outputDir: string;
  sessionsDir: string;
  maxTurns: number;
  model: string;
  maxFixIterations: number;
  fixTimeout: number;
  fixRequestTimeout: number;
}

export function loadConfig(): Config {
  const cdpUrl = process.env.CDP_URL;
  if (!cdpUrl) {
    throw new Error('CDP_URL environment variable is required');
  }

  return {
    cdpUrl,
    outputDir: process.env.OUTPUT_DIR || './generated',
    sessionsDir: process.env.SESSIONS_DIR || './sessions',
    maxTurns: parseInt(process.env.MAX_TURNS || '25', 10),
    model: process.env.MODEL || 'claude-opus-4-5-20251101',
    maxFixIterations: parseInt(process.env.MAX_FIX_ITERATIONS || '5', 10),
    // Script execution timeout (default 5 minutes for complex multi-page tasks)
    fixTimeout: parseInt(process.env.FIX_TIMEOUT || '300000', 10),
    // Claude fix request timeout (default 5 minutes for generating fixes)
    fixRequestTimeout: parseInt(process.env.FIX_REQUEST_TIMEOUT || '300000', 10),
  };
}
