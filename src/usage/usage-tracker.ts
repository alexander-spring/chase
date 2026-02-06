import { Storage } from '@google-cloud/storage';
import type { UserUsageState, DailyUsageRecord, TaskUsage } from './types.js';

let _storage: Storage | null = null;
let _bucketName: string = '';

export function initUsageTracker(storage: Storage | null, bucketName: string): void {
  _storage = storage;
  _bucketName = bucketName;
}

/** In-memory usage state per user. */
const usageState = new Map<string, UserUsageState>();

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getOrCreateState(ownerId: string): UserUsageState {
  let state = usageState.get(ownerId);
  const today = utcDateString();
  if (!state || state.costDate !== today) {
    // New day or first time — reset counters (activeTasks carries over only if same object)
    state = {
      activeTasks: state?.activeTasks ?? 0, // preserve in-flight tasks across date roll
      costUsdToday: 0,
      costDate: today,
      lastFlushedAt: 0,
    };
    usageState.set(ownerId, state);
  }
  return state;
}

/**
 * Seed today's counters from GCS so cost limits survive restarts.
 * Called once per ownerId on first request.
 */
const seededOwners = new Set<string>();

export async function seedFromGcs(ownerId: string): Promise<void> {
  if (seededOwners.has(ownerId)) return;
  seededOwners.add(ownerId);

  if (!_storage) return;

  const today = utcDateString();
  try {
    const bucket = _storage.bucket(_bucketName);
    const [content] = await bucket.file(`usage/${ownerId}/${today}.json`).download();
    const record = JSON.parse(content.toString()) as DailyUsageRecord;

    const state = getOrCreateState(ownerId);
    // Only seed if the record is for today and has higher cost than in-memory
    if (record.date === today && record.totalCostUsd > state.costUsdToday) {
      state.costUsdToday = record.totalCostUsd;
    }
  } catch {
    // File not found or GCS error — start fresh
  }
}

export interface AcquireResult {
  allowed: boolean;
  reason?: string;
}

export function acquireTask(
  ownerId: string,
  limits: { maxDailyCostUsd: number; maxConcurrentTasks: number }
): AcquireResult {
  const state = getOrCreateState(ownerId);

  if (state.activeTasks >= limits.maxConcurrentTasks) {
    return {
      allowed: false,
      reason: `Concurrent task limit reached (${limits.maxConcurrentTasks}). Wait for a running task to finish.`,
    };
  }

  if (state.costUsdToday >= limits.maxDailyCostUsd) {
    return {
      allowed: false,
      reason: `Daily cost limit reached ($${state.costUsdToday.toFixed(2)} / $${limits.maxDailyCostUsd.toFixed(2)}). Resets at UTC midnight.`,
    };
  }

  state.activeTasks++;
  return { allowed: true };
}

export function releaseTask(ownerId: string, usage?: TaskUsage): void {
  const state = getOrCreateState(ownerId);
  state.activeTasks = Math.max(0, state.activeTasks - 1);

  if (usage) {
    state.costUsdToday += usage.costUsd;
    flushToGcs(ownerId, state, usage).catch(() => {});
  }
}

async function flushToGcs(ownerId: string, state: UserUsageState, usage: TaskUsage): Promise<void> {
  if (!_storage) return;

  const today = utcDateString();
  const bucket = _storage.bucket(_bucketName);
  const filePath = `usage/${ownerId}/${today}.json`;

  // Read-modify-write (last-write-wins is acceptable per plan)
  let record: DailyUsageRecord;
  try {
    const [content] = await bucket.file(filePath).download();
    record = JSON.parse(content.toString()) as DailyUsageRecord;
  } catch {
    record = {
      ownerId,
      date: today,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      taskCount: 0,
      updatedAt: '',
    };
  }

  record.totalCostUsd += usage.costUsd;
  record.totalInputTokens += usage.inputTokens;
  record.totalOutputTokens += usage.outputTokens;
  record.taskCount++;
  record.updatedAt = new Date().toISOString();

  await bucket.file(filePath).save(JSON.stringify(record, null, 2), {
    contentType: 'application/json',
  });

  state.lastFlushedAt = Date.now();
}
