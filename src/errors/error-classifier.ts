/**
 * Structured error classification for browser automation scripts.
 * Replaces heuristic string patterns with categorized, confidence-scored errors.
 */

export enum ErrorCategory {
  CDP_CONNECTION = 'CDP_CONNECTION',
  NAVIGATION = 'NAVIGATION',
  SELECTOR_EMPTY = 'SELECTOR_EMPTY',
  SELECTOR_WRONG = 'SELECTOR_WRONG',
  DATA_QUALITY = 'DATA_QUALITY',
  EXTRACTION_INCOMPLETE = 'EXTRACTION_INCOMPLETE',
  JSON_PARSING = 'JSON_PARSING',
  JAVASCRIPT_ERROR = 'JAVASCRIPT_ERROR',
  BASH_ERROR = 'BASH_ERROR',
  TIMEOUT = 'TIMEOUT',
  ACCESS_DENIED = 'ACCESS_DENIED',
  UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedError {
  category: ErrorCategory;
  message: string;
  confidence: number; // 0-1
  suggestedFix?: string;
  details?: Record<string, unknown>;
}

interface ClassificationRule {
  category: ErrorCategory;
  patterns: RegExp[];
  confidence: number;
  getMessage: (match: RegExpMatchArray | null, stdout: string, stderr: string) => string;
  getSuggestedFix?: () => string;
  extractDetails?: (match: RegExpMatchArray | null, stdout: string, stderr: string) => Record<string, unknown>;
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  // CDP Connection errors - highest priority
  {
    category: ErrorCategory.CDP_CONNECTION,
    patterns: [
      /Resource temporarily unavailable/i,
      /os error 35/i,
      /WebSocket.*(?:error|closed|failed)/i,
      /ECONNREFUSED/i,
      /connection closed/i,
      /CDP.*(?:stale|unavailable|disconnected)/i,
    ],
    confidence: 0.95,
    getMessage: () => 'Browser CDP connection lost or unavailable',
    getSuggestedFix: () => 'Restart the browser and get a fresh CDP_URL',
  },

  // Timeout errors
  {
    category: ErrorCategory.TIMEOUT,
    patterns: [
      /timed?\s*out/i,
      /timeout/i,
      /exceeded.*time/i,
    ],
    confidence: 0.9,
    getMessage: () => 'Script execution timed out',
    getSuggestedFix: () => 'Increase timeout or optimize script. Check if page is loading slowly.',
  },

  // JSON parsing errors (double-encoded JSON)
  {
    category: ErrorCategory.JSON_PARSING,
    patterns: [
      /jq:\s*error/i,
      /cannot be added/i,
      /cannot be subtracted/i,
      /Cannot iterate over string/i,
      /parse error.*Invalid/i,
    ],
    confidence: 0.95,
    getMessage: () => 'JSON parsing error - agent-browser eval returns double-encoded JSON',
    getSuggestedFix: () => 'Add unwrap_json() helper and use: DATA=$(unwrap_json "$RAW_OUTPUT")',
  },

  // JavaScript errors
  {
    category: ErrorCategory.JAVASCRIPT_ERROR,
    patterns: [
      /SyntaxError:\s*(.+)/i,
      /TypeError:\s*(.+)/i,
      /ReferenceError:\s*(.+)/i,
      /EvalError:\s*(.+)/i,
    ],
    confidence: 0.95,
    getMessage: (match) => `JavaScript error: ${match?.[1] || 'unknown'}`,
    getSuggestedFix: () => 'Check JavaScript syntax. Use single quotes around JS in bash to avoid escaping issues.',
  },

  // Bash errors
  {
    category: ErrorCategory.BASH_ERROR,
    patterns: [
      /integer expression expected/i,
      /syntax error: operand expected/i,
      /unbound variable/i,
      /bad substitution/i,
      /command not found/i,
    ],
    confidence: 0.9,
    getMessage: (match) => `Bash error: ${match?.[0] || 'unknown'}`,
    getSuggestedFix: () => 'Check bash syntax. Ensure variables are properly quoted.',
  },

  // Access denied
  {
    category: ErrorCategory.ACCESS_DENIED,
    patterns: [
      /Access Denied/i,
      /403 Forbidden/i,
      /401 Unauthorized/i,
      /blocked by.*(?:captcha|cloudflare|bot)/i,
    ],
    confidence: 0.9,
    getMessage: () => 'Access denied - page blocked access',
    getSuggestedFix: () => 'The site may be blocking automated access. Try a different approach or use the existing browser session.',
  },

