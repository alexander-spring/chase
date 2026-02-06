import { loadUserLimits } from './user-limits.js';
import { seedFromGcs, acquireTask, releaseTask } from './usage-tracker.js';
import type { LimitCheckResult, TaskUsage } from './types.js';

const DISABLED = process.env.DISABLE_USAGE_LIMITS === '1';

export async function checkUsageLimits(ownerId: string): Promise<LimitCheckResult> {
  if (DISABLED) {
    return { allowed: true, onTaskEnd: () => {} };
  }

  // Seed from GCS on first request for this user (prevents cold-start bypass)
  await seedFromGcs(ownerId);

  const limits = await loadUserLimits(ownerId);
  const result = acquireTask(ownerId, limits);

  if (!result.allowed) {
    return { allowed: false, reason: result.reason, onTaskEnd: () => {} };
  }

  // Task was acquired — return a cleanup callback
  let released = false;
  return {
    allowed: true,
    onTaskEnd: (usage?: TaskUsage) => {
      if (released) return;
      released = true;
      releaseTask(ownerId, usage);
    },
  };
}
