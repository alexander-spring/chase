import { getHelperReference } from './helpers.js';
import { formatIterationHistory, type IterationHistory } from '../types/iteration-history.js';
import {
  classifyErrors,
  formatClassifiedErrors,
  getGuidanceForError,
  type ClassifiedError,
} from '../errors/error-classifier.js';

/**
 * Generate a prompt for Claude to fix a failing script.
 * Keep it simple and focused on the actual error.
 */
export function getFixPrompt(
  originalTask: string,
  scriptContent: string,
  errorOutput: string,
  failedLineNumber?: number,
  cdpUrl?: string,
  history?: IterationHistory
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

  // Detect wrong selector issues (targeting ads/carousel instead of main grid)
  const hasWrongSelector = errorOutput.includes('WRONG_SELECTOR') ||
    errorOutput.includes('same item') ||
    errorOutput.includes('targeting a carousel') ||
    errorOutput.includes('targeting a sticky element') ||
    (errorOutput.includes('Only') && errorOutput.includes('items') && errorOutput.includes('incomplete'));

  // Detect low item count per page (sign of wrong selector)
  const lowItemCounts = errorOutput.match(/Found (\d+) items on page/g);
  const hasLowItemCounts = lowItemCounts && lowItemCounts.some(m => {
    const count = parseInt(m.match(/(\d+)/)?.[1] || '100', 10);
    return count < 10;
  });

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

  if (hasWrongSelector || hasLowItemCounts) {
    guidance += `
## CRITICAL: WRONG SELECTOR (Targeting Ads/Carousel Instead of Main Grid)

Your selector is finding items from a sponsored/ads carousel or sidebar, NOT the main product grid.
Evidence: Same item appearing on multiple pages, or very few items (< 10) per page.

**The Problem:**
E-commerce pages have multiple product containers:
1. Sponsored/ad carousels (small, sticky, don't change with pagination)
2. Main product grid (20-50 items per page, changes with pagination)

**How to Fix - Use Universal Discovery:**

1. **Use findProductGrid() to find the main container:**
   \`\`\`javascript
   function findProductGrid() {
     var best = null;
     var containers = document.querySelectorAll("main, section, [role=main], div");
     for (var i = 0; i < containers.length; i++) {
       var c = containers[i];
       var children = c.children;
       if (children.length < 15) continue;
       var firstTag = children[0] ? children[0].tagName : null;
       if (!firstTag) continue;
       var sameCount = 0;
       for (var j = 0; j < children.length; j++) {
         if (children[j].tagName === firstTag) sameCount++;
       }
       if (sameCount >= 15 && (!best || sameCount > best.count)) {
         best = { el: c, count: sameCount };
       }
     }
     return best ? best.el : null;
   }
   \`\`\`

2. **Try universal semantic selectors (test each, pick the one with MOST items 20-50):**
   - Schema.org: \`[itemtype*="Product"]\`
   - ARIA: \`[role="listitem"]\`
   - Data attributes: \`[data-testid*="product"]\`, \`[data-automation-id*="product"]\`
   - Structural: \`[class*="product-card"]\`, \`[class*="search-result"]\`

3. **Verify it's not ads** - check if items have "sponsored" class or are position:fixed

4. **After pagination, verify items CHANGED** - if same items appear, wrong selector
`;
  }

  // Detect fragile site-specific selectors (auto-generated class names like .w_V_DM, .a2_x4)
  const hasFragileSelectors = /\.\w{1,3}_[A-Za-z0-9]{2,}/.test(scriptContent) ||
    /\.a-offscreen/.test(scriptContent) ||
    /span\.a-icon-alt/.test(scriptContent);

  if (hasFragileSelectors) {
    guidance += `
## WARNING: FRAGILE SITE-SPECIFIC SELECTORS DETECTED

Your script uses auto-generated class names (like \`.w_V_DM\`, \`.a-offscreen\`) that are:
- Specific to one site and can change without notice
- Not portable to other e-commerce sites
- Prone to breaking when the site updates

**Replace with Universal Selectors:**

Instead of site-specific classes, use:
1. Schema.org: \`[itemprop="price"]\`, \`[itemprop="name"]\`, \`[itemprop="ratingValue"]\`
2. ARIA: \`[aria-label*="price"]\`, \`[aria-label*="rating"]\`
3. Data attributes: \`[data-price]\`, \`[data-rating]\`, \`[data-value]\`
4. Text patterns: Extract from innerText using regex for currency/rating patterns

**Use the universal helper functions (getPrice, getRating, getName) that try multiple discovery methods.**
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

Many items have empty prices. Use the universal getPrice() function that tries multiple discovery methods:

1. Schema.org: \`[itemprop="price"]\` with content attribute or textContent
2. Data attributes: \`[data-price]\`, \`[data-automation-id*="price"]\`
3. ARIA labels: \`[aria-label*="price"]\`
4. Class patterns: \`[class*="price"]\` (excluding crossed-out/original prices)
5. Text patterns: Currency symbols followed by numbers

Make sure you're using the universal getPrice() helper function in your extraction code.
`;
  }

  if (hasInvalidPrices) {
    guidance += `
## DATA QUALITY ISSUE: MANY PRICES ARE N/A OR MISSING

Your price selector isn't finding ALL prices. Use the universal getPrice() function that tries multiple discovery methods.

1. **First, inspect how prices appear in the DOM:**
   agent-browser --cdp "$CDP" eval 'var el=document.querySelector("YOUR_CONTAINER_SELECTOR");var html=el?.innerHTML||"";JSON.stringify({hasItemprop:html.includes("itemprop"),hasDataPrice:html.includes("data-price"),hasPriceClass:html.includes("price"),sample:html.substring(0,1000)})'

2. **Use the universal getPrice function (tries multiple discovery methods):**
   \`\`\`javascript
   function getPrice(el) {
     // 1. Schema.org markup
     var schema = el.querySelector("[itemprop=price]");
     if (schema) {
       var val = schema.getAttribute("content") || schema.textContent;
       if (val && /\\d/.test(val)) return val.trim();
     }
     // 2. Data attributes
     var dataPrice = el.querySelector("[data-price], [data-automation-id*=price]");
     if (dataPrice) {
       var val2 = dataPrice.getAttribute("data-price") || dataPrice.textContent;
       if (val2 && /\\d/.test(val2)) return val2.trim();
     }
     // 3. ARIA labels with price
     var ariaPrice = el.querySelector("[aria-label*=price]");
     if (ariaPrice) {
       var label = ariaPrice.getAttribute("aria-label") || "";
       var m = label.match(/[\\$\\u00A3\\u20AC]\\s*[\\d,.]+/);
       if (m) return m[0].trim();
     }
     // 4. Common price class patterns
     var priceEl = el.querySelector("[class*=price]:not([class*=crossed]):not([class*=was])");
     if (priceEl && /[\\$\\u00A3\\u20AC]/.test(priceEl.textContent)) {
       var m2 = priceEl.textContent.match(/[\\$\\u00A3\\u20AC]\\s*[\\d,.]+/);
       if (m2) return m2[0].trim();
     }
     // 5. Text pattern fallback
     var text = el.innerText || "";
     var match = text.match(/(?:[\\$\\u00A3\\u20AC]|USD|CAD|EUR|GBP)\\s*[\\d,.]+/i);
     return match ? match[0].trim() : "";
   }
   \`\`\`

3. **NEVER return "N/A"** - return empty string if no price found
`;
  }

  if (hasInvalidRatings) {
    guidance += `
## DATA QUALITY ISSUE: MANY RATINGS ARE N/A OR MISSING

Your rating selector isn't finding the actual ratings. Use the universal getRating() function that tries multiple discovery methods.

1. **First, inspect how ratings appear in the DOM:**
   agent-browser --cdp "$CDP" eval 'var el=document.querySelector("YOUR_CONTAINER_SELECTOR");var html=el?.innerHTML||"";JSON.stringify({hasItemprop:html.includes("ratingValue"),hasDataRating:html.includes("data-rating")||html.includes("data-value"),hasAriaLabel:html.includes("aria-label"),sample:html.substring(0,1000)})'

2. **Use the universal getRating function (tries multiple discovery methods):**
   \`\`\`javascript
   function getRating(el) {
     // 1. Schema.org markup
     var schema = el.querySelector("[itemprop=ratingValue]");
     if (schema) {
       var val = schema.getAttribute("content") || schema.textContent;
       if (val && /\\d/.test(val)) return val.trim();
     }
     // 2. Data attributes (data-rating, data-value)
     var dataRating = el.querySelector("[data-rating], [data-value]");
     if (dataRating) {
       var val2 = dataRating.getAttribute("data-rating") || dataRating.getAttribute("data-value");
       if (val2 && /^\\d+\\.?\\d*$/.test(val2)) return val2;
     }
     // 3. ARIA labels ("4.5 out of 5 stars", "4.5 stars")
     var ariaEls = el.querySelectorAll("[aria-label]");
     for (var i = 0; i < ariaEls.length; i++) {
       var label = ariaEls[i].getAttribute("aria-label") || "";
       var m = label.match(/(\\d+\\.?\\d*)\\s*(?:out of|stars?)/i);
       if (m) return m[1];
     }
     // 4. Text pattern ("4.5 out of 5")
     var text = el.innerText || "";
     var m2 = text.match(/(\\d+\\.?\\d*)\\s*out\\s*of\\s*5/i);
     if (m2) return m2[1];
     return "";
   }
   \`\`\`

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

  // Use error classifier for structured error analysis
  const classifiedErrors = classifyErrors(errorOutput, '', null, false);
  let classifiedGuidance = '';
  if (classifiedErrors.length > 0) {
    // Add targeted guidance for the primary error
    classifiedGuidance = getGuidanceForError(classifiedErrors[0]);
  }

  // Format iteration history if available
  const historySection = history ? formatIterationHistory(history) : '';

  return `Fix this browser automation script.
${cdpInfo}
## Original Task
${originalTask}
${historySection}
## Script That Failed
\`\`\`bash
${scriptContent}
\`\`\`

## Error Output
\`\`\`
${errorOutput}
\`\`\`
${failedLineInfo}
${classifiedGuidance}
${guidance}

## Key Fix Tips

1. **Use SINGLE quotes around JavaScript** (not double quotes):
   Good: agent-browser --cdp "$CDP" eval '(function() { ... })();'
   Bad:  agent-browser --cdp "$CDP" eval "(function() { ... })();"

2. **Avoid dollar signs in regex** - use CSS selectors instead

3. **Test selectors first**:
   agent-browser --cdp "$CDP" eval 'document.querySelectorAll("SELECTOR").length'

4. ${getHelperReference()}

5. **Avoid fragile site-specific selectors** like .a-offscreen, .w_V_DM - they break when sites update

IMPORTANT: You MUST output a complete, working bash script in a code block. Do not just explain - output the actual fixed script.

\`\`\`bash
#!/bin/bash
set -e
CDP="\${CDP_URL:?Required}"

# Your complete fixed script here - include ALL code, not just the changed parts
\`\`\`

After outputting the script, do not add any more text.`;
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