  // Navigation errors
  {
    category: ErrorCategory.NAVIGATION,
    patterns: [
      /net::ERR_/i,
      /Navigation failed/i,
      /page[\s-]?not[\s-]?found/i,
      /error[\s:_-]*404/i,
      /404[\s:_-]*(?:not[\s-]?found|error)/i,
    ],
    confidence: 0.85,
    getMessage: () => 'Navigation error - page not found or failed to load',
    getSuggestedFix: () => 'Check the URL is correct. Navigate via site menu instead of direct URL.',
  },

  // Selector returning zero items
  {
    category: ErrorCategory.SELECTOR_EMPTY,
    patterns: [
      /extracted\s*0/i,
      /"totalExtracted":\s*0/i,
      /No items extracted/i,
      /returned empty results/i,
      /^\s*\[\s*\]\s*$/m,
    ],
    confidence: 0.9,
    getMessage: () => 'Selector returned zero items',
    getSuggestedFix: () => 'The container selector matches nothing. Test selectors first with: agent-browser eval \'document.querySelectorAll("SELECTOR").length\'',
  },

  // Wrong selector (targeting ads/carousel)
  {
    category: ErrorCategory.SELECTOR_WRONG,
    patterns: [
      /WRONG_SELECTOR/i,
      /targeting.*(?:carousel|ads|sticky)/i,
      /same item.*(?:appears|multiple pages)/i,
      /items didn't change between pages/i,
    ],
    confidence: 0.9,
    getMessage: () => 'Selector targeting ads/carousel instead of main product grid',
    getSuggestedFix: () => 'Find a selector that returns 20-50 items per page. Use findProductGrid() to discover the main container.',
  },

  // Incomplete extraction
  {
    category: ErrorCategory.EXTRACTION_INCOMPLETE,
    patterns: [
      /INCOMPLETE/i,
      /Only\s+(\d+)\s+items.*(?:need|expected|incomplete)/i,
      /Task requested\s+(\d+).*but only extracted\s+(\d+)/i,
    ],
    confidence: 0.85,
    getMessage: (match, stdout) => {
      const countMatch = stdout.match(/extracted\s+(\d+)/i) || stdout.match(/"totalExtracted":\s*(\d+)/);
      const count = countMatch ? countMatch[1] : 'few';
      return `Incomplete extraction - only ${count} items found`;
    },
    getSuggestedFix: () => 'Use scroll-and-accumulate pattern. Handle pagination. Ensure selector targets main grid.',
  },

