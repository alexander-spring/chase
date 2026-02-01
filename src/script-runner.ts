import { spawn } from 'child_process';
import * as fs from 'fs';
import {
  classifyErrors,
  type ClassifiedError,
  ErrorCategory,
} from './errors/error-classifier.js';

export interface ScriptResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  failedLineNumber?: number;
  semanticError?: string;
  cdpStale?: boolean;
  classifiedErrors?: ClassifiedError[];
}

export interface CdpRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Check if a CDP URL is still valid/responsive
 * Returns true if the connection works, false if stale/unavailable
 *
 * Supports retry with exponential backoff for transient failures.
 */
export async function checkCdpConnectivity(
  cdpUrl: string,
  options: CdpRetryOptions = {}
): Promise<{ connected: boolean; error?: string; attempts?: number }> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 4000,
  } = options;

  let lastError: string | undefined;
  let attempts = 0;

  for (let retry = 0; retry < maxRetries; retry++) {
    attempts++;
    const result = await checkCdpConnectivityOnce(cdpUrl);

    if (result.connected) {
      return { connected: true, attempts };
    }

    lastError = result.error;

    // Don't retry on definitive errors (server not running)
    if (result.error?.includes('ECONNREFUSED')) {
      return { connected: false, error: result.error, attempts };
    }

    // Exponential backoff for retryable errors
    if (retry < maxRetries - 1) {
      const delay = Math.min(initialDelayMs * Math.pow(2, retry), maxDelayMs);
      await sleep(delay);
    }
  }

  return { connected: false, error: lastError, attempts };
}

/**
 * Single CDP connectivity check without retry.
 */
async function checkCdpConnectivityOnce(cdpUrl: string): Promise<{ connected: boolean; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn('agent-browser', ['--cdp', cdpUrl, 'eval', 'true'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdout = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      resolve({ connected: false, error: 'CDP connectivity check timed out' });
    }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const combined = stdout + stderr;

      // Check for common stale connection errors
      if (combined.includes('Resource temporarily unavailable') ||
          combined.includes('os error 35') ||
          combined.includes('WebSocket') ||
          combined.includes('ECONNREFUSED') ||
          combined.includes('connection closed') ||
          code !== 0) {
        resolve({ connected: false, error: combined.trim() || `Exit code: ${code}` });
      } else {
        resolve({ connected: true });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({ connected: false, error: err.message });
    });
  });
}

/**
 * Sleep for a specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run a bash script and capture the result
 */
