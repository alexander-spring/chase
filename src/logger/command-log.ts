import * as fs from 'fs';
import * as path from 'path';

export interface CommandLogEntry {
  timestamp: string;
  command: string;
  output: string;
  success: boolean;
}

/**
 * Read captured commands from a session log file
 */
export function readCommandLog(sessionId: string, sessionsDir: string): CommandLogEntry[] {
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return [];
  }

  const content = fs.readFileSync(sessionFile, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());

  return lines.map(line => {
    try {
      return JSON.parse(line) as CommandLogEntry;
    } catch {
      return null;
    }
  }).filter((entry): entry is CommandLogEntry => entry !== null);
}

/**
 * Get only successful agent-browser commands
 */
export function getSuccessfulCommands(entries: CommandLogEntry[]): string[] {
  return entries
    .filter(entry => entry.success && entry.command.includes('agent-browser'))
    .map(entry => entry.command);
}

/**
 * Clean up session file after script generation
 */
export function cleanupSession(sessionId: string, sessionsDir: string): void {
  const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
  }
}
