# claude-gen

A CLI tool that uses Claude to generate replay-safe browser automation scripts for web scraping.

## Prerequisites

- Node.js 18+
- [agent-browser](https://github.com/anthropics/agent-browser) installed and available in PATH
- [Claude CLI](https://github.com/anthropics/claude-code) installed
- `jq` for JSON processing

## Installation

```bash
git clone https://github.com/alexander-spring/claude-gen.git
cd claude-gen
npm install
npm run build
```

## Configuration

Create a `.env` file in the project root:

```bash
ANTHROPIC_API_KEY=your_api_key_here
```

## Usage

### Basic Usage

1. Start a browser with CDP (Chrome DevTools Protocol) enabled:

```bash
agent-browser daemon
```

2. Run claude-gen with your task:

```bash
CDP_URL="ws://localhost:9222/devtools/browser/..." npx claude-gen "Go to amazon.com and extract the top 50 products for 'laptop'"
```

### Command Line Options

```bash
npx claude-gen [options] "<task description>"
```

**Options:**
- `-o, --output <filename>` - Custom output filename for the generated script
- `-m, --model <model>` - Claude model to use (default: claude-sonnet-4-20250514)
- `--max-turns <n>` - Maximum turns for script generation (default: 15)
- `--max-fix-iterations <n>` - Maximum fix attempts if script fails (default: 5)
- `--timeout <ms>` - Script execution timeout in milliseconds (default: 120000)

### Examples

**Extract product listings from Amazon:**
```bash
CDP_URL="$CDP" npx claude-gen "Go to amazon.com and search for 'ps5', then extract 50 product details including name, price, rating, and URL"
```

**Scrape cryptocurrency data:**
```bash
CDP_URL="$CDP" npx claude-gen "Extract the top 100 tokens from coinmarketcap.com with their name, price, market cap, and 24h change"
```

**Extract from any e-commerce site:**
```bash
CDP_URL="$CDP" npx claude-gen "Go to bestbuy.com and extract all laptop deals with prices under $500"
```

## How It Works

1. **Script Generation**: Claude analyzes the target website using `agent-browser snapshot` and generates a bash script with appropriate selectors

2. **Iterative Testing**: The generated script is executed and validated for:
   - Successful extraction (non-empty results)
   - Data quality (>90% items with prices, >80% with ratings)
   - No runtime errors

3. **Auto-Fix Loop**: If the script fails, Claude automatically analyzes the error and generates a fixed version (up to 5 iterations)

4. **Output**: The final working script is saved to the `generated/` directory

## Generated Script Structure

Scripts follow this pattern:

```bash
#!/bin/bash
set -e
CDP="${CDP_URL:?Required: CDP_URL}"

# JSON unwrapping helper (handles agent-browser eval output)
unwrap_json() {
  echo "$1" | jq -r 'if type == "string" then fromjson else . end' 2>/dev/null || echo "$1"
}

# Navigate to target
agent-browser --cdp "$CDP" open "https://example.com"
sleep 3

# Extract data with scroll handling
RAW_DATA=$(agent-browser --cdp "$CDP" eval '...')
DATA=$(unwrap_json "$RAW_DATA")

echo "$DATA"
```

## Output Format

Extracted data is output as JSON:

```json
{
  "totalExtracted": 50,
  "items": [
    {
      "name": "Product Name",
      "price": "$99.99",
      "rating": "4.5",
      "url": "https://..."
    }
  ]
}
```

## Troubleshooting

### "jq: error - array and string cannot be added"

This happens when the script doesn't handle agent-browser's double-encoded JSON output. The generated scripts should include the `unwrap_json()` helper function. If you see this error, regenerate the script.

### "CDP connection unavailable"

The browser session has closed or the CDP URL is stale. Restart `agent-browser daemon` and use the new CDP URL.

### Low extraction rate

If prices or ratings are missing:
1. The website may require login or has anti-bot protection
2. Try a different search term or category
3. Some items genuinely don't have prices displayed (e.g., "See options")

## License

MIT
