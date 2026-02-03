export interface Config {
  cdpUrl: string;
  outputDir: string;
  sessionsDir: string;
  maxTurns: number;
  model: string;
  maxFixIterations: number;
  fixTimeout: number;
  fixRequestTimeout: number;
  validation: ValidationThresholds;
}

/**
 * Configurable validation thresholds for extracted data.
 * Can be set via environment variables or inferred from task description.
 */
export interface ValidationThresholds {
  /** Minimum percentage of items with valid prices (0-1). Default: 0.9 */
  minPriceRate: number;
  /** Minimum percentage of items with valid ratings (0-1). Default: 0.8 */
  minRatingRate: number;
  /** Minimum number of items to extract. Default: 1 */
  minItemCount: number;
  /** Whether prices are required for this task. Default: true */
  requirePrices: boolean;
  /** Whether ratings are required for this task. Default: true */
  requireRatings: boolean;
}

/**
 * Infer validation thresholds from task description.
 * Only validates fields the user explicitly asked for.
 */
export function inferValidationFromTask(taskDescription: string): Partial<ValidationThresholds> {
  const overrides: Partial<ValidationThresholds> = {};

  // Detect what fields the user explicitly asked for
  const mentionsRating = /\b(rating|star|review|score)\b/i.test(taskDescription);
  const mentionsPrice = /\b(price|cost|\$|dollar|amount)\b/i.test(taskDescription);

  // Only require fields the user explicitly asked for
  // Default to not requiring ratings unless explicitly mentioned
  if (!mentionsRating) {
    overrides.requireRatings = false;
    overrides.minRatingRate = 0;
  }

  // Only require prices if explicitly mentioned
  if (!mentionsPrice) {
    overrides.requirePrices = false;
    overrides.minPriceRate = 0;
  }

  // "All items" tasks need higher minimum counts
  if (/\ball\b/i.test(taskDescription)) {
    overrides.minItemCount = 20;
  }

  // Tasks with specific counts (e.g., "top 100 products")
  const countMatch = taskDescription.match(/(?:top|first|get|extract)\s+(\d+)/i);
  if (countMatch) {
    const requested = parseInt(countMatch[1], 10);
    // Require at least 70% of requested count
    overrides.minItemCount = Math.max(overrides.minItemCount || 1, Math.floor(requested * 0.7));
  }

  return overrides;
}

/**
 * Get default validation thresholds.
 */
function getDefaultValidation(): ValidationThresholds {
  return {
    minPriceRate: 0.9,
    minRatingRate: 0.8,
    minItemCount: 1,
    requirePrices: true,
    requireRatings: true,
  };
}

/**
 * Load validation thresholds from environment variables.
 */
function loadValidationFromEnv(): Partial<ValidationThresholds> {
  const overrides: Partial<ValidationThresholds> = {};

  if (process.env.MIN_PRICE_RATE !== undefined) {
    overrides.minPriceRate = parseFloat(process.env.MIN_PRICE_RATE);
  }
  if (process.env.MIN_RATING_RATE !== undefined) {
    overrides.minRatingRate = parseFloat(process.env.MIN_RATING_RATE);
  }
  if (process.env.MIN_ITEM_COUNT !== undefined) {
    overrides.minItemCount = parseInt(process.env.MIN_ITEM_COUNT, 10);
  }
  if (process.env.REQUIRE_PRICES !== undefined) {
    overrides.requirePrices = process.env.REQUIRE_PRICES.toLowerCase() === 'true';
  }
  if (process.env.REQUIRE_RATINGS !== undefined) {
    overrides.requireRatings = process.env.REQUIRE_RATINGS.toLowerCase() === 'true';
  }

  return overrides;
}

export interface LoadConfigOptions {
  /** Override CDP URL (instead of using CDP_URL env var) */
  cdpUrl?: string;
  /** Task description for validation threshold inference */
  taskDescription?: string;
}

/**
 * Load configuration from environment variables with optional overrides.
 *
 * @param taskDescriptionOrOptions - Either a task description string (for backwards compatibility)
 *                                   or an options object with cdpUrl and taskDescription
 */
export function loadConfig(taskDescriptionOrOptions?: string | LoadConfigOptions): Config {
  // Handle backwards compatibility: string arg = task description
  let cdpUrlOverride: string | undefined;
  let taskDescription: string | undefined;

  if (typeof taskDescriptionOrOptions === 'string') {
    taskDescription = taskDescriptionOrOptions;
  } else if (taskDescriptionOrOptions) {
    cdpUrlOverride = taskDescriptionOrOptions.cdpUrl;
    taskDescription = taskDescriptionOrOptions.taskDescription;
  }

  // CDP URL: prefer override, then env var
  const cdpUrl = cdpUrlOverride || process.env.CDP_URL;
  if (!cdpUrl) {
    throw new Error('CDP_URL is required (pass via options.cdpUrl or set CDP_URL env var)');
  }

  // Build validation thresholds: defaults → env overrides → task inference
  const defaultValidation = getDefaultValidation();
  const envOverrides = loadValidationFromEnv();
  const taskOverrides = taskDescription ? inferValidationFromTask(taskDescription) : {};

  const validation: ValidationThresholds = {
    ...defaultValidation,
    ...envOverrides,
    ...taskOverrides,
  };

  return {
    cdpUrl,
    outputDir: process.env.OUTPUT_DIR || './generated',
    sessionsDir: process.env.SESSIONS_DIR || './sessions',
    maxTurns: parseInt(process.env.MAX_TURNS || '30', 10),
    model: process.env.MODEL || 'claude-opus-4-5-20251101',
    maxFixIterations: parseInt(process.env.MAX_FIX_ITERATIONS || '5', 10),
    // Script execution timeout (default 5 minutes for complex multi-page tasks)
    fixTimeout: parseInt(process.env.FIX_TIMEOUT || '300000', 10),
    // Claude fix request timeout (default 5 minutes for generating fixes)
    fixRequestTimeout: parseInt(process.env.FIX_REQUEST_TIMEOUT || '300000', 10),
    validation,
  };
}
