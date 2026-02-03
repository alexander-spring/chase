#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ApiClient } from './lib/api-client.js';
import type {
  AutomateRequest,
  GenerateScriptRequest,
  RunScriptRequest,
} from './lib/types.js';

// Tool definitions
import { browserAutomateTool, handleBrowserAutomate } from './tools/automate.js';
import { generateScriptTool, handleGenerateScript } from './tools/generate.js';
import {
  listScriptsTool,
  handleListScripts,
  getScriptTool,
  handleGetScript,
  runScriptTool,
  handleRunScript,
} from './tools/scripts.js';
import { getTaskTool, handleGetTask, listTasksTool, handleListTasks } from './tools/tasks.js';

// Configuration from environment
const API_BASE_URL = process.env.CHASE_API_URL || 'https://chase-api-gth2quoxyq-uc.a.run.app';
const DEFAULT_API_KEY = process.env.BROWSER_CASH_API_KEY;

// Create API client
const apiClient = new ApiClient({
  baseUrl: API_BASE_URL,
  defaultApiKey: DEFAULT_API_KEY,
});

// Create MCP server
const server = new Server(
  {
    name: 'chase',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    browserAutomateTool,
    generateScriptTool,
    listScriptsTool,
    getScriptTool,
    runScriptTool,
    getTaskTool,
    listTasksTool,
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Add default API key if not provided and available
  const argsWithDefaults = { ...args } as Record<string, unknown>;
  if (!argsWithDefaults.apiKey && DEFAULT_API_KEY) {
    argsWithDefaults.apiKey = DEFAULT_API_KEY;
  }

  switch (name) {
    case 'browser_automate':
      return handleBrowserAutomate(apiClient, argsWithDefaults as unknown as AutomateRequest);

    case 'generate_script':
      return handleGenerateScript(apiClient, argsWithDefaults as unknown as GenerateScriptRequest);

    case 'list_scripts':
      return handleListScripts(apiClient, argsWithDefaults as { apiKey: string });

    case 'get_script':
      return handleGetScript(apiClient, argsWithDefaults as { scriptId: string; apiKey: string });

    case 'run_script':
      return handleRunScript(apiClient, argsWithDefaults as unknown as RunScriptRequest);

    case 'get_task':
      return handleGetTask(apiClient, argsWithDefaults as { taskId: string; apiKey: string });

    case 'list_tasks':
      return handleListTasks(apiClient, argsWithDefaults as { apiKey: string });

    default:
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        }],
      };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Chase MCP server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
