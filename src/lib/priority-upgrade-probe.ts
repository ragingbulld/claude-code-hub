/**
 * Priority-upgrade probe state (cheap test gate + pending rebind).
 *
 * Goal: when sticky is on a lower-priority (often more expensive) provider,
 * cheap-test higher-priority candidates in round-robin. If the cheap test
 * passes, the NEXT request rebinds directly to that higher-priority provider
 * (single-send, no parallel race with the old sticky).
 */
import { randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";

export const PRIORITY_UPGRADE_PROBE = {
  /**
   * Feature gate. Only when enabled do we cheap-test / rebind higher priority.
   * Default false so production stays unchanged unless explicitly turned on.
   */
  ENABLED: process.env.ENABLE_PRIORITY_UPGRADE_PROBE === "true",
  /** Per-session interval between complete higher-priority probe rounds. */
  ROUND_INTERVAL_MS: 60_000,
  /** Cheap test timeout fallback. */
  DEFAULT_TIMEOUT_MS: 5_000,
  /** Per-provider cheap-test lock TTL (prevents concurrent duplicate tests). */
  PROVIDER_LOCK_MS: 210_000,
  /** Per-session whole-round lease TTL (prevents overlapping rounds). */
  SESSION_ROUND_LOCK_MS: 210_000,
  /** Refresh the whole-round lease while a long probe is still running. */
  SESSION_ROUND_LOCK_REFRESH_MS: 60_000,
  /** Global concurrent cheap-test budget. */
  GLOBAL_INFLIGHT_LIMIT: 3,
  GLOBAL_INFLIGHT_KEY: "cch:priority_upgrade:probe_inflight",
} as const;

function probeLockKey(providerId: number): string {
  return `cch:priority_upgrade:lock:${providerId}`;
}

function pendingRebindKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_pending`;
}

function probeEpochKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_epoch`;
}

function probeCancelledKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_cancelled`;
}

export function isPriorityUpgradeProbeEnabled(): boolean {
  return PRIORITY_UPGRADE_PROBE.ENABLED;
}

export function isPriorityUpgradeFirstByteSlaMet(
  result: { success: boolean; firstByteMs?: number },
  timeoutMs: number
): result is { success: true; firstByteMs: number } {
  return (
    result.success && typeof result.firstByteMs === "number" && result.firstByteMs <= timeoutMs
  );
}

/**
 * Acquire exclusive cheap-test lock for a provider.
 * Ensures: after a test starts, other requests won't start another test on the
 * same provider until this one finishes (success/fail) and the next request cycle.
 */
export async function tryAcquireProviderProbeLock(providerId: number): Promise<string | null> {
  const redis = getRedisClient();
  const ownerToken = randomUUID();
  if (redis?.status !== "ready") return ownerToken;
  try {
    const result = await redis.set(
      probeLockKey(providerId),
      ownerToken,
      "PX",
      PRIORITY_UPGRADE_PROBE.PROVIDER_LOCK_MS,
      "NX"
    );
    return result === "OK" ? ownerToken : null;
  } catch {
    return ownerToken;
  }
}

export async function releaseProviderProbeLock(
  providerId: number,
  ownerToken: string
): Promise<void> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return;
  try {
    await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      probeLockKey(providerId),
      ownerToken
    );
  } catch {
    // ignore
  }
}

/** Acquire an owner-safe global inflight lease so cheap tests don't stampede. */
export async function tryAcquireProbeInflightSlot(): Promise<string | null> {
  const redis = getRedisClient();
  const ownerToken = randomUUID();
  if (redis?.status !== "ready") return ownerToken; // fail-open: allow probe
  try {
    const now = Date.now();
    const result = await redis.eval(
      `
        redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
        if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        return 1
      `,
      1,
      PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_KEY,
      String(now),
      String(PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_LIMIT),
      String(now + PRIORITY_UPGRADE_PROBE.PROVIDER_LOCK_MS),
      ownerToken,
      String(PRIORITY_UPGRADE_PROBE.PROVIDER_LOCK_MS)
    );
    return Number(result) === 1 ? ownerToken : null;
  } catch {
    return ownerToken;
  }
}

export async function releaseProbeInflightSlot(ownerToken: string): Promise<void> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return;
  try {
    await redis.zrem(PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_KEY, ownerToken);
  } catch {
    // ignore
  }
}

function sessionProbeGateKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_gate`;
}

function sessionProbeRoundLockKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_inflight`;
}

/**
 * Acquire one owner-safe whole-round lease for a session.
 *
 * Unlike provider locks, this is fail-closed when Redis is unavailable: skipping
 * an optional side probe is safer than allowing overlapping rounds.
 */
export async function tryAcquireSessionProbeRoundLock(sessionId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return null;
  const ownerToken = randomUUID();
  try {
    const result = await redis.set(
      sessionProbeRoundLockKey(sessionId),
      ownerToken,
      "PX",
      PRIORITY_UPGRADE_PROBE.SESSION_ROUND_LOCK_MS,
      "NX"
    );
    return result === "OK" ? ownerToken : null;
  } catch {
    return null;
  }
}

/** Refresh only the caller's current whole-round lease. */
export async function refreshSessionProbeRoundLock(
  sessionId: string,
  ownerToken: string
): Promise<boolean> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return false;
  try {
    const result = await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        return 0
      `,
      1,
      sessionProbeRoundLockKey(sessionId),
      ownerToken,
      String(PRIORITY_UPGRADE_PROBE.SESSION_ROUND_LOCK_MS)
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
}

/** Release only the caller's current whole-round lease. */
export async function releaseSessionProbeRoundLock(
  sessionId: string,
  ownerToken: string
): Promise<void> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return;
  try {
    await redis.eval(
      `
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('DEL', KEYS[1])
        end
        return 0
      `,
      1,
      sessionProbeRoundLockKey(sessionId),
      ownerToken
    );
  } catch {
    // TTL is the crash-safe fallback.
  }
}

/**
 * Start one complete higher-priority probe round per session interval.
 * The gate is acquired only when the healthy sticky response is ready to
 * launch the side probe, so a skipped probe does not consume the interval.
 */
export async function tryAcquireSessionProbeGate(sessionId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return true;
  try {
    const result = await redis.set(
      sessionProbeGateKey(sessionId),
      "1",
      "PX",
      PRIORITY_UPGRADE_PROBE.ROUND_INTERVAL_MS,
      "NX"
    );
    return result === "OK";
  } catch {
    return true;
  }
}

/**
 * Atomically publish a probe winner only if no real hedge race has advanced the
 * session epoch since this probe plan was created.
 */
export async function setPendingPriorityRebindIfEpoch(
  sessionId: string,
  providerId: number,
  expectedEpoch: number
): Promise<boolean> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return false;
  try {
    const ttl = Number.parseInt(process.env.SESSION_TTL || "300", 10);
    const ttlSeconds = Number.isFinite(ttl) ? ttl : 300;
    const result = await redis.eval(
      `
        local current_epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
        if current_epoch ~= tonumber(ARGV[2]) then return 0 end
        if redis.call('GET', KEYS[3]) == '1' then return 0 end
        redis.call('SETEX', KEYS[1], tonumber(ARGV[3]), ARGV[1] .. ':' .. ARGV[2])
        return 1
      `,
      3,
      pendingRebindKey(sessionId),
      probeEpochKey(sessionId),
      probeCancelledKey(sessionId),
      String(providerId),
      String(expectedEpoch),
      String(ttlSeconds)
    );
    return Number(result) === 1;
  } catch (error) {
    logger.debug("PriorityUpgradeProbe: failed epoch-guarded pending rebind", {
      sessionId,
      providerId,
      expectedEpoch,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function consumePendingPriorityRebind(sessionId: string): Promise<number | null> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return null;
  try {
    const raw = await redis.eval(
      `
        local value = redis.call('GET', KEYS[1])
        if not value then return nil end
        local provider_id, pending_epoch = string.match(value, '^(%d+):(%d+)$')
        local current_epoch = redis.call('GET', KEYS[2]) or '0'
        local cancelled = redis.call('GET', KEYS[3])
        redis.call('DEL', KEYS[1])
        if not provider_id or not pending_epoch then return nil end
        if pending_epoch ~= current_epoch or cancelled == '1' then return nil end
        return provider_id
      `,
      3,
      pendingRebindKey(sessionId),
      probeEpochKey(sessionId),
      probeCancelledKey(sessionId)
    );
    if (typeof raw !== "string") return null;
    const id = Number.parseInt(raw, 10);
    return Number.isFinite(id) ? id : null;
  } catch (error) {
    logger.debug("PriorityUpgradeProbe: failed to consume pending rebind", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getPendingPriorityRebind(sessionId: string): Promise<number | null> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return null;
  try {
    const raw = await redis.get(pendingRebindKey(sessionId));
    if (!raw) return null;
    const separator = raw.indexOf(":");
    if (separator <= 0) return null;
    const id = Number.parseInt(raw.slice(0, separator), 10);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

export async function clearPendingPriorityRebind(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return;
  try {
    await redis.del(pendingRebindKey(sessionId));
  } catch {
    // ignore
  }
}
