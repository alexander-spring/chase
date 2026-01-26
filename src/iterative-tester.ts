import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Config } from './config.js';
import { writeScript, normalizeScriptCdp } from './codegen/bash-generator.js';
import { runScript, formatErrorOutput, checkCdpConnectivity, type ScriptResult } from './script-runner.js';
import { getFixPrompt, parseFixedScript } from './prompts/fix-prompt.js';

export interface IterativeTestResult {
  success: boolean;
  iterations: number;
  finalScriptPath: string;
  scriptContent: string;
  lastError?: string;
  skippedDueToStaleCdp?: boolean;
}

/**
 * Run iterative testing loop: test script, if fails ask Claude to fix, repeat
 */
export async function runIterativeTest(
  scriptContent: string,
  originalTask: string,
  config: Config,
  customOutput?: string
): Promise<IterativeTestResult> {
  const maxIterations = config.maxFixIterations;

  console.log(`\n[claude-gen] Starting iterative testing (max ${maxIterations} attempts)...`);

  // Normalize the script's CDP references
  let normalizedScript = normalizeScriptCdp(scriptContent, config.cdpUrl);

  // Check CDP connectivity before starting
  console.log(`[claude-gen] Checking CDP connectivity...`);
  const cdpCheck = await checkCdpConnectivity(config.cdpUrl);
  if (!cdpCheck.connected) {
    console.log(`[claude-gen] WARNING: CDP connection appears stale or unavailable.`);
    console.log(`[claude-gen] Error: ${cdpCheck.error}`);
    console.log(`[claude-gen] Skipping iterative testing - you'll need to test with a fresh CDP_URL.`);

    // Write script anyway but skip testing
    const scriptPath = writeScript(normalizedScript, {
      cdpUrl: config.cdpUrl,
      outputDir: config.outputDir,
      filename: customOutput,
    });

    return {
      success: false,
      iterations: 0,
      finalScriptPath: scriptPath,
      scriptContent: normalizedScript,
      lastError: `CDP connection unavailable: ${cdpCheck.error}`,
      skippedDueToStaleCdp: true,
    };
  }
  console.log(`[claude-gen] CDP connection OK`);

  // Write initial script
  let scriptPath = writeScript(normalizedScript, {
    cdpUrl: config.cdpUrl,
    outputDir: config.outputDir,
    filename: customOutput,
  });

  let currentScript = normalizedScript;
  let lastResult: ScriptResult | null = null;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(`\n[claude-gen] Iteration ${iteration}/${maxIterations}: Testing script...`);

    // Re-check CDP connectivity before each iteration
    const iterationCdpCheck = await checkCdpConnectivity(config.cdpUrl);
    if (!iterationCdpCheck.connected) {
      console.log(`[claude-gen] CDP connection became unavailable during testing.`);
      console.log(`[claude-gen] Returning current script - test with a fresh CDP_URL.`);
      return {
        success: false,
        iterations: iteration - 1,
        finalScriptPath: scriptPath,
        scriptContent: currentScript,
        lastError: `CDP connection lost: ${iterationCdpCheck.error}`,
        skippedDueToStaleCdp: true,
      };
    }

    // Run the script
    const result = await runScript(scriptPath, config.cdpUrl, config.fixTimeout, originalTask);
    lastResult = result;

    // Validate data quality even if script "succeeded"
    const dataValidation = validateExtractedData(result.stdout || '');

    if (result.success && dataValidation.valid) {
      console.log(`[claude-gen] Script passed on iteration ${iteration}!`);
      return {
        success: true,
        iterations: iteration,
        finalScriptPath: scriptPath,
        scriptContent: currentScript,
      };
    }

    // Script failed or has data quality issues
    let errorOutput = formatErrorOutput(result);

    // Include validation issues in error output
    if (!dataValidation.valid) {
      const validationError = `[DATA QUALITY ISSUES]\n${dataValidation.issues.join('\n')}\n\n`;
      errorOutput = validationError + errorOutput;
      console.log(`[claude-gen] Data quality issues on iteration ${iteration}:`);
      dataValidation.issues.forEach(issue => console.log(`  - ${issue}`));
    } else {
      console.log(`[claude-gen] Script failed on iteration ${iteration}`);
      console.log(`[claude-gen] Error: ${errorOutput.substring(0, 300)}...`);
    }

    // If this was the last iteration, don't try to fix
    if (iteration === maxIterations) {
      console.log(`[claude-gen] Max iterations reached. Returning last attempt.`);
      break;
    }

    // Ask Claude to fix the script
    console.log(`[claude-gen] Asking Claude to fix the script...`);

    const fixedScript = await askClaudeToFix(
      originalTask,
      currentScript,
      errorOutput,
      result.failedLineNumber,
      config
    );

    if (!fixedScript) {
      console.log(`[claude-gen] Could not parse fixed script from Claude's response.`);
      continue;
    }

    // Validate bash syntax before using the fixed script
    const syntaxError = await validateBashSyntax(fixedScript);
    if (syntaxError) {
      console.log(`[claude-gen] Fixed script has syntax error: ${syntaxError}`);
      console.log(`[claude-gen] Skipping this fix and continuing with current script.`);
      continue;
    }

    // Update script content and file
    currentScript = fixedScript;

    // Generate new filename for the fixed version
    const fixedFilename = customOutput
      ? `${customOutput.replace('.sh', '')}-fix${iteration}.sh`
      : `script-fix${iteration}-${Date.now()}.sh`;

    scriptPath = path.join(config.outputDir, fixedFilename);
    fs.writeFileSync(scriptPath, currentScript);
    fs.chmodSync(scriptPath, '755');

    console.log(`[claude-gen] Updated script: ${scriptPath}`);
  }

  // Return last attempt even if failed
  return {
    success: false,
    iterations: maxIterations,
    finalScriptPath: scriptPath,
    scriptContent: currentScript,
    lastError: lastResult ? formatErrorOutput(lastResult) : undefined,
  };
}

