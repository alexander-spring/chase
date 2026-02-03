# Chase

AI-powered browser automation - extract data from any website using natural language.

## Features

- **Natural Language Automation**: Describe what you want in plain English
- **Agentic Mode**: AI performs tasks directly and returns structured results
- **Script Generation**: Generate reusable bash scripts for repeated tasks
- **MCP Integration**: Works with Claude Desktop, Cursor, and other MCP clients
- **CLI Tool**: Full-featured command-line interface
- **Claude Code Skill**: Seamless integration with Claude Code

## Quick Start

### Option 1: CLI (Recommended)

```bash
# Install globally
npm install -g chase-browser

# Set your API key
export BROWSER_CASH_API_KEY="your-key"

# Run automation
chase automate "Get the top 10 stories from Hacker News"
```

### Option 2: Claude Code Skill

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/alexander-spring/chase/main/skill/install.sh | bash

# Set your API key
export BROWSER_CASH_API_KEY="your-key"

# Then just ask Claude to extract data from any website!
```

### Option 3: MCP Server

Add to Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "chase": {
      "transport": "http",
      "url": "https://chase-api-gth2quoxyq-uc.a.run.app/mcp",
      "headers": {
        "x-api-key": "YOUR_API_KEY"
      }
    }
  }
}
```

## Get an API Key

Get your Browser.cash API key at: **https://browser.cash**

---

## CLI Usage

```bash
chase <command> [options]
```

| Command | Description |
|---------|-------------|
| `automate <task>` | Perform a one-off browser automation task |
| `generate <task>` | Generate a reusable automation script |
| `scripts` | List your saved scripts |
| `run <script-id>` | Run a saved script |
| `tasks` | List your recent tasks |
| `task <task-id>` | Get details of a specific task |
| `help` | Show help message |

### Examples

```bash
# One-off automation
chase automate "Go to example.com and get the page title"
chase automate "Extract the top 10 stories from Hacker News"
chase automate "Get the price of PlayStation 5 on Best Buy"

# With options
chase automate "Get products from amazon.de" --country DE --adblock

# Generate reusable scripts
chase generate "Scrape product prices from amazon.com"

# List and run saved scripts
chase scripts
chase run script-abc123

# Check task status
chase tasks
chase task task-xyz789
```

### CLI Options

| Option | Description |
|--------|-------------|
| `--country <code>` | Use browser from specific country (US, DE, JP, etc.) |
| `--adblock` | Enable ad-blocking |
| `--captcha` | Enable CAPTCHA solving |
| `--quiet` | Reduce output verbosity |
| `--skip-test` | Skip script testing (generate only) |

---

## HTTP API

Base URL: `https://chase-api-gth2quoxyq-uc.a.run.app`

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/automate/stream` | POST | One-off browser automation (SSE) |
| `/generate/stream` | POST | Generate reusable script (SSE) |
| `/scripts` | GET | List saved scripts |
| `/scripts/:id` | GET | Get script details |
| `/scripts/:id/run` | POST | Run a saved script (SSE) |
| `/tasks` | GET | List recent tasks |
| `/tasks/:id` | GET | Get task status |
| `/mcp` | POST | MCP HTTP endpoint |

### Authentication

| Endpoint Type | Method |
|---------------|--------|
| POST endpoints | Include `browserCashApiKey` in request body |
| GET endpoints | Use `x-api-key` header or `apiKey` query param |

### Example: Automate Task

```bash
curl -N -X POST "https://chase-api-gth2quoxyq-uc.a.run.app/automate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to example.com and get the page title",
    "browserCashApiKey": "your-api-key"
  }'
```

### Browser Options

```json
{
  "browserCashApiKey": "your-key",
  "browserOptions": {
    "country": "US",
    "adblock": true,
    "captchaSolver": true
  }
}
```

---

## MCP Server

### Hosted HTTP (Recommended)

```bash
claude mcp add --transport http chase https://chase-api-gth2quoxyq-uc.a.run.app/mcp -H "x-api-key: YOUR_KEY"
```

### Local stdio

```bash
git clone https://github.com/alexander-spring/chase.git
cd chase/mcp-server && npm install && npm run build
claude mcp add chase node ./dist/index.js -e BROWSER_CASH_API_KEY=YOUR_KEY
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `browser_automate` | Perform one-off browser automation |
| `generate_script` | Generate reusable automation scripts |
| `list_scripts` | List saved scripts |
| `get_script` | Get script by ID |
| `run_script` | Execute a saved script |
| `get_task` | Get task status |
| `list_tasks` | List recent tasks |

---

## Local Development

### Prerequisites

- Node.js 20+
- [agent-browser](https://github.com/anthropics/agent-browser) CLI
- [Claude CLI](https://github.com/anthropics/claude-code)

### Setup

```bash
git clone https://github.com/alexander-spring/chase.git
cd chase
npm install
npm run build
```

### Local Script Generation

For local development with your own browser:

```bash
# Start a browser with CDP enabled
agent-browser daemon

# Generate a script locally
CDP_URL="ws://localhost:9222/devtools/browser/..." npx chase-local "Go to example.com"
```

### Run API Server Locally

```bash
npm run start:server
```

---

## Deployment

### Google Cloud Run

```bash
# Set project
export PROJECT_ID=your-project

# Enable APIs
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com secretmanager.googleapis.com

# Create Anthropic API key secret
echo -n "your-anthropic-key" | gcloud secrets create anthropic-api-key --data-file=-

# Deploy
gcloud builds submit --config cloudbuild.yaml
```

---

## License

MIT
