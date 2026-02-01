/**
 * Centralized helper function definitions for browser automation scripts.
 * These are used in both system-prompt.ts and fix-prompt.ts to avoid duplication.
 *
 * Token savings: ~49% reduction by defining once instead of 3-4x
 */

/**
 * Universal helper function: getPrice
 * Tries multiple discovery methods to extract price from a product element.
 */
export const GET_PRICE_FUNCTION = `function getPrice(el) {
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
  var priceEl = el.querySelector("[class*=price]:not([class*=crossed]):not([class*=was]):not([class*=original])");
  if (priceEl && /[\\$\\u00A3\\u20AC]/.test(priceEl.textContent)) {
    var m2 = priceEl.textContent.match(/[\\$\\u00A3\\u20AC]\\s*[\\d,.]+/);
    if (m2) return m2[0].trim();
  }

  // 5. Text pattern fallback (currency + number)
  var text = el.innerText || "";
  var match = text.match(/(?:[\\$\\u00A3\\u20AC]|USD|CAD|EUR|GBP)\\s*[\\d,.]+/i);
  return match ? match[0].trim() : "";
}`;

/**
 * Compact version of getPrice for inline use in extraction scripts.
 */
export const GET_PRICE_COMPACT = `function getPrice(el) {
  var schema = el.querySelector("[itemprop=price]");
  if (schema) { var v = schema.getAttribute("content") || schema.textContent; if (v && /\\d/.test(v)) return v.trim(); }
  var dataPrice = el.querySelector("[data-price], [data-automation-id*=price]");
  if (dataPrice) { var v2 = dataPrice.getAttribute("data-price") || dataPrice.textContent; if (v2 && /\\d/.test(v2)) return v2.trim(); }
  var priceEl = el.querySelector("[class*=price]:not([class*=crossed]):not([class*=was])");
  if (priceEl && /[\\$\\u00A3\\u20AC]/.test(priceEl.textContent)) { var m = priceEl.textContent.match(/[\\$\\u00A3\\u20AC]\\s*[\\d,.]+/); if (m) return m[0].trim(); }
  var text = el.innerText || ""; var match = text.match(/(?:[\\$\\u00A3\\u20AC]|USD|CAD|EUR|GBP)\\s*[\\d,.]+/i);
  return match ? match[0].trim() : "";
}`;

/**
 * Universal helper function: getRating
 * Tries multiple discovery methods to extract rating from a product element.
 */
export const GET_RATING_FUNCTION = `function getRating(el) {
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
}`;

/**
 * Compact version of getRating for inline use in extraction scripts.
 */
export const GET_RATING_COMPACT = `function getRating(el) {
  var schema = el.querySelector("[itemprop=ratingValue]");
  if (schema) { var v = schema.getAttribute("content") || schema.textContent; if (v && /\\d/.test(v)) return v.trim(); }
  var dataRating = el.querySelector("[data-rating], [data-value]");
  if (dataRating) { var v2 = dataRating.getAttribute("data-rating") || dataRating.getAttribute("data-value"); if (v2 && /^\\d+\\.?\\d*$/.test(v2)) return v2; }
  var ariaEls = el.querySelectorAll("[aria-label]");
  for (var i = 0; i < ariaEls.length; i++) { var label = ariaEls[i].getAttribute("aria-label") || ""; var m = label.match(/(\\d+\\.?\\d*)\\s*(?:out of|stars?)/i); if (m) return m[1]; }
  var text = el.innerText || ""; var m2 = text.match(/(\\d+\\.?\\d*)\\s*out\\s*of\\s*5/i); if (m2) return m2[1];
  return "";
}`;

/**
 * Universal helper function: getName
 * Tries multiple discovery methods to extract product name from an element.
 */
export const GET_NAME_FUNCTION = `function getName(el) {
  // 1. Schema.org markup
  var schema = el.querySelector("[itemprop=name]");
  if (schema) return schema.textContent.trim();

  // 2. Heading elements
  var heading = el.querySelector("h2, h3, h4");
  if (heading) return heading.textContent.trim();

  // 3. Title/name class patterns
  var titleEl = el.querySelector("[class*=title], [class*=name], [class*=heading]");
  if (titleEl) return titleEl.textContent.trim();

  // 4. First link text (often the product name)
  var link = el.querySelector("a[href]");
  if (link && link.textContent.trim().length > 5) return link.textContent.trim();

  return "";
}`;

/**
 * Compact version of getName for inline use in extraction scripts.
 */
export const GET_NAME_COMPACT = `function getName(el) {
  var schema = el.querySelector("[itemprop=name]"); if (schema) return schema.textContent.trim();
  var heading = el.querySelector("h2, h3, h4"); if (heading) return heading.textContent.trim();
  var titleEl = el.querySelector("[class*=title], [class*=name]"); if (titleEl) return titleEl.textContent.trim();
  var link = el.querySelector("a[href]"); if (link && link.textContent.trim().length > 5) return link.textContent.trim();
  return "";
}`;

/**
 * Universal helper function: findProductGrid
 * Finds the container with the most repeated child elements (the product grid).
 */
export const FIND_PRODUCT_GRID_FUNCTION = `function findProductGrid() {
  // Find the container with the most repeated child elements (product grid)
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
}`;

/**
 * JSON unwrap helper - handles double-encoded JSON from agent-browser eval.
 */
export const UNWRAP_JSON_HELPER = `unwrap_json() {
  echo "$1" | jq -r 'if type == "string" then fromjson else . end' 2>/dev/null || echo "$1"
}`;

/**
 * Get all helper functions as a single block for inclusion in bash scripts.
 */
export function getJsHelperFunctions(): string {
  return `  // Universal helper functions - copy these exactly
  ${GET_PRICE_COMPACT}
  ${GET_NAME_COMPACT}
  ${GET_RATING_COMPACT}`;
}

/**
 * Get helper function definitions for documentation/guidance sections.
 */
export function getHelperDocumentation(): string {
  return `
**REQUIRED - getPrice function (copy exactly):**
\`\`\`javascript
${GET_PRICE_FUNCTION}
\`\`\`

**REQUIRED - getRating function (copy exactly):**
\`\`\`javascript
${GET_RATING_FUNCTION}
\`\`\`

**REQUIRED - getName function (copy exactly):**
\`\`\`javascript
${GET_NAME_FUNCTION}
\`\`\`

**REQUIRED - findProductGrid function (copy exactly):**
\`\`\`javascript
${FIND_PRODUCT_GRID_FUNCTION}
\`\`\`
`;
}

/**
 * Get a brief reference to helpers (for fix prompts where full docs aren't needed).
 */
export function getHelperReference(): string {
  return `Use the universal helper functions (getPrice, getRating, getName, findProductGrid) that try:
- Schema.org: [itemprop="price"], [itemprop="ratingValue"], [itemprop="name"]
- Data attributes: [data-price], [data-rating], [data-value]
- ARIA labels: [aria-label*="price"], [aria-label*="stars"]
- Text patterns: Currency symbols, "X out of 5" patterns
- Structural: Heading elements (h2, h3), class patterns (*title*, *name*)`;
}