  // Data quality issues
  {
    category: ErrorCategory.DATA_QUALITY,
    patterns: [
      /valid prices.*need/i,
      /valid ratings.*need/i,
      /DATA QUALITY ISSUES/i,
      /N\/A.*(?:prices?|ratings?)/i,
    ],
    confidence: 0.85,
    getMessage: (match, stdout) => {
      if (/prices/i.test(stdout)) return 'Low price extraction rate';
      if (/ratings/i.test(stdout)) return 'Low rating extraction rate';
      return 'Data quality issues detected';
    },
    getSuggestedFix: () => 'Use universal helper functions (getPrice, getRating) that try multiple discovery methods.',
    extractDetails: (_match, stdout) => {
      const priceMatch = stdout.match(/(\d+)%.*valid prices/);
      const ratingMatch = stdout.match(/(\d+)%.*valid ratings/);
      return {
        priceRate: priceMatch ? parseInt(priceMatch[1], 10) : undefined,
        ratingRate: ratingMatch ? parseInt(ratingMatch[1], 10) : undefined,
      };
    },
  },
];

/**
 * Classify error(s) from script output.
 * Returns all matching classifications sorted by confidence.
 */
export function classifyErrors(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean
): ClassifiedError[] {
  const errors: ClassifiedError[] = [];
  const combined = stdout + '\n' + stderr;

  // Handle timeout first
  if (timedOut) {
    errors.push({
      category: ErrorCategory.TIMEOUT,
      message: 'Script execution timed out',
      confidence: 1.0,
      suggestedFix: 'Increase timeout or optimize script',
    });
  }

  // Check each rule
  for (const rule of CLASSIFICATION_RULES) {
    for (const pattern of rule.patterns) {
      const match = combined.match(pattern);
      if (match) {
        errors.push({
          category: rule.category,
          message: rule.getMessage(match, stdout, stderr),
          confidence: rule.confidence,
          suggestedFix: rule.getSuggestedFix?.(),
          details: rule.extractDetails?.(match, stdout, stderr),
        });
        break; // Only one match per rule
      }
    }
  }

  // If no specific errors but non-zero exit code
  if (errors.length === 0 && exitCode !== null && exitCode !== 0) {
    errors.push({
      category: ErrorCategory.UNKNOWN,
      message: `Script exited with code ${exitCode}`,
      confidence: 0.5,
    });
  }

  // Sort by confidence (highest first)
  errors.sort((a, b) => b.confidence - a.confidence);

  // Deduplicate by category (keep highest confidence)
  const seen = new Set<ErrorCategory>();
  return errors.filter(e => {
    if (seen.has(e.category)) return false;
    seen.add(e.category);
    return true;
  });
}

/**
 * Get the primary (highest confidence) error classification.
 */
export function getPrimaryError(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean
): ClassifiedError | null {
  const errors = classifyErrors(stdout, stderr, exitCode, timedOut);
  return errors.length > 0 ? errors[0] : null;
}

/**
 * Format classified errors for display in prompts.
 */
export function formatClassifiedErrors(errors: ClassifiedError[]): string {
  if (errors.length === 0) return '';

  let output = '## Classified Errors\n\n';

  for (const error of errors) {
    output += `### ${error.category}\n`;
    output += `**Issue:** ${error.message}\n`;
    if (error.suggestedFix) {
      output += `**Fix:** ${error.suggestedFix}\n`;
    }
    if (error.details) {
      output += `**Details:** ${JSON.stringify(error.details)}\n`;
    }
    output += `**Confidence:** ${Math.round(error.confidence * 100)}%\n\n`;
  }

  return output;
}

/**
 * Generate targeted guidance based on error classification.
 */
export function getGuidanceForError(error: ClassifiedError): string {
  switch (error.category) {
    case ErrorCategory.CDP_CONNECTION:
      return `
## CDP CONNECTION LOST
The browser CDP session is no longer available. This typically happens when:
- The browser was closed
- The CDP session timed out
- Network issues interrupted the connection

**Action Required:** Get a fresh CDP_URL and restart the script.
`;

    case ErrorCategory.JSON_PARSING:
      return `
## JSON PARSING ERROR (Double-Encoded JSON)

agent-browser eval returns DOUBLE-ENCODED JSON. The output is a string containing JSON, not raw JSON.

**Required Fix:**
1. Add this helper at the TOP of your script:
\`\`\`bash
unwrap_json() {
  echo "$1" | jq -r 'if type == "string" then fromjson else . end' 2>/dev/null || echo "$1"
}
\`\`\`

2. Use it after EVERY agent-browser eval that returns JSON:
\`\`\`bash
RAW_DATA=$(agent-browser --cdp "$CDP" eval '...JSON.stringify...')
DATA=$(unwrap_json "$RAW_DATA")
\`\`\`
`;

    case ErrorCategory.SELECTOR_EMPTY:
      return `
## NO ITEMS EXTRACTED

The container selector doesn't match any elements. Common causes:
1. Wrong selector - test with: agent-browser eval 'document.querySelectorAll("SELECTOR").length'
2. Page not fully loaded - add more sleep time
3. JavaScript syntax error - check for escaping issues

**Fix:** Use single quotes around JavaScript to avoid bash escaping:
\`\`\`bash
agent-browser --cdp "$CDP" eval '(function() { ... })();'
\`\`\`
`;

    case ErrorCategory.SELECTOR_WRONG:
      return `
## WRONG SELECTOR (Targeting Ads/Carousel)

Your selector finds items from sponsored/ads section, NOT the main product grid.

**How to find the MAIN grid:**
1. Use findProductGrid() to discover the container with most repeated children
2. Test candidate selectors and pick the one with 20-50 items per page
3. Verify items CHANGE after pagination - if same items appear, wrong selector
`;

    case ErrorCategory.DATA_QUALITY:
      return `
## DATA QUALITY ISSUES

Price or rating extraction is failing for many items.

**Use universal helper functions that try multiple discovery methods:**
- getPrice(el) - tries schema.org, data attributes, ARIA, class patterns, text patterns
- getRating(el) - tries schema.org, data attributes, ARIA labels, text patterns

**NEVER return "N/A"** - return empty string if no data found.
`;

    case ErrorCategory.EXTRACTION_INCOMPLETE:
      return `
## INCOMPLETE EXTRACTION

Only a portion of items were extracted. This often happens with:
1. Lazy-loaded content that requires scrolling
2. Pagination that wasn't fully handled
3. Selector targeting a subset (ads/carousel) instead of main grid

**Fix:** Use scroll-and-accumulate pattern and handle all pages.
`;

    default:
      return error.suggestedFix ? `\n**Suggested fix:** ${error.suggestedFix}\n` : '';
  }
}
