# Claude-Gen MCP Server

An MCP (Model Context Protocol) server for browser automation using the claude-gen API. This server can be used with Claude Desktop, Cursor, or any other MCP-compatible client.

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BROWSER_CASH_API_KEY` | Default Browser.cash API key | Optional (can pass per-tool) |
| `CLAUDE_GEN_API_URL` | API base URL | Optional (defaults to production) |

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "claude-gen": {
      "command": "node",
      "args": ["/path/to/claude-gen/mcp-server/dist/index.js"],
      "env": {
        "BROWSER_CASH_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Cursor Configuration

Add to your Cursor MCP settings:

```json
{
  "claude-gen": {
    "command": "node",
    "args": ["/path/to/claude-gen/mcp-server/dist/index.js"],
    "env": {
      "BROWSER_CASH_API_KEY": "your-api-key"
    }
  }
}
```

## Available Tools

### `browser_automate`

Perform one-off browser automation tasks. Claude navigates to websites, interacts with elements, and extracts data directly.

**Parameters:**
- `task` (required): Description of the automation task
- `apiKey`: Browser.cash API key (or use `cdpUrl`)
- `cdpUrl`: Direct CDP WebSocket URL (or use `apiKey`)
- `browserOptions`: Browser session options (country, adblock, captchaSolver)
- `waitForCompletion`: Wait for results (default: false)
- `maxWaitSeconds`: Max wait time (default: 120)

**Example:**
```
Use browser_automate to go to news.ycombinator.com and extract the top 5 story titles
```

### `generate_script`

Generate a reusable automation script that can be run multiple times.

**Parameters:**
- `task` (required): Description of what the script should do
- `apiKey`: Browser.cash API key (or use `cdpUrl`)
- `cdpUrl`: Direct CDP WebSocket URL (or use `apiKey`)
- `browserOptions`: Browser session options
- `skipTest`: Skip iterative testing (default: false)
- `waitForCompletion`: Wait for script generation (default: false)
- `maxWaitSeconds`: Max wait time (default: 300)

### `list_scripts`

List all stored automation scripts.

**Parameters:**
- `apiKey` (required): Browser.cash API key

### `get_script`

Get details of a specific script including content.

**Parameters:**
- `scriptId` (required): The script ID
- `apiKey` (required): Browser.cash API key

### `run_script`

Execute a stored automation script.

**Parameters:**
- `scriptId` (required): The script ID to run
- `apiKey`: Browser.cash API key (or use `cdpUrl`)
- `cdpUrl`: Direct CDP WebSocket URL (or use `apiKey`)
- `browserOptions`: Browser session options
- `waitForCompletion`: Wait for execution (default: false)
- `maxWaitSeconds`: Max wait time (default: 120)

### `get_task`

Get the status and result of a task by ID. Use this to poll for completion.

**Parameters:**
- `taskId` (required): The task ID
- `apiKey` (required): Browser.cash API key

### `list_tasks`

List recent tasks to find task IDs or see history.

**Parameters:**
- `apiKey` (required): Browser.cash API key

## Async vs Sync Operations

By default, long-running operations (`browser_automate`, `generate_script`, `run_script`) return immediately with a `taskId`. You can then poll for results using `get_task`.

Set `waitForCompletion: true` to wait for the operation to complete and return results directly. Note that this may timeout for very long operations.

## Authentication

Two authentication methods are supported:

1. **Browser.cash API Key** (recommended): Managed browser sessions with geo-targeting, ad-blocking, and CAPTCHA solving.

2. **Direct CDP URL**: For local development with your own browser.

If you set `BROWSER_CASH_API_KEY` environment variable, it will be used as the default for all tools that need authentication.

## Example Workflows

### One-off Data Extraction

```
1. Use browser_automate with task "Go to example.com and extract all product names and prices" and waitForCompletion: true
2. Results are returned directly
```

### Generate Reusable Script

```
1. Use generate_script with task "Extract top stories from HN"
2. Use get_task with the returned taskId to check progress
3. Once complete, use list_scripts to see your saved scripts
4. Use run_script with the scriptId to execute it again
```

### Polling Pattern

```
1. Use browser_automate with task "Extract data from large site"
2. Get taskId from response
3. Use get_task with taskId to poll until status is "completed" or "error"
4. Results are in the task's result field
```
