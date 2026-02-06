import { Storage } from '@google-cloud/storage';
import type { UserLimits } from './types.js';

const DEFAULT_MAX_DAILY_COST_USD = parseFloat(process.env.USAGE_MAX_DAILY_COST_USD || '5');
const DEFAULT_MAX_CONCURRENT = parseInt(process.env.USAGE_MAX_CONCURRENT || '3', 10);

/** In-memory cache: ownerId → { limits, expiry } */
const limitsCache = new Map<string, { limits: UserLimits; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _storage: Storage | null = null;
let _bucketName: string = '';

export function initUserLimits(storage: Storage | null, bucketName: string): void {
  _storage = storage;
  _bucketName = bucketName;
}

export async function loadUserLimits(ownerId: string): Promise<UserLimits> {
  const now = Date.now();
  const cached = limitsCache.get(ownerId);
  if (cached && now < cached.expiresAt) {
    return cached.limits;
  }

  // Try GCS override
  if (_storage) {
    try {
      const bucket = _storage.bucket(_bucketName);
      const [content] = await bucket.file(`limits/${ownerId}.json`).download();
      const override = JSON.parse(content.toString()) as Partial<UserLimits>;
      const limits: UserLimits = {
        maxDailyCostUsd: override.maxDailyCostUsd ?? DEFAULT_MAX_DAILY_COST_USD,
        maxConcurrentTasks: override.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT,
      };
      limitsCache.set(ownerId, { limits, expiresAt: now + CACHE_TTL_MS });
      return limits;
    } catch {
      // File not found or GCS error — fall through to defaults
    }
  }

  const limits: UserLimits = {
    maxDailyCostUsd: DEFAULT_MAX_DAILY_COST_USD,
    maxConcurrentTasks: DEFAULT_MAX_CONCURRENT,
  };
  limitsCache.set(ownerId, { limits, expiresAt: now + CACHE_TTL_MS });
  return limits;
}