export async function runScript(
  scriptPath: string,
  cdpUrl: string,
  timeout: number,
  taskDescription?: string
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn('bash', [scriptPath], {
      env: { ...process.env, CDP_URL: cdpUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Give it a moment to terminate gracefully, then force kill
      setTimeout(() => {
        proc.kill('SIGKILL');
      }, 2000);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      const failedLineNumber = parseFailedLineNumber(stderr, stdout);
      const semanticError = detectSemanticError(stdout, stderr, taskDescription);

      // Classify errors for structured handling
      const classifiedErrors = classifyErrors(stdout, stderr, code, timedOut);

      // Check for CDP stale error
      const cdpStale = classifiedErrors.some(e => e.category === ErrorCategory.CDP_CONNECTION);

      // Consider semantic errors as failures even if exit code is 0
      const hasError = code !== 0 || timedOut || semanticError !== null;

      resolve({
        success: !hasError,
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        failedLineNumber,
        semanticError: semanticError || undefined,
        cdpStale,
        classifiedErrors,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

/**
 * Run a script from content (writes to temp file first)
 */
export async function runScriptContent(
  scriptContent: string,
  cdpUrl: string,
  timeout: number
): Promise<ScriptResult> {
  // Write to temp file
  const tempPath = `/tmp/claude-gen-test-${Date.now()}.sh`;
  fs.writeFileSync(tempPath, scriptContent);
  fs.chmodSync(tempPath, '755');

  try {
    return await runScript(tempPath, cdpUrl, timeout);
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Detect semantic errors in script output
 * These are cases where the script "succeeds" but didn't accomplish its goal
 * @param stdout - Script stdout
 * @param stderr - Script stderr
 * @param taskDescription - Optional task description to validate expected counts
 */
function detectSemanticError(stdout: string, stderr: string, taskDescription?: string): string | null {
  const combined = stdout + '\n' + stderr;

  // Check for incomplete extraction - totalExtracted vs expected
  // Pattern: "totalExtracted": 8 or "totalExtracted":8
  const extractedMatch = stdout.match(/"totalExtracted":\s*(\d+)/);
  if (extractedMatch) {
    const extractedCount = parseInt(extractedMatch[1], 10);

    // If task mentions "all" items, be strict about completeness
    if (taskDescription && /\ball\b/i.test(taskDescription)) {
      // Look for indicators of how many items should exist on the page
      // e.g., "24 products", "showing 50 results"
      const pageCountMatch = stdout.match(/(\d+)\s*(?:products?|items?|results?|parkas?)/i);
      if (pageCountMatch) {
        const pageCount = parseInt(pageCountMatch[1], 10);
        // If page shows more items than we extracted, it's incomplete
        if (pageCount > extractedCount * 1.2) { // Allow 20% margin
          return `INCOMPLETE: Page shows ${pageCount} items but only extracted ${extractedCount}. Need to navigate to the full product listing page (not a landing page), then scroll more or handle pagination.`;
        }
      }

      // For "all items" tasks, require at least 20 items for product listings
      // Most e-commerce category pages have 40+ products per page
      if (extractedCount < 20) {
        return `INCOMPLETE: Only extracted ${extractedCount} items. For "all items" tasks, this is likely incomplete. Your selector may be targeting a carousel/ads section instead of the main product grid. Look for a selector that returns 20-50 items per page.`;
      }
    }
  }

  // Check for pagination that didn't actually change items (wrong selector targeting sticky element)
  // Pattern: "Found X items on page 1" ... "Found X items on page 2" with same sample item
  const pageExtractionPattern = /Found (\d+) items on page (\d+)/g;
  const pageExtractions: { page: number; count: number }[] = [];
  let pageMatch;
  while ((pageMatch = pageExtractionPattern.exec(stdout)) !== null) {
    pageExtractions.push({ page: parseInt(pageMatch[2], 10), count: parseInt(pageMatch[1], 10) });
  }

  // If we have multiple pages with very low counts (< 10), likely wrong selector
  if (pageExtractions.length > 3) {
    const lowCountPages = pageExtractions.filter(p => p.count < 10).length;
    if (lowCountPages > pageExtractions.length * 0.5) {
      return `WRONG_SELECTOR: Pages are returning very few items (${pageExtractions.map(p => p.count).join(', ')}). Your selector is likely targeting a carousel or ads section instead of the main product grid. Find a different selector that returns 20-50 items per page.`;
    }
  }

  // Check for same sample item appearing on multiple pages (strong signal of wrong selector)
  const sampleItemPattern = /Sample item:[\s\S]*?"name":\s*"([^"]+)"/g;
  const sampleItems: string[] = [];
  let sampleMatch;
  while ((sampleMatch = sampleItemPattern.exec(stdout)) !== null) {
    sampleItems.push(sampleMatch[1]);
  }
  if (sampleItems.length > 3) {
    // Check if same item appears on > 50% of pages
    const firstItem = sampleItems[0];
    const sameItemCount = sampleItems.filter(s => s === firstItem).length;
    if (sameItemCount > sampleItems.length * 0.5) {
      return `WRONG_SELECTOR: Same item "${firstItem.substring(0, 50)}..." appears on ${sameItemCount}/${sampleItems.length} pages. This means your selector is targeting a sticky element (ads/carousel) that doesn't change between pages. Find a different selector for the main product grid.`;
    }
  }

  // Note: Low item count check is already handled by totalExtracted check above.
  // The previous regex-based check was removed because it was faulty
  // (matched only once at array start, not each item).

  // Check if we have substantial JSON data extraction (indicates success, not 404)
  // Count occurrences of common data field patterns in JSON output
  // Handles both escaped (\"name\":) and unescaped ("name":) JSON
  const dataFieldPattern = /\\?"(?:name|title|price|url|id|rank)\\?":\s*\\?["\d\[{]/g;
  const dataFieldCount = (stdout.match(dataFieldPattern) || []).length;
  const hasSubstantialData = dataFieldCount >= 5;

  // Check for 404/error pages - be more specific to avoid false positives
  // Only check stderr for navigation errors, not stdout (which may contain page content)
  // Match patterns like "Page not found", "Error 404", "404 error", "404 Not Found"
  const pageNotFoundPattern = /(?:page[\s-]?not[\s-]?found|error[\s:_-]*404|404[\s:_-]*(?:not[\s-]?found|error)|Page\s+Not\s+Found)/i;
  // Flag 404 if it's in stderr, OR in stdout AND (no substantial data OR low item count for "all" tasks)
  const extractedCount = extractedMatch ? parseInt(extractedMatch[1], 10) : 0;
  const lowItemCountFor404 = extractedCount > 0 && extractedCount < 15;
  const isAllItemsTask = taskDescription && /\ball\b/i.test(taskDescription);
  if (pageNotFoundPattern.test(stderr) ||
      (pageNotFoundPattern.test(stdout) && (!hasSubstantialData || (isAllItemsTask && lowItemCountFor404)))) {
    return 'Navigation landed on 404/error page - URL may have changed or redirected';
  }

  // Check for empty results when we expected data
  // Pattern 1: "[]" or '[]' as the only output on a line
  const emptyArrayPattern = /^(?:\s*"\[\]"\s*|\s*\[\]\s*)$/m;
  if (emptyArrayPattern.test(stdout)) {
    return 'Script returned empty results []';
  }

  // Pattern 2: JSON with zero counts or empty arrays in final output
  // Only trigger if we see intermediate successful extractions followed by empty final result
  const zeroCountPattern = /"(?:total|count|length)":\s*0/i;
  const emptyArrayInJsonPattern = /"(?:tokens|results|items|data|entries|records)":\s*\[\s*\]/;
  const hasIntermediateSuccess = /"count":\s*(?:[1-9]|[1-9]\d+)/.test(stdout) ||
                                  /extraction complete/i.test(stdout) ||
                                  /Page \d+/i.test(stdout);

  if (hasIntermediateSuccess && (zeroCountPattern.test(stdout) || emptyArrayInJsonPattern.test(stdout))) {
    // Check if the empty result appears in the final lines (after intermediate extractions)
    const finalLines = stdout.trim().split('\n').slice(-20).join('\n');
    if (emptyArrayInJsonPattern.test(finalLines) || zeroCountPattern.test(finalLines)) {
      return 'Script extracted data but final result is empty (likely variable scoping issue between evals)';
    }
  }

  // Pattern 3: Standalone empty arrays/objects at the end
  const finalLinesMatch = stdout.trim().split('\n').slice(-5).join('\n');
  if (/^\s*\[\s*\]\s*$/m.test(finalLinesMatch) || /^\s*\{\s*\}\s*$/m.test(finalLinesMatch)) {
    return 'Script returned empty result';
  }

  // Pattern 4: Garbled/concatenated data values
  // Note: Some sites legitimately show both short and long format (e.g., "$5.72B$5,722,189,974")
  // This is common on financial sites like CoinMarketCap - not actually an error
  // Only flag truly garbled data where values are nonsensically merged
  // DISABLED: This check was too aggressive and flagged valid data from financial sites
  // const garbledValuePattern = /\$[\d,.]+[TBMK]?\$[\d,.]+|\d{3,},\d{3,}[TBMK]?\d/;
  // if (garbledValuePattern.test(stdout)) {
  //   return 'Data quality issue: Concatenated/garbled values detected';
  // }

  // Pattern 5: Script extracts data but no clear final output section
  // Check if there are multiple JSON arrays printed but no "FINAL" or "RESULT" section
  // Skip this check if we have substantial data - the script may output data directly
  const jsonArrayMatches = stdout.match(/\[\s*\{[^}]+\}/g) || [];
  const hasFinalSection = /(?:FINAL|RESULT|COMBINED|OUTPUT|TOTAL)/i.test(stdout);
  if (jsonArrayMatches.length >= 2 && !hasFinalSection && !hasSubstantialData) {
    // Multiple data extractions but no final combined output
    return 'Script has multiple extraction outputs but no final combined result section';
  }

  // Pattern 6: Extraction count mismatch - if we see "Total rows/items: X" but extracted much less
  const totalCountMatch = stdout.match(/Total (?:rows|items|results|entries)[:\s]+(\d+)/i);
  if (totalCountMatch) {
    const totalCount = parseInt(totalCountMatch[1], 10);
    // Count objects in JSON arrays (rough estimate by counting opening braces after commas/brackets)
    const jsonObjectMatches = stdout.match(/[\[,]\s*\{/g) || [];
    // If we report 50+ items but only extracted 25% or less, flag it
    if (totalCount >= 50 && jsonObjectMatches.length < totalCount * 0.25) {
      return `Incomplete extraction: Found ${totalCount} items but only extracted ~${jsonObjectMatches.length}`;
    }
  }

  // Check for common error indicators in output
  // Only flag if in stderr or if we don't have substantial data
  if ((stderr.includes('Access Denied') || stderr.includes('403 Forbidden')) ||
      ((combined.includes('Access Denied') || combined.includes('403 Forbidden')) && !hasSubstantialData)) {
    return 'Access denied to page';
  }

  // Check for JavaScript errors in eval - these are real errors in stderr
  if (stderr.includes('SyntaxError:') || stderr.includes('TypeError:') || stderr.includes('ReferenceError:')) {
    return 'JavaScript error in eval command';
  }

  // Check for jq JSON parsing errors (double-encoded JSON from agent-browser eval)
  if (stderr.includes('jq: error') || combined.includes('cannot be added') ||
      combined.includes('cannot be subtracted') || combined.includes('Cannot iterate over string')) {
    return 'JSON_DOUBLE_ENCODING: agent-browser eval returns string-encoded JSON. Add unwrap_json() helper and use: DATA=$(unwrap_json "$RAW_OUTPUT")';
  }

  // Check for navigation errors - only flag if in stderr or no substantial data
  // Scripts may encounter transient nav errors but still succeed
  if (stderr.includes('net::ERR_') || stderr.includes('Navigation failed') ||
      ((combined.includes('net::ERR_') || combined.includes('Navigation failed')) && !hasSubstantialData)) {
    return 'Navigation error';
  }

  // Check for undefined/null results that suggest variable scoping issues
  if (/^undefined$/m.test(stdout) || /^null$/m.test(stdout)) {
    return 'Script returned undefined/null (likely variable not accessible between evals)';
  }

  // Check for bash runtime errors (arithmetic, syntax in runtime)
  // These appear even when exit code is 0 if using set +e or error in subshell
  const bashRuntimeErrors = [
    /integer expression expected/i,
    /syntax error: operand expected/i,
    /unbound variable/i,
    /bad substitution/i,
  ];
  for (const pattern of bashRuntimeErrors) {
    if (pattern.test(combined)) {
      return `Bash runtime error: ${combined.match(pattern)?.[0] || 'unknown'}`;
    }
  }

  // Check for CDP/WebSocket connection errors (stale session)
  if (combined.includes('Resource temporarily unavailable') ||
      combined.includes('os error 35') ||
      combined.includes('WebSocket') ||
      combined.includes('ECONNREFUSED') ||
      combined.includes('connection closed')) {
    return 'CDP_STALE: Browser session is no longer available';
  }

  // Pattern 7: Task-based extraction count validation
  // If the task mentions a specific count (e.g., "top 200 tokens"), verify we got close
  if (taskDescription) {
    const expectedCountMatch = taskDescription.match(/(?:top|first|get|extract|scrape)\s+(\d+)\s+(?:items?|tokens?|products?|results?|rows?|entries?|records?)/i);
    if (expectedCountMatch) {
      const expectedCount = parseInt(expectedCountMatch[1], 10);

      // First, check if totalExtracted is in the output
      const totalExtractedMatch = stdout.match(/"totalExtracted":\s*(\d+)/);
      if (totalExtractedMatch) {
        const totalExtracted = parseInt(totalExtractedMatch[1], 10);
        // If we got less than 70% of expected, flag as incomplete
        if (totalExtracted < expectedCount * 0.7) {
          return `Incomplete extraction: Task requested ${expectedCount} items but only extracted ${totalExtracted} (${Math.round(totalExtracted / expectedCount * 100)}%). Need more scrolling or pagination.`;
        }
        // If we got a good count, don't flag as error
        return null;
      }

      // Fallback: Count actual items in JSON output - handle various escaping scenarios
      // Patterns: {"rank": or {\"rank\": or {\\"rank\\": or { "rank":
      const jsonObjectPatterns = [
        /\{\s*\\?"(?:rank|id|name|title)\\?":/g,        // {"rank": or {\"rank\":
        /\{\s*\\"(?:rank|id|name|title)\\":/g,          // {\\"rank\\": (double escaped)
        /\\n\s*\{\s*\\n\s*\\"rank\\":/g,                // Escaped JSON with newlines
      ];

      let jsonObjectCount = 0;
      for (const pattern of jsonObjectPatterns) {
        const matches = stdout.match(pattern) || [];
        jsonObjectCount = Math.max(jsonObjectCount, matches.length);
      }

      // If we got less than 70% of expected, flag as incomplete
      if (jsonObjectCount < expectedCount * 0.7) {
        return `Incomplete extraction: Task requested ${expectedCount} items but only extracted ~${jsonObjectCount} (${Math.round(jsonObjectCount / expectedCount * 100)}%). This often indicates a virtualized/lazy-loaded table that requires scroll-and-accumulate pattern.`;
      }
    }
  }

  return null;
}

/**
 * Parse error output to find the line number that failed
 */
function parseFailedLineNumber(stderr: string, stdout: string): number | undefined {
  const combined = stderr + '\n' + stdout;

  // Look for patterns like "line 42:" or "at line 42"
  const lineMatch = combined.match(/(?:line\s+|:)(\d+)(?:\s*:|\s*$)/i);
  if (lineMatch) {
    return parseInt(lineMatch[1], 10);
  }

  // Look for bash error format: "script.sh: line 42: command not found"
  const bashMatch = combined.match(/\.sh:\s*line\s+(\d+):/i);
  if (bashMatch) {
    return parseInt(bashMatch[1], 10);
  }

  return undefined;
}

/**
 * Format error output for display
 */
export function formatErrorOutput(result: ScriptResult): string {
  let output = '';

  if (result.semanticError) {
    output += `[SEMANTIC ERROR] ${result.semanticError}\n`;
  }

  if (result.timedOut) {
    output += '[TIMEOUT] Script execution timed out\n';
  }

  if (result.stderr) {
    output += `[STDERR]\n${result.stderr}\n`;
  }

  if (result.stdout) {
    // Truncate stdout if too long
    const maxLen = 2000;
    const truncated = result.stdout.length > maxLen
      ? result.stdout.substring(result.stdout.length - maxLen) + '\n... (truncated)'
      : result.stdout;
    output += `[STDOUT]\n${truncated}\n`;
  }

  if (result.exitCode !== null && result.exitCode !== 0) {
    output += `[EXIT CODE] ${result.exitCode}\n`;
  }

  if (result.failedLineNumber) {
    output += `[FAILED AT] Line ${result.failedLineNumber}\n`;
  }

  return output.trim();
}
