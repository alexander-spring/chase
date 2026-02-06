export interface UserLimits {
  maxDailyCostUsd: number;      // default: 5
  maxConcurrentTasks: number;   // default: 3 (bypass prevention)
}

export interface UserUsageState {
  activeTasks: number;
  costUsdToday: number;
  costDate: string;             // YYYY-MM-DD UTC
  lastFlushedAt: number;
}

export interface DailyUsageRecord {
  ownerId: string;
  date: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
  updatedAt: string;
}

export interface TaskUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  /** Call when the task finishes (releases concurrent slot, records cost). */
  onTaskEnd: (usage?: TaskUsage) => void;
}