/**
 * Ask Claude to fix a failing script
 */
async function askClaudeToFix(
  originalTask: string,
  scriptContent: string,
  errorOutput: string,
  failedLineNumber: number | undefined,
  config: Config
): Promise<string | null> {
  const fixPrompt = getFixPrompt(originalTask, scriptContent, errorOutput, failedLineNumber, config.cdpUrl);

  // Write prompt to temp file
  const promptFile = `/tmp/claude-gen-fix-prompt-${Date.now()}.txt`;
  fs.writeFileSync(promptFile, fixPrompt);

  return new Promise((resolve) => {
    let output = '';
    let resolved = false;

    const cleanup = (promptPath: string) => {
      try {
        fs.unlinkSync(promptPath);
      } catch {
        // Ignore
      }
    };

    const safeResolve = (value: string | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        resolve(value);
      }
    };

    // Call Claude to fix the script - allow Bash so it can inspect the DOM
    const shellCmd = `cat "${promptFile}" | claude -p --model ${config.model} --max-turns 5 --allowedTools "Bash" --output-format stream-json --verbose`;

    const claude = spawn('bash', ['-c', shellCmd], {
      env: { ...process.env, CDP_URL: config.cdpUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    claude.stdout?.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr?.on('data', (data) => {
      process.stderr.write(`[fix] ${data.toString()}`);
    });

    claude.on('close', (code) => {
      cleanup(promptFile);

      if (code !== 0) {
        console.log(`[claude-gen] Claude fix request failed with code ${code}`);
        safeResolve(null);
        return;
      }

      // Extract text from stream-json format
      const textContent = extractTextFromStreamJson(output);

      // Parse the fixed script from Claude's response
      const fixedScript = parseFixedScript(textContent);
      safeResolve(fixedScript);
    });

    claude.on('error', (err) => {
      cleanup(promptFile);
      console.log(`[claude-gen] Claude fix request error: ${err.message}`);
      safeResolve(null);
    });

    // Timeout for fix request
    const fixRequestTimeout = config.fixRequestTimeout;
    const timeoutId = setTimeout(() => {
      claude.kill();
      cleanup(promptFile);
      console.log(`[claude-gen] Fix request timed out after ${fixRequestTimeout / 1000}s`);
      safeResolve(null);
    }, fixRequestTimeout);
  });
}

/**
 * Validate bash script syntax without executing it
 */
async function validateBashSyntax(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    const tempPath = `/tmp/claude-gen-syntax-check-${Date.now()}.sh`;
    fs.writeFileSync(tempPath, script);

    const proc = spawn('bash', ['-n', tempPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }

      if (code === 0) {
        resolve(null);
      } else {
        resolve(stderr.trim() || `Syntax check failed with code ${code}`);
      }
    });

    proc.on('error', (err) => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      resolve(err.message);
    });

    setTimeout(() => {
      proc.kill();
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore
      }
      resolve('Syntax check timed out');
    }, 5000);
  });
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

      // Extract text from assistant messages
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          }
        }
      }

      // Also check for result messages
      if (json.type === 'result' && json.result) {
        textParts.push(json.result);
      }
    } catch {
      // Not valid JSON, might be raw text
      textParts.push(line);
    }
  }

  return textParts.join('\n');
}

