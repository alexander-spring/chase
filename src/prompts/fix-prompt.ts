/**
 * Generate a prompt for Claude to fix a failing script.
 * Keep it simple and focused on the actual error.
 */
export function getFixPrompt(
  originalTask: string,
  scriptContent: string,
  errorOutput: string,
  failedLineNumber?: number,
  cdpUrl?: string
): string {
  const cdpInfo = cdpUrl
    ? `\nCDP_URL is available: ${cdpUrl}\nYou can run agent-browser commands to inspect the live DOM.\n`
    : '';

  const failedLineInfo = failedLineNumber
    ? `\nThe script failed at approximately line ${failedLineNumber}.`
    : '';

  // Detect common issues
  const hasZeroItems = errorOutput.includes('extracted 0') ||
    errorOutput.includes('"totalExtracted": 0') ||
    errorOutput.includes('No items extracted');

  // Detect jq JSON parsing errors (double-encoded JSON issue)
  const hasJqError = errorOutput.includes('jq: error') ||
    errorOutput.includes('cannot be added') ||
    errorOutput.includes('cannot be subtracted') ||
    errorOutput.includes('Cannot iterate over string');

  // Handle both regular and escaped JSON patterns
  const hasEmptyPrices = (errorOutput.match(/"price":\s*""/g) || []).length > 5 ||
    (errorOutput.match(/\\"price\\":\s*\\"\\"/g) || []).length > 5;

  // Detect N/A prices and ratings (stricter validation)
  // Check both regular JSON and escaped JSON patterns
  const naPricePattern = /"price":\s*"(?:N\/A|n\/a|TBD|)"/g;
  const escapedNaPricePattern = /\\"price\\":\s*\\"(?:N\/A|n\/a|TBD|)\\"/g;
  const hasInvalidPrices = (errorOutput.match(naPricePattern) || []).length > 5 ||
    (errorOutput.match(escapedNaPricePattern) || []).length > 5 ||
    errorOutput.includes('have valid prices (need 50%+)');

  const naRatingPattern = /"rating":\s*"(?:N\/A|n\/a|TBD|)"/g;
  const escapedNaRatingPattern = /\\"rating\\":\s*\\"(?:N\/A|n\/a|TBD|)\\"/g;
  const hasInvalidRatings = (errorOutput.match(naRatingPattern) || []).length > 5 ||
    (errorOutput.match(escapedNaRatingPattern) || []).length > 5 ||
    errorOutput.includes('have valid ratings (need 30%+)');

  const is404Error = errorOutput.toLowerCase().includes('page not found') ||
    errorOutput.toLowerCase().includes('404');

  let guidance = '';

  if (hasJqError) {
    guidance += `
## CRITICAL: JSON PARSING ERROR (jq cannot process output)

The script is trying to combine incompatible JSON types. This happens because agent-browser eval returns DOUBLE-ENCODED JSON (a string containing JSON, not raw JSON).

**The Problem:**
When you do: DATA=$(agent-browser --cdp "$CDP" eval '...return JSON.stringify(items)...')
The output is a STRING like: "[{\\"name\\":\\"foo\\"}]"
NOT an array like: [{"name":"foo"}]

**The Fix - Add this unwrap_json helper at the TOP of your script:**

\`\`\`bash
# REQUIRED: Add after CDP= line
unwrap_json() {
  echo "$1" | jq -r 'if type == "string" then fromjson else . end' 2>/dev/null || echo "$1"
}
\`\`\`

**Then use it after EVERY agent-browser eval that returns JSON:**

\`\`\`bash
# WRONG:
DATA=$(agent-browser --cdp "$CDP" eval '...JSON.stringify...')

# CORRECT:
RAW_DATA=$(agent-browser --cdp "$CDP" eval '...JSON.stringify...')
DATA=$(unwrap_json "$RAW_DATA")
\`\`\`

This MUST be fixed or jq operations will always fail.
`;
  }

  if (hasZeroItems) {
    guidance += `
## CRITICAL: NO ITEMS EXTRACTED

The script is extracting 0 items. Common causes:

1. **Wrong selector** - The container selector doesn't match any elements
   Fix: Run this to find the right selector:
   agent-browser --cdp "$CDP" eval 'document.querySelectorAll("[data-component-type]").length'

2. **JavaScript error** - Syntax error in the extraction code
   Fix: Test the JavaScript in browser console first

3. **Timing issue** - Page not fully loaded
   Fix: Add more sleep time or wait for elements

4. **Wrong quotes** - Using double quotes around JavaScript causes bash escaping issues
   Fix: Use single quotes around the JavaScript in eval command

IMPORTANT: Use SINGLE QUOTES around JavaScript to avoid escaping issues:
  agent-browser --cdp "$CDP" eval '(function() { ... })();'
`;
  }

  if (hasEmptyPrices) {
    guidance += `
## EMPTY PRICES DETECTED

Many items have empty prices. For Amazon, use the .a-offscreen selector:

  var priceEl = el.querySelector(".a-price .a-offscreen");
  var price = priceEl ? priceEl.textContent.trim() : "";

The .a-offscreen element contains the full price like "$499.99".
`;
  }

  if (hasInvalidPrices) {
    guidance += `
## DATA QUALITY ISSUE: MANY PRICES ARE N/A OR MISSING

Your price selector isn't finding ALL prices. Some items may have prices in different locations (e.g., "See options", "used & new offers").

1. **First, find items missing prices and inspect their DOM:**
   agent-browser --cdp "$CDP" eval 'var items=document.querySelectorAll("YOUR_CONTAINER_SELECTOR");var missing=[];items.forEach(function(el,i){if(!el.querySelector(".a-price .a-offscreen")){missing.push({i:i,text:el.innerText.match(/[\\$CAD]+\\s*\\d+[\\d.,]*/g)})}});JSON.stringify(missing.slice(0,3))'

2. **Use comprehensive multi-fallback price extraction:**
   function getPrice(el) {
     // Try standard price selectors first
     var selectors = [
       ".a-price .a-offscreen",
       ".a-price:not([data-a-strike]) .a-offscreen",
       "[data-a-color=price] .a-offscreen"
     ];
     for (var i = 0; i < selectors.length; i++) {
       var p = el.querySelector(selectors[i]);
       if (p && /\\d/.test(p.textContent)) return p.textContent.trim();
     }
     // Fallback: search ALL text for price pattern (handles all currencies)
     var allText = el.innerText || "";
     var priceMatch = allText.match(/(?:CAD|USD|EUR|GBP|\\$|£|€)\\s*\\d+[\\d.,]*/i);
     if (priceMatch) return priceMatch[0].trim();
     return "";
   }

3. **NEVER return "N/A"** - return empty string if no price found
4. **Verify ALL items have prices** before finishing
`;
  }

  if (hasInvalidRatings) {
    guidance += `
## DATA QUALITY ISSUE: MANY RATINGS ARE N/A OR MISSING

Your rating selector isn't finding the actual ratings. You need to:

1. **Inspect the DOM to find the correct rating selector:**
   agent-browser --cdp "$CDP" eval 'document.querySelector("[data-component-type=s-search-result]")?.innerHTML?.match(/star|rating[^>]*>[^<]*/gi)?.slice(0,5)'

2. **Use multi-fallback rating extraction:**
   function getRating(el) {
     var ratingEl = el.querySelector("i.a-icon-star-small span.a-icon-alt, [class*=star] [class*=alt], span[aria-label*=star]");
     if (ratingEl) {
       var text = ratingEl.textContent || ratingEl.getAttribute("aria-label") || "";
       var match = text.match(/(\\d+\\.?\\d*)\\s*out\\s*of/i);
       if (match) return match[1];
     }
     return "";  // Return empty, not "N/A"
   }

3. **NEVER return "N/A" as a fallback** - return empty string if no rating found
`;
  }

  if (is404Error) {
    guidance += `
## 404 ERROR DETECTED

The URL doesn't exist. Try:
1. Navigate via site menu instead of direct URL
2. Use a different URL pattern
3. Search from homepage
`;
  }

  return `Fix this browser automation script.
${cdpInfo}
## Original Task
${originalTask}

## Script That Failed
\`\`\`bash
${scriptContent}
\`\`\`

## Error Output
\`\`\`
${errorOutput}
\`\`\`
${failedLineInfo}
${guidance}

## Key Fix Tips

1. **Use SINGLE quotes around JavaScript** (not double quotes):
   Good: agent-browser --cdp "$CDP" eval '(function() { ... })();'
   Bad:  agent-browser --cdp "$CDP" eval "(function() { ... })();"

2. **Avoid dollar signs in regex** - use CSS selectors instead

3. **Test selectors first**:
   agent-browser --cdp "$CDP" eval 'document.querySelectorAll("SELECTOR").length'

4. **For Amazon prices**, use .a-offscreen:
   el.querySelector(".a-price .a-offscreen")?.textContent?.trim()

Output the complete fixed bash script:

\`\`\`bash
#!/bin/bash
set -e
CDP="\${CDP_URL:?Required}"

# Your fixed script here...
\`\`\``;
}

