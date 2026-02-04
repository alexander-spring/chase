<div align="center">
<pre>
                   /\_/\
                  ( o.o )
                   > ^ <

   _____ _    _           _____ ______
  / ____| |  | |   /\    / ____|  ____|
 | |    | |__| |  /  \  | (___ | |__
 | |    |  __  | / /\ \  \___ \|  __|
 | |____| |  | |/ ____ \ ____) | |____
  \_____|_|  |_/_/    \_\_____/|______|
</pre>

<strong>Automate any website with natural language.</strong>

<br>

[![npm](https://img.shields.io/npm/v/@browsercash/chase)](https://www.npmjs.com/package/@browsercash/chase)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

---

Tell Chase what to do — it opens a real browser, navigates pages, interacts with elements, and returns structured JSON.

## Quick Start

```bash
npm install -g @browsercash/chase
export BROWSER_CASH_API_KEY="your-key"   # https://browser.cash
```

```bash
chase automate "Get the top 5 stories from Hacker News with title, points, and URL"
```

```json
{
  "success": true,
  "result": {
    "stories": [
      { "title": "Show HN: ...", "points": 342, "url": "https://..." }
    ]
  }
}
```

## Commands

```bash
# One-off automation
chase automate "Find AirPods Pro price on Amazon"
chase automate "Get 5 homes in Austin TX under 400k" --country US

# Generate reusable scripts
chase generate "Scrape today's deals from slickdeals.net"
chase scripts                    # List saved scripts
chase run script-abc123          # Run a saved script

# Task management
chase tasks                      # List recent tasks
chase task task-xyz789           # Get task details
```

### Options

| Flag | Description |
|------|-------------|
| `--country <code>` | Browser geo-location (US, DE, JP, ...) |
| `--type <type>` | Node type: `consumer_distributed`, `hosted`, `testing` |
| `--adblock` | Block ads |
| `--captcha` | Auto-solve CAPTCHAs |
| `--json` | JSON output only (default) |
| `--pretty` | Human-readable output |
| `--verbose` | Show debug logs |
| `--max-turns <n>` | Max AI turns (default: 30) |

## Integrations

### Claude Code (Skill)

```bash
curl -fsSL https://raw.githubusercontent.com/alexander-spring/chase/main/skill/install.sh | bash
```

Then ask Claude: *"Use chase to get the top posts from Reddit r/programming"*

### Claude Desktop / Cursor (MCP)

Add to your MCP config:

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

Base: `https://chase-api-264851422957.us-central1.run.app`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/automate/stream` | POST | Run a task (SSE) |
| `/generate/stream` | POST | Generate a script (SSE) |
| `/scripts` | GET | List scripts |
| `/scripts/:id` | GET | Get script details |
| `/scripts/:id/run` | POST | Run a script (SSE) |
| `/tasks` | GET | List tasks |
| `/tasks/:id` | GET | Get task details |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP transport |

```bash
curl -N -X POST https://chase-api-264851422957.us-central1.run.app/automate/stream \
  -H "Content-Type: application/json" \
  -d '{"task": "Get the title of example.com", "browserCashApiKey": "your-key"}'
```

## Self-Hosting

```bash
git clone https://github.com/alexander-spring/chase.git && cd chase
npm install && npm run build
ANTHROPIC_API_KEY=sk-... npm run start:server
```

## License

MIT