/**
 * Validate extracted data quality
 * Stricter validation - fail if too many items have N/A or missing values
 */
function validateExtractedData(output: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  try {
    // Try to find JSON in output - handle both regular and double-encoded JSON
    let jsonMatch = output.match(/\{[\s\S]*"items"[\s\S]*\}/);

    // If no match, try to handle double-encoded JSON (from agent-browser eval)
    // The output looks like: "{\n  \"totalExtracted\": 22,\n  \"items\": [..."
    if (!jsonMatch) {
      // Look for escaped JSON pattern
      const escapedMatch = output.match(/"(\{[\s\S]*\\?"items\\?"[\s\S]*\})"/);
      if (escapedMatch) {
        // Parse the outer JSON string to get the inner JSON
        try {
          const innerJson = JSON.parse('"' + escapedMatch[1] + '"');
          jsonMatch = [innerJson];
        } catch {
          // If that fails, try simple unescape
          const unescaped = escapedMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
          jsonMatch = [unescaped];
        }
      }
    }

    if (!jsonMatch) return { valid: true, issues: [] }; // Can't validate, assume OK

    const data = JSON.parse(jsonMatch[0]);
    const items = data.items || [];

    // Fail validation if zero items
    if (items.length === 0) {
      issues.push('No items extracted');
      return { valid: false, issues };
    }

    // Check for placeholder values (N/A, empty, etc.)
    const invalidValues = ['', 'N/A', 'n/a', 'TBD', 'null', 'undefined'];

    // Price validation - fail if < 90% have valid prices (strict threshold)
    const invalidPrices = items.filter((i: { price?: string }) => {
      const price = (i.price || '').trim();
      return invalidValues.includes(price) || !price;
    }).length;
    const priceRate = (items.length - invalidPrices) / items.length;
    if (priceRate < 0.9) {
      issues.push(`Only ${Math.round(priceRate * 100)}% of items have valid prices (need 90%+)`);
    }

    // Rating validation - fail if < 80% have valid ratings (strict threshold)
    const invalidRatings = items.filter((i: { rating?: string }) => {
      const rating = (i.rating || '').trim();
      return invalidValues.includes(rating) || !rating;
    }).length;
    const ratingRate = (items.length - invalidRatings) / items.length;
    if (ratingRate < 0.8) {
      issues.push(`Only ${Math.round(ratingRate * 100)}% of items have valid ratings (need 80%+)`);
    }

    return { valid: issues.length === 0, issues };
  } catch {
    return { valid: true, issues: [] }; // Can't parse, don't fail validation
  }
}

// Legacy function signature for backwards compatibility
export async function runIterativeTestFromCommands(
  commands: string[],
  originalTask: string,
  config: Config,
  customOutput?: string
): Promise<IterativeTestResult> {
  // Import the legacy generator
  const { generateBashScript } = await import('./codegen/bash-generator.js');

  // Generate script from commands
  const scriptPath = generateBashScript(commands, {
    cdpUrl: config.cdpUrl,
    outputDir: config.outputDir,
    filename: customOutput,
  });

  const scriptContent = fs.readFileSync(scriptPath, 'utf-8');

  // Run the iterative test
  return runIterativeTest(scriptContent, originalTask, config, customOutput);
}
