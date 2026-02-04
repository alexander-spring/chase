# Chase

**AI browser automation** - Tell it what you want, get structured data back.

Chase uses Claude to control a real browser and extract data from any website. No selectors, no brittle scripts - just describe what you need in plain English.

## Example

```bash
chase automate "Find 5 homes in Austin TX under 400k with 3+ bedrooms. \
  Return address, price, beds, baths, sqft, and listing URL"
```

**Output:**
```json
{
  "success": true,
  "data": [
    {
      "address": "1234 Oak St, Austin, TX 78701",
      "price": "$385,000",
      "beds": 3,
      "baths": 2,
      "sqft": 1850,
      "url": "https://zillow.com/..."
    }
  ]
}
```

## Install

```bash
npm install -g @browsercash/chase
export BROWSER_CASH_API_KEY="your-key"  # Get one at https://browser.cash
```

## Usage

### One-off Tasks

```bash
# Extract data from any website
chase automate "Get the top 10 stories from Hacker News with title, points, and URL"

# Scrape product info
chase automate "Find the price of AirPods Pro on Amazon"

# Research tasks
chase automate "Get the current weather in Tokyo"
```

### Options

```bash
chase automate "task" --country US    # Browser location
chase automate "task" --adblock       # Block ads
chase automate "task" --captcha       # Auto-solve CAPTCHAs
chase automate "task" --model haiku   # Use faster/cheaper model (haiku, sonnet, opus)
```

### Generate Reusable Scripts

```bash
# Create a script you can run repeatedly
chase generate "Scrape today's deals from slickdeals.net"

# List your scripts
chase scripts

# Run a saved script
chase run script-abc123
```

## Use with Claude Code

Add Chase as a skill to use it directly in Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/anthropics/chase/main/skill/install.sh | bash
```

Then just ask Claude: *"Use chase to get the top posts from Reddit r/programming"*

## Use with Claude Desktop (MCP)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chase": {
      "transport": "http",
      "url": "https://chase-api-264851422957.us-central1.run.app/mcp",
      "headers": { "x-api-key": "YOUR_API_KEY" }
    }
  }
}
```

## API

Base URL: `https://chase-api-264851422957.us-central1.run.app`

### Automate (SSE streaming)

```bash
curl -N -X POST https://chase-api-264851422957.us-central1.run.app/automate/stream \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Get the title of example.com",
    "browserCashApiKey": "your-key"
  }'
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /automate/stream` | Run a task, get structured results (SSE) |
| `POST /generate/stream` | Generate a reusable script (SSE) |
| `GET /scripts` | List saved scripts |
| `POST /scripts/:id/run` | Run a saved script |
| `GET /tasks/:id` | Get task result by ID |
| `GET /health` | Health check |

## How It Works

1. Chase spins up a real browser via [Browser.cash](https://browser.cash)
2. Claude navigates the page, clicks buttons, fills forms, waits for content
3. Claude extracts the data you asked for and returns structured JSON
4. Browser session is cleaned up automatically

## Self-Hosting

```bash
git clone https://github.com/anthropics/chase.git
cd chase
npm install && npm run build

# Run locally
ANTHROPIC_API_KEY=your-key npm run start:server

# Or deploy to Cloud Run
gcloud builds submit --config cloudbuild.yaml
```

## License

MIT
