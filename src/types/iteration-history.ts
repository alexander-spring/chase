/**
 * Iteration history tracking for fix attempts.
 * Provides context to Claude about what was already tried.
 */

export interface IterationAttempt {
  iteration: number;
  scriptContent: string;
  errorOutput: string;
  syntaxError?: string;
  selectorsUsed: string[];
}

export interface IterationHistory {
  originalTask: string;
  attempts: IterationAttempt[];
}

/**
 * Extract CSS selectors from a bash script containing agent-browser eval commands.
 * Looks for common selector patterns used in querySelector/querySelectorAll.
 */
export function extractSelectorsFromScript(scriptContent: string): string[] {
  const selectors: Set<string> = new Set();

  // Pattern 1: querySelector/querySelectorAll with string literal
  // Matches: querySelector("selector"), querySelectorAll('selector')
  const querySelectorPattern = /querySelectorAll?\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let match;
  while ((match = querySelectorPattern.exec(scriptContent)) !== null) {
    selectors.add(match[1]);
  }

  // Pattern 2: Variable assignments that look like selectors
  // Matches: var SELECTOR = "..."; const selector = '...'
  const selectorVarPattern = /(?:var|let|const)\s+\w*[Ss]elector\w*\s*=\s*['"`]([^'"`]+)['"`]/g;
  while ((match = selectorVarPattern.exec(scriptContent)) !== null) {
    selectors.add(match[1]);
  }

  // Pattern 3: Common selector patterns in strings
  // Look for data attributes, class selectors, element selectors in quoted strings
  const genericSelectorPattern = /['"`](\[data-[^\]]+\]|\.[\w-]+|\#[\w-]+|[a-z]+\[[\w-]+=)['"`]/gi;
  while ((match = genericSelectorPattern.exec(scriptContent)) !== null) {
    // Only add if it looks like a real selector (not just any string)
    const candidate = match[1];
    if (candidate.length > 2 && (
      candidate.startsWith('[') ||
      candidate.startsWith('.') ||
      candidate.startsWith('#') ||
      /^[a-z]+\[/.test(candidate)
    )) {
      selectors.add(candidate);
    }
  }

  return Array.from(selectors);
}

/**
 * Format iteration history for inclusion in a fix prompt.
 * Provides Claude with context about previous attempts.
 */
export function formatIterationHistory(history: IterationHistory): string {
  if (history.attempts.length === 0) {
    return '';
  }

  let output = `\n## Previous Fix Attempts (${history.attempts.length} so far)\n\n`;
  output += `**IMPORTANT**: These approaches have already been tried and FAILED. Do NOT repeat them.\n\n`;

  for (const attempt of history.attempts) {
    output += `### Attempt ${attempt.iteration}\n`;

    // Show selectors that were tried
    if (attempt.selectorsUsed.length > 0) {
      output += `**Selectors tried:** ${attempt.selectorsUsed.slice(0, 5).map(s => `\`${s}\``).join(', ')}`;
      if (attempt.selectorsUsed.length > 5) {
        output += ` (and ${attempt.selectorsUsed.length - 5} more)`;
      }
      output += '\n';
    }

    // Show syntax error if any
    if (attempt.syntaxError) {
      output += `**Syntax error:** ${attempt.syntaxError.substring(0, 200)}\n`;
    }

    // Summarize the error (truncated)
    const errorSummary = summarizeError(attempt.errorOutput);
    output += `**Result:** ${errorSummary}\n\n`;
  }

  output += `---\n\n`;
  output += `**What to try differently:**\n`;
  output += `- Use DIFFERENT selectors than those listed above\n`;
  output += `- If selectors keep failing, use findProductGrid() to discover the main container\n`;
  output += `- If data quality is low, inspect the actual DOM structure with agent-browser snapshot\n`;
  output += `- If pagination isn't working, verify items actually change between pages\n\n`;

  return output;
}

/**
 * Create a short summary of an error for display in history.
 */
function summarizeError(errorOutput: string): string {
  // Extract the most relevant part of the error
  const lines = errorOutput.split('\n').filter(l => l.trim());

  // Look for semantic error line
  const semanticMatch = errorOutput.match(/\[SEMANTIC ERROR\]\s*(.+)/);
  if (semanticMatch) {
    return semanticMatch[1].substring(0, 150);
  }

  // Look for data quality issues
  const dataQualityMatch = errorOutput.match(/\[DATA QUALITY ISSUES\]\s*([\s\S]*?)(?:\n\n|\[)/);
  if (dataQualityMatch) {
    const issues = dataQualityMatch[1].trim().split('\n').slice(0, 2);
    return issues.join('; ').substring(0, 150);
  }

  // Look for common error patterns
  if (errorOutput.includes('extracted 0') || errorOutput.includes('No items extracted')) {
    return 'No items extracted - selector likely wrong';
  }
  if (errorOutput.includes('jq: error')) {
    return 'JSON parsing error - double-encoded JSON issue';
  }
  if (errorOutput.includes('WRONG_SELECTOR')) {
    return 'Wrong selector - targeting ads/carousel instead of main grid';
  }
  if (errorOutput.includes('INCOMPLETE')) {
    return 'Incomplete extraction - need more scrolling or pagination';
  }
  if (errorOutput.includes('valid prices')) {
    return 'Low price extraction rate - price selectors failing';
  }
  if (errorOutput.includes('valid ratings')) {
    return 'Low rating extraction rate - rating selectors failing';
  }

  // Default: first meaningful line
  for (const line of lines) {
    if (line.length > 10 && !line.startsWith('[STDOUT]')) {
      return line.substring(0, 150);
    }
  }

  return 'Script execution failed';
}

/**
 * Create a new empty iteration history.
 */
export function createIterationHistory(originalTask: string): IterationHistory {
  return {
    originalTask,
    attempts: [],
  };
}

/**
 * Add an attempt to the iteration history.
 */
export function addAttemptToHistory(
  history: IterationHistory,
  iteration: number,
  scriptContent: string,
  errorOutput: string,
  syntaxError?: string
): void {
  history.attempts.push({
    iteration,
    scriptContent,
    errorOutput,
    syntaxError,
    selectorsUsed: extractSelectorsFromScript(scriptContent),
  });
}