/**
 * Parse the fixed script from Claude's response
 * Uses multiple patterns to handle variations in Claude's output format
 */
export function parseFixedScript(response: string): string | null {
  const candidates: { content: string; score: number }[] = [];

  // Helper to score a script candidate
  const scoreScript = (content: string): number => {
    let score = 0;
    if (content.includes('#!/bin/bash')) score += 100;
    if (content.includes('CDP=')) score += 50;
    if (content.includes('agent-browser --cdp')) score += 30;
    if (content.includes('open "http')) score += 20;
    if (content.includes('eval ')) score += 20;
    if (content.includes('echo "')) score += 10;
    if (content.includes('DATA=$(') || content.includes('RAW_DATA=$(')) score += 20;
    if (content.includes('totalExtracted')) score += 15;
    if (content.includes('unwrap_json')) score += 25; // Bonus for using the helper
    // Longer scripts are usually more complete
    score += Math.min(content.length / 100, 50);
    return score;
  };

  // Helper to ensure shebang is present
  const ensureShebang = (content: string): string => {
    if (!content.startsWith('#!/')) {
      return '#!/bin/bash\nset -e\n\nCDP="${CDP_URL:?Required}"\n\n' + content;
    }
    return content;
  };

  // Pattern 1: Standard code blocks with language specifier (case insensitive, flexible whitespace)
  const codeBlockPatterns = [
    /```(?:bash|sh|shell|Bash|Shell|BASH|SH)\s*\n([\s\S]*?)```/g,  // With newline
    /```(?:bash|sh|shell|Bash|Shell|BASH|SH)\s*([\s\S]*?)```/g,     // Without newline
  ];

  for (const pattern of codeBlockPatterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const content = match[1].trim();
      if (!content.includes('agent-browser')) continue;
      candidates.push({ content, score: scoreScript(content) });
    }
  }

  // Pattern 2: Generic code blocks (no language specifier)
  const genericPatterns = [
    /```\n([\s\S]*?)```/g,
    /```\s*([\s\S]*?)```/g,
  ];

  for (const pattern of genericPatterns) {
    let match;
    while ((match = pattern.exec(response)) !== null) {
      const content = match[1].trim();
      if (content.includes('agent-browser') && (content.includes('eval') || content.includes('#!/bin/bash'))) {
        candidates.push({ content, score: scoreScript(content) });
      }
    }
  }

  // Sort by score and pick the best
  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    return ensureShebang(candidates[0].content);
  }

  // Fallback 1: If no code block, check if response starts with shebang
  if (response.trim().startsWith('#!/bin/bash')) {
    // Find where the script ends (next code block marker or end of content)
    let script = response.trim();
    const endMarker = script.indexOf('\n```');
    if (endMarker !== -1) {
      script = script.substring(0, endMarker);
    }
    return script.trim();
  }

  // Fallback 2: Try to find script content starting from shebang anywhere in response
  const shebangIndex = response.indexOf('#!/bin/bash');
  if (shebangIndex !== -1) {
    let script = response.substring(shebangIndex);
    // Look for end markers
    const endMarkers = ['\n```', '\n\n---', '\n## '];
    let endIndex = script.length;
    for (const marker of endMarkers) {
      const idx = script.indexOf(marker);
      if (idx !== -1 && idx < endIndex) {
        endIndex = idx;
      }
    }
    script = script.substring(0, endIndex);
    if (script.includes('agent-browser')) {
      return script.trim();
    }
  }

  // Fallback 3: Look for script fragments that can be reconstructed
  // Some responses have the script broken into explanation sections
  const scriptFragmentPattern = /agent-browser\s+--cdp\s+[^\n]+/g;
  const fragments = response.match(scriptFragmentPattern);
  if (fragments && fragments.length >= 2) {
    // There are multiple agent-browser commands, might be a script without proper code block
    // Try to extract from a larger context
    const lines = response.split('\n');
    const scriptLines: string[] = [];
    let inScript = false;

    for (const line of lines) {
      if (line.includes('#!/bin/bash') || line.includes('set -e')) {
        inScript = true;
      }
      if (inScript) {
        // Stop at common non-script indicators
        if (line.match(/^[A-Z][a-z].*:$/) || line.startsWith('Note:') || line.startsWith('This ')) {
          break;
        }
        scriptLines.push(line);
      }
    }

    if (scriptLines.length > 5 && scriptLines.some(l => l.includes('agent-browser'))) {
      return ensureShebang(scriptLines.join('\n').trim());
    }
  }

  return null;
}
