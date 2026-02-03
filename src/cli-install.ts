#!/usr/bin/env node

/**
 * Claude-Gen CLI Installer
 *
 * Usage:
 *   npx claude-gen-install          # Install skill + show MCP setup
 *   npx claude-gen-install --skill  # Install skill only
 *   npx claude-gen-install --mcp    # Show MCP setup only
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';

const SKILL_URL = 'https://raw.githubusercontent.com/alexander-spring/claude-gen/main/skill/SKILL.md';
const MCP_URL = 'https://claude-gen-api-264851422957.us-central1.run.app/mcp';

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        https.get(response.headers.location!, (res) => {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      } else {
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }
    }).on('error', reject);
  });
}

async function installSkill(): Promise<void> {
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'claude-gen');
  const skillPath = path.join(skillDir, 'SKILL.md');

  console.log('Installing claude-gen skill...');

  // Create directory
  fs.mkdirSync(skillDir, { recursive: true });

  // Download skill
  await downloadFile(SKILL_URL, skillPath);

  console.log(`✓ Skill installed to ${skillPath}`);
}

function showMcpSetup(): void {
  console.log(`
MCP Server Setup
================

Option 1: Hosted HTTP (Recommended)
-----------------------------------
claude mcp add --transport http claude-gen ${MCP_URL} -H "x-api-key: YOUR_API_KEY"

Option 2: Local stdio
---------------------
git clone https://github.com/alexander-spring/claude-gen.git
cd claude-gen/mcp-server && npm install && npm run build
claude mcp add claude-gen node ./dist/index.js -e BROWSER_CASH_API_KEY=YOUR_KEY

Claude Desktop Config
---------------------
Add to ~/Library/Application Support/Claude/claude_desktop_config.json:

{
  "mcpServers": {
    "claude-gen": {
      "transport": "http",
      "url": "${MCP_URL}",
      "headers": {
        "x-api-key": "YOUR_API_KEY"
      }
    }
  }
}
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const skillOnly = args.includes('--skill');
  const mcpOnly = args.includes('--mcp');

  console.log(`
╔═══════════════════════════════════════════╗
║       Claude-Gen Browser Automation       ║
╚═══════════════════════════════════════════╝
`);

  if (!mcpOnly) {
    try {
      await installSkill();
    } catch (err) {
      console.error('Failed to install skill:', err instanceof Error ? err.message : err);
    }
  }

  if (!skillOnly) {
    showMcpSetup();
  }

  console.log(`
Get your API key at: https://browser.cash

Quick Start:
  export BROWSER_CASH_API_KEY="your-key"
  # Then ask Claude to extract data from any website!
`);
}

main().catch(console.error);
