# claude-gen

A tool that uses Claude for browser automation - either generating reusable scripts or performing tasks directly via agentic mode. Available as both a CLI tool and a hosted HTTP API.

## Features

- **AI-Powered Script Generation**: Claude analyzes websites and generates robust bash scripts
- **Agentic Mode**: Claude performs tasks directly and returns results immediately (no script generation)
- **Iterative Testing**: Scripts are automatically tested and fixed until they work
- **Script Storage**: Generated scripts are saved to Google Cloud Storage for reuse
- **Task Persistence**: All task results are stored - retrieve results even if client disconnects
- **Browser.cash Integration**: Automatic browser session management via API
- **SSE Streaming**: Real-time progress updates during generation and execution
- **Cloud Ready**: Deploy to Google Cloud Run with one command

## Two Modes of Operation

| Mode | Endpoint | Output | Use Case |
|------|----------|--------|----------|
| **Script Generation** | `/generate/stream` | Reusable bash script saved to GCS | Repeated automation tasks |
| **Agentic Mode** | `/automate/stream` | Direct JSON results | One-off data extraction |

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Usage](#cli-usage)
- [HTTP API](#http-api)
  - [Authentication](#authentication)
  - [Endpoints](#endpoints)
    - [Script Generation](#generate-script-sse-streaming)
    - [Agentic Mode](#agentic-automation-sse-streaming)
    - [Task Retrieval](#task-retrieval-disconnect-recovery)
    - [Script Management](#list-stored-scripts)
  - [Examples](#examples)
- [Google Cloud Deployment](#google-cloud-deployment)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Node.js 20+
- [agent-browser](https://github.com/anthropics/agent-browser) CLI
- [Claude CLI](https://github.com/anthropics/claude-code)
- `jq` for JSON processing
- (Optional) Google Cloud account for deployment
- (Optional) [Browser.cash](https://browser.cash) API key for managed browsers

## Installation

```bash
git clone https://github.com/anthropics/claude-gen.git
cd claude-gen
npm install
npm run build
```

## Configuration

Create a `.env` file:

```bash
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional - for local testing
CDP_URL=wss://your-cdp-url

# Optional - API server settings
PORT=3000
HOST=0.0.0.0

# Optional - script storage
GCS_BUCKET=claude-gen-scripts

# Optional - Browser.cash API
BROWSER_CASH_API_URL=https://api.browser.cash
```

---

## CLI Usage

### Basic Usage

```bash
# Start a browser with CDP enabled
agent-browser daemon

# Generate a script
CDP_URL="ws://localhost:9222/devtools/browser/..." npx claude-gen "Go to amazon.com and extract the top 50 laptops"
```

### CLI Options

```bash
npx claude-gen [options] "<task description>"
```

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <file>` | Output filename | Auto-generated |
| `-m, --model <model>` | Claude model | claude-opus-4-5-20251101 |
| `--max-turns <n>` | Max generation turns | 15 |
| `--max-fix-iterations <n>` | Max fix attempts | 5 |
| `--timeout <ms>` | Execution timeout | 120000 |

---

## HTTP API

Start the API server locally:

```bash
npm run start:server
```

Or use the deployed version:
```
https://claude-gen-api-264851422957.us-central1.run.app
```

### Authentication

The API supports **two authentication methods** for browser access:

| Method | Description | Use Case |
|--------|-------------|----------|
| **Browser.cash API Key** | Managed browser sessions (recommended) | Production, cloud-hosted |
| **Direct CDP URL** | User-provided browser via Chrome DevTools Protocol | Local development, custom setups |

#### Browser.cash API Key (Recommended)

Browser.cash API keys provide managed browser sessions with additional features like geo-targeting and CAPTCHA solving.

| Endpoint Type | Authentication Method |
|---------------|----------------------|
| **POST endpoints** | Include `browserCashApiKey` in request body |
| **GET endpoints** | Use `x-api-key` header OR `apiKey` query parameter |

**Example: POST request**
```bash
curl -X POST https://api.../generate/stream \
  -H "Content-Type: application/json" \
  -d '{"task": "...", "browserCashApiKey": "your-api-key"}'
```

**Example: GET request with header**
```bash
curl -H "x-api-key: your-api-key" https://api.../scripts
```

**Example: GET request with query param**
```bash
curl "https://api.../tasks?apiKey=your-api-key"
```

#### Direct CDP URL (Local Development)

For local development or custom browser setups, you can provide a Chrome DevTools Protocol WebSocket URL directly:

```bash
# Start a browser with CDP enabled
google-chrome --remote-debugging-port=9222

# Or use agent-browser
agent-browser daemon

# Get the CDP URL and use it directly
curl -X POST https://api.../automate/stream \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to example.com and get the title",
    "cdpUrl": "ws://localhost:9222/devtools/browser/..."
  }'
```

**Note:** When using `cdpUrl`, user isolation is based on a hash of the CDP URL, so your scripts/tasks are still private but tied to that specific browser URL.

#### User Isolation

Scripts and tasks are isolated per API key:
- `GET /scripts` returns only **your** scripts
- `GET /scripts/:id` returns 404 if the script belongs to another user
- `GET /tasks` returns only **your** tasks
- `GET /tasks/:taskId` returns 404 if the task belongs to another user

### Browser Options

When using `browserCashApiKey`, you can optionally configure the browser session:

```json
{
  "browserCashApiKey": "your-api-key",
  "browserOptions": {
    "country": "US",
    "type": "consumer_distributed",
    "proxyUrl": "socks5://user:pass@proxy:1080",
    "windowSize": "1920x1080",
    "adblock": true,
    "captchaSolver": true
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `country` | string | 2-letter ISO country code (e.g., "US", "DE", "JP") |
| `type` | string | `consumer_distributed`, `hosted`, or `testing` |
| `proxyUrl` | string | SOCKS5 proxy URL |
| `windowSize` | string | Browser window size (e.g., "1920x1080") |
| `adblock` | boolean | Enable ad-blocking |
| `captchaSolver` | boolean | Enable automatic CAPTCHA solving |

All browser options are **optional**. If not specified, defaults are used.

---

### Endpoints

#### Health Check

```
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-02T19:00:00.000Z",
  "version": "1.0.0"
}
```

---

#### Test CDP Connectivity

```
POST /test-cdp
```

**Request:**
```json
{
  "cdpUrl": "wss://...",
  "testNavigation": true,
  "testUrl": "https://example.com"
}
```

**Response:**
```json
{
  "success": true,
  "connected": true,
  "pageTitle": "Example Domain",
  "currentUrl": "https://example.com/",
  "diagnostics": {
    "cdpConnected": true,
    "browserResponsive": true,
    "canNavigate": true,
    "dnsWorking": true
  }
}
```

---

#### Generate Script (SSE Streaming)

```
POST /generate/stream
```

**Request:**
```json
{
  "task": "Go to https://news.ycombinator.com and extract the top 10 story titles",
  "browserCashApiKey": "your-browser-cash-api-key",
  "browserOptions": {
    "country": "US"
  },
  "skipTest": false
}
```

**SSE Events:**

| Event Type | Description |
|------------|-------------|
| `start` | Generation started |
| `log` | Progress log messages |
| `claude_output` | Claude's responses and tool calls |
| `script_extracted` | Script successfully parsed |
| `iteration_result` | Test iteration result |
| `script_saved` | Script saved to storage |
| `complete` | Generation complete |
| `error` | Error occurred |

**Complete Event Data:**
```json
{
  "type": "complete",
  "data": {
    "success": true,
    "script": "#!/bin/bash\n...",
    "iterations": 1,
    "scriptId": "script-abc123",
    "browserSessionId": "session-xyz789"
  }
}
```

---

#### Agentic Automation (SSE Streaming)

```
POST /automate/stream
```

**Agentic mode** performs browser automation directly and returns results immediately, instead of generating a reusable script. Use this for one-off data extraction tasks.

| Feature | Script Generation (`/generate/stream`) | Agentic Mode (`/automate/stream`) |
|---------|---------------------------------------|-----------------------------------|
| **Output** | Reusable bash script | Direct results/data |
| **Storage** | Scripts saved to GCS | Results returned immediately |
| **Use case** | Repeated automation tasks | One-off data extraction |

**Request:**
```json
{
  "task": "Go to https://news.ycombinator.com and extract the top 5 story titles and URLs",
  "browserCashApiKey": "your-browser-cash-api-key",
  "browserOptions": {
    "country": "US"
  }
}
```

**SSE Events:**

| Event Type | Description |
|------------|-------------|
| `start` | Automation started (includes `mode: "agentic"`) |
| `log` | Progress log messages |
| `claude_output` | Claude's responses and tool calls |
| `complete` | Automation complete with extracted data |
| `error` | Error occurred |

**Complete Event Data:**
```json
{
  "type": "complete",
  "data": {
    "success": true,
    "result": {
      "stories": [
        {"title": "Story 1", "url": "https://..."},
        {"title": "Story 2", "url": "https://..."}
      ]
    },
    "summary": "Extracted 5 stories from Hacker News",
    "browserSessionId": "session-xyz789"
  }
}
```

**Error Response:**
```json
{
  "type": "complete",
  "data": {
    "success": false,
    "result": null,
    "error": "Could not find stories on the page",
    "browserSessionId": "session-xyz789"
  }
}
```

---

---

### Task Retrieval (Disconnect Recovery)

All streaming endpoints (`/generate/stream`, `/automate/stream`, `/scripts/:id/run`) return a `taskId` in their events. Results are persisted to storage, so if a client disconnects mid-stream, they can retrieve the final result later using the task endpoints.

#### Get Task Status and Result

```
GET /tasks/:taskId
```

**Response (Running):**
```json
{
  "taskId": "task-abc123",
  "type": "automate",
  "status": "running",
  "task": "Extract top 5 stories from HN",
  "createdAt": "2026-02-02T21:00:00.000Z",
  "updatedAt": "2026-02-02T21:00:05.000Z",
  "browserSessionId": "session-xyz"
}
```

**Response (Completed - Automate):**
```json
{
  "taskId": "task-abc123",
  "type": "automate",
  "status": "completed",
  "task": "Extract top 5 stories from HN",
  "createdAt": "2026-02-02T21:00:00.000Z",
  "updatedAt": "2026-02-02T21:00:30.000Z",
  "result": {"stories": [...]},
  "summary": "Extracted 5 stories"
}
```

**Response (Completed - Generate):**
```json
{
  "taskId": "task-def456",
  "type": "generate",
  "status": "completed",
  "task": "Generate script for HN extraction",
  "script": "#!/bin/bash\n...",
  "scriptId": "script-xyz789",
  "iterations": 1
}
```

**Response (Error):**
```json
{
  "taskId": "task-abc123",
  "type": "automate",
  "status": "error",
  "error": "Failed to extract data"
}
```

#### List Recent Tasks

```
GET /tasks
```

**Response:**
```json
{
  "tasks": [
    {
      "taskId": "task-abc123",
      "type": "automate",
      "status": "completed",
      "task": "Extract stories from HN",
      "createdAt": "2026-02-02T21:00:00.000Z"
    }
  ]
}
```

---

#### List Stored Scripts

```
GET /scripts
```

**Response:**
```json
{
  "scripts": [
    {
      "id": "script-ml5jh1mk-zqby45",
      "task": "Go to https://news.ycombinator.com and extract the top 5 stories",
      "createdAt": "2026-02-02T19:04:38.228Z",
      "iterations": 1,
      "success": true,
      "scriptSize": 1011
    }
  ]
}
```

---

#### Get Script Details

```
GET /scripts/:id
```

**Response:**
```json
{
  "content": "#!/bin/bash\nset -e\n...",
  "metadata": {
    "id": "script-ml5jh1mk-zqby45",
    "task": "Go to https://news.ycombinator.com and extract the top 5 stories",
    "createdAt": "2026-02-02T19:04:38.228Z",
    "iterations": 1,
    "success": true,
    "scriptSize": 1011
  }
}
```

---

#### Run Stored Script (SSE Streaming)

```
POST /scripts/:id/run
```

**Request:**
```json
{
  "browserCashApiKey": "your-browser-cash-api-key",
  "browserOptions": {
    "country": "US"
  }
}
```

Note: You can only run scripts that you own (created with your API key).

**SSE Events:**

| Event Type | Description |
|------------|-------------|
| `start` | Execution started |
| `log` | Progress messages |
| `output` | Script stdout/stderr output |
| `complete` | Execution complete |
| `error` | Error occurred |

**Output Event:**
```json
{
  "type": "output",
  "data": {
    "stream": "stdout",
    "text": "{\n  \"items\": [...]\n}"
  }
}
```

---

### Examples

#### Generate a Script with Browser.cash

```bash
curl -X POST "https://claude-gen-api-264851422957.us-central1.run.app/generate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to https://news.ycombinator.com and extract the titles and URLs of the top 5 stories",
    "browserCashApiKey": "your-api-key"
  }'
```

#### Generate with Browser Options

```bash
curl -X POST "https://claude-gen-api-264851422957.us-central1.run.app/generate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to amazon.de and extract the top 10 laptop deals",
    "browserCashApiKey": "your-api-key",
    "browserOptions": {
      "country": "DE",
      "adblock": true
    }
  }'
```

#### List Your Scripts

```bash
# Using header
curl -H "x-api-key: your-api-key" \
  "https://claude-gen-api-264851422957.us-central1.run.app/scripts"

# Or using query parameter
curl "https://claude-gen-api-264851422957.us-central1.run.app/scripts?apiKey=your-api-key"
```

#### Agentic Automation (Direct Results)

```bash
curl -X POST "https://claude-gen-api-264851422957.us-central1.run.app/automate/stream" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Go to https://news.ycombinator.com and extract the top 5 story titles and URLs",
    "browserCashApiKey": "your-api-key"
  }'
```

#### Run a Stored Script

```bash
curl -X POST "https://claude-gen-api-264851422957.us-central1.run.app/scripts/script-abc123/run" \
  -H "Content-Type: application/json" \
  -d '{
    "browserCashApiKey": "your-api-key"
  }'
```

#### Retrieve Task Result (After Disconnect)

```bash
# If you got disconnected, use the taskId from the start event to retrieve the result
curl -H "x-api-key: your-api-key" \
  "https://claude-gen-api-264851422957.us-central1.run.app/tasks/task-ml5nom4k-u0h4ws"
```

#### Using with JavaScript/TypeScript

**Script Generation Mode:**
```typescript
async function generateScript(task: string, apiKey: string) {
  const response = await fetch('https://claude-gen-api-264851422957.us-central1.run.app/generate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      browserCashApiKey: apiKey,
    }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));
        console.log(event.type, event.data);

        if (event.type === 'complete') {
          return event.data;
        }
      }
    }
  }
}

// Usage
const result = await generateScript(
  'Go to example.com and get the page title',
  'your-browser-cash-api-key'
);
console.log('Script ID:', result.scriptId);
console.log('Script:', result.script);
```

**Agentic Mode:**
```typescript
async function automateTask(task: string, apiKey: string) {
  const response = await fetch('https://claude-gen-api-264851422957.us-central1.run.app/automate/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task,
      browserCashApiKey: apiKey,
    }),
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const event = JSON.parse(line.slice(6));
        console.log(event.type, event.data);

        if (event.type === 'complete') {
          return event.data;
        }
      }
    }
  }
}

// Usage - get direct results, no script saved
const result = await automateTask(
  'Go to https://news.ycombinator.com and extract the top 5 story titles',
  'your-browser-cash-api-key'
);
console.log('Success:', result.success);
console.log('Data:', result.result);  // { stories: [...] }
console.log('Summary:', result.summary);
```

#### Using with Python

**Script Generation Mode:**
```python
import requests
import json

def generate_script(task: str, api_key: str):
    response = requests.post(
        'https://claude-gen-api-264851422957.us-central1.run.app/generate/stream',
        headers={'Content-Type': 'application/json'},
        json={
            'task': task,
            'browserCashApiKey': api_key,
        },
        stream=True
    )

    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            if line.startswith('data: '):
                event = json.loads(line[6:])
                print(f"{event['type']}: {event.get('data', {})}")

                if event['type'] == 'complete':
                    return event['data']

# Usage
result = generate_script(
    'Go to example.com and get the page title',
    'your-browser-cash-api-key'
)
print(f"Script ID: {result['scriptId']}")
```

**Agentic Mode:**
```python
import requests
import json

def automate_task(task: str, api_key: str):
    response = requests.post(
        'https://claude-gen-api-264851422957.us-central1.run.app/automate/stream',
        headers={'Content-Type': 'application/json'},
        json={
            'task': task,
            'browserCashApiKey': api_key,
        },
        stream=True
    )

    for line in response.iter_lines():
        if line:
            line = line.decode('utf-8')
            if line.startswith('data: '):
                event = json.loads(line[6:])
                print(f"{event['type']}: {event.get('data', {})}")

                if event['type'] == 'complete':
                    return event['data']

# Usage - get direct results, no script saved
result = automate_task(
    'Go to https://news.ycombinator.com and extract the top 5 story titles',
    'your-browser-cash-api-key'
)
print(f"Success: {result['success']}")
print(f"Data: {result['result']}")  # { "stories": [...] }
print(f"Summary: {result['summary']}")
```

#### Handling Disconnects (JavaScript)

```typescript
// Robust client that can recover from disconnects
async function automateWithRecovery(task: string, apiKey: string) {
  let taskId: string | null = null;

  try {
    const response = await fetch('https://claude-gen-api-264851422957.us-central1.run.app/automate/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, browserCashApiKey: apiKey }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const event = JSON.parse(line.slice(6));

          // Capture taskId from start event
          if (event.type === 'start') {
            taskId = event.data.taskId;
            console.log('Task ID:', taskId);
          }

          if (event.type === 'complete') {
            return event.data;
          }
        }
      }
    }
  } catch (error) {
    console.log('Connection lost, checking task status...');

    // If we have a taskId, poll for the result
    if (taskId) {
      return await pollTaskResult(taskId);
    }
    throw error;
  }
}

async function pollTaskResult(taskId: string, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetch(`https://claude-gen-api-264851422957.us-central1.run.app/tasks/${taskId}`);
    const task = await response.json();

    if (task.status === 'completed' || task.status === 'error') {
      return task;
    }

    // Wait 5 seconds before next poll
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Task timed out');
}
```

---

## Google Cloud Deployment

### Prerequisites

1. Google Cloud account with billing enabled
2. `gcloud` CLI installed and authenticated
3. Project with the following APIs enabled:
   - Cloud Build
   - Cloud Run
   - Container Registry
   - Secret Manager

### Quick Deploy

```bash
# Set your project ID
export PROJECT_ID=your-gcp-project-id

# Enable required APIs
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com secretmanager.googleapis.com --project $PROJECT_ID

# Create the Anthropic API key secret
echo -n "your-anthropic-api-key" | gcloud secrets create anthropic-api-key --data-file=- --project $PROJECT_ID

# Create GCS bucket for script storage
gcloud storage buckets create gs://claude-gen-scripts --project $PROJECT_ID --location us-central1

# Grant permissions to Cloud Run service account
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud storage buckets add-iam-policy-binding gs://claude-gen-scripts \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Deploy
gcloud builds submit --config cloudbuild.yaml --project $PROJECT_ID
```

### Configuration Variables

The deployment can be customized via substitution variables in `cloudbuild.yaml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `_REGION` | us-central1 | Cloud Run region |
| `_MODEL` | claude-opus-4-5-20251101 | Claude model |
| `_MAX_TURNS` | 15 | Max generation turns |
| `_MAX_FIX_ITERATIONS` | 5 | Max fix iterations |
| `_GCS_BUCKET` | claude-gen-scripts | Script storage bucket |

### Manual Deployment

```bash
# Build the project
npm run build

# Build Docker image
docker build -t gcr.io/$PROJECT_ID/claude-gen-api .

# Push to Container Registry
docker push gcr.io/$PROJECT_ID/claude-gen-api

# Deploy to Cloud Run
gcloud run deploy claude-gen-api \
  --image gcr.io/$PROJECT_ID/claude-gen-api \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --timeout 3600 \
  --memory 2Gi \
  --cpu 2 \
  --set-env-vars "GCS_BUCKET=claude-gen-scripts" \
  --set-secrets "ANTHROPIC_API_KEY=anthropic-api-key:latest"
```

---

## Troubleshooting

### "API key required"

All endpoints require authentication:
- For POST endpoints, include `browserCashApiKey` in the request body
- For GET endpoints, use `x-api-key` header or `apiKey` query parameter

### "Script not found" / "Task not found"

Either the resource doesn't exist, or it belongs to another user. You can only access scripts and tasks created with your API key.

### "Failed to create browser session"

- Verify your Browser.cash API key is valid
- Check your Browser.cash account has available credits
- Try without `browserOptions` to use defaults

### "CDP connection unavailable"

The browser session has expired or disconnected. Browser sessions are ephemeral - create a new one for each task.

### "Script extraction failed"

Claude couldn't generate a valid script. Try:
- Simplifying your task description
- Being more specific about what data to extract
- Checking if the target website requires authentication

### Low extraction rate

If data is incomplete:
1. The website may have anti-bot protection
2. Some items may not have the requested data (e.g., no price listed)
3. Try enabling `adblock: true` in browser options
4. Try a different `country` in browser options

### Timeout errors

For long-running extractions:
- The default timeout is 3600 seconds (1 hour) on Cloud Run
- Large extractions may need multiple runs with pagination
- Consider breaking large tasks into smaller chunks

---

## Generated Script Structure

Scripts follow this pattern:

```bash
#!/bin/bash
set -e
CDP="${CDP_URL:?Required: CDP_URL}"

# JSON unwrapping helper
unwrap_json() {
  echo "$1" | jq -r 'if type == "string" then fromjson else . end' 2>/dev/null || echo "$1"
}

# Navigate to target
agent-browser --cdp "$CDP" open "https://example.com"
sleep 2

# Extract data
RAW_DATA=$(agent-browser --cdp "$CDP" eval '...')
DATA=$(unwrap_json "$RAW_DATA")

echo "============================================"
echo "RESULTS"
echo "============================================"
echo "$DATA"
```

## Output Format

Extracted data is returned as JSON:

```json
{
  "totalExtracted": 10,
  "items": [
    {
      "title": "Story Title",
      "url": "https://...",
      "score": "142 points"
    }
  ]
}
```

---

## License

MIT
