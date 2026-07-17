/**
 * Priority-upgrade probe state (cheap test gate + pending rebind).
 *
 * Goal: when sticky is on a lower-priority (often more expensive) provider,
 * cheap-test higher-priority candidates in priority/weight order. A candidate must
 * pass the first-byte SLA in three consecutive rounds before the NEXT request
 * rebinds directly to it (single-send, no parallel race with the old sticky).
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
  /** Leave enough time to persist/release before the provider/global lease expires. */
  PROVIDER_LOCK_RELEASE_MARGIN_MS: 30_000,
  /** Per-session whole-round lease TTL (prevents overlapping rounds). */
  SESSION_ROUND_LOCK_MS: 210_000,
  /** Refresh the whole-round lease while a long probe is still running. */
  SESSION_ROUND_LOCK_REFRESH_MS: 60_000,
  /** Global concurrent cheap-test budget. */
  GLOBAL_INFLIGHT_LIMIT: 3,
  GLOBAL_INFLIGHT_KEY: "cch:priority_upgrade:probe_inflight",
  /** Consecutive in-SLA probe successes required before publishing a rebind. */
  REQUIRED_CONSECUTIVE_SUCCESSES: 3,
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

function probeSuccessStateKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_successes`;
}

function probeContextKey(sessionId: string): string {
  return `session:${sessionId}:priority_upgrade_probe_context`;
}

export interface PriorityUpgradeProbeSuccessState {
  providerId: number;
  consecutiveSuccesses: number;
  totalFirstByteMs: number;
  averageFirstByteMs: number;
}

function parseProbeSuccessState(
  providerId: number,
  raw: string | null | undefined
): PriorityUpgradeProbeSuccessState | null {
  if (!raw) return null;
  const [countRaw, totalRaw] = raw.split(":");
  const consecutiveSuccesses = Number.parseInt(countRaw ?? "", 10);
  const totalFirstByteMs = Number.parseFloat(totalRaw ?? "");
  if (
    !Number.isFinite(consecutiveSuccesses) ||
    consecutiveSuccesses <= 0 ||
    !Number.isFinite(totalFirstByteMs) ||
    totalFirstByteMs < 0
  ) {
    return null;
  }
  return {
    providerId,
    consecutiveSuccesses,
    totalFirstByteMs,
    averageFirstByteMs: totalFirstByteMs / consecutiveSuccesses,
  };
}

export async function getPriorityUpgradeProbeSuccessStates(
  sessionId: string,
  providerIds: readonly number[]
): Promise<PriorityUpgradeProbeSuccessState[]> {
  const ids = [...new Set(providerIds)].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return [];
  const redis = getRedisClient();
  if (redis?.status !== "ready") return [];
  try {
    const values = await redis.hmget(probeSuccessStateKey(sessionId), ...ids.map(String));
    return ids
      .map((id, index) => parseProbeSuccessState(id, values[index]))
      .filter((state): state is PriorityUpgradeProbeSuccessState => state !== null);
  } catch (error) {
    logger.debug("PriorityUpgradeProbe: failed to load success streaks", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Candidates with an unfinished success streak are tested before the remaining
 * priority/weight plan. A candidate closer to qualification comes first; equal
 * counts prefer the lower observed average and then preserve the frozen plan order.
 */
export function prioritizePriorityUpgradeProbeCandidates<T extends { id: number }>(
  candidates: readonly T[],
  states: readonly PriorityUpgradeProbeSuccessState[]
): T[] {
  const byProvider = new Map(states.map((state) => [state.providerId, state]));
  const originalIndex = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const progressing = candidates.filter((candidate) => byProvider.has(candidate.id));
  progressing.sort((a, b) => {
    const aState = byProvider.get(a.id)!;
    const bState = byProvider.get(b.id)!;
    return (
      bState.consecutiveSuccesses - aState.consecutiveSuccesses ||
      aState.averageFirstByteMs - bState.averageFirstByteMs ||
      (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0)
    );
  });
  const progressingIds = new Set(progressing.map((candidate) => candidate.id));
  return [...progressing, ...candidates.filter((candidate) => !progressingIds.has(candidate.id))];
}

export interface PriorityUpgradeProbeBatchOutcome {
  providerId: number;
  success: boolean;
  firstByteMs?: number;
}

export interface PriorityUpgradeProbeBatchResult {
  applied: boolean;
  winnerProviderId: number | null;
  successStates: PriorityUpgradeProbeSuccessState[];
}

/**
 * Bind probe progress to one routing context. A model, API format, provider group,
 * or sticky source change invalidates both the old streak hash and its pending target.
 */
export async function preparePriorityUpgradeProbeContext(
  sessionId: string,
  context: string
): Promise<boolean> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return false;

  try {
    const ttl = Number.parseInt(process.env.SESSION_TTL || "300", 10);
    const ttlSeconds = Number.isFinite(ttl) ? Math.max(1, ttl) : 300;
    await redis.eval(
      `
        -- PRIORITY_UPGRADE_CONTEXT_PREPARE
        local current = redis.call('GET', KEYS[1])
        if current ~= ARGV[1] then
          redis.call('DEL', KEYS[2])
          redis.call('DEL', KEYS[3])
          redis.call('INCR', KEYS[4])
          redis.call('EXPIRE', KEYS[4], 3600)
          redis.call('DEL', KEYS[5])
        end
        redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
        return current == ARGV[1] and 0 or 1
      `,
      5,
      probeContextKey(sessionId),
      probeSuccessStateKey(sessionId),
      pendingRebindKey(sessionId),
      probeEpochKey(sessionId),
      probeCancelledKey(sessionId),
      context,
      ttlSeconds.toString()
    );
    return true;
  } catch (error) {
    logger.warn("Failed to prepare priority upgrade probe context", {
      sessionId,
      error,
    });
    return false;
  }
}

/**
 * Apply every retained/direct outcome from one logical batch in one Redis Lua
 * transaction. The transaction validates epoch/cancel once, updates every streak,
 * chooses same-batch qualifiers by lowest running average, and publishes pending.
 */
export async function applyPriorityUpgradeProbeBatchIfEpoch(params: {
  sessionId: string;
  outcomes: readonly PriorityUpgradeProbeBatchOutcome[];
  expectedEpoch: number;
  publishWinner?: boolean;
}): Promise<PriorityUpgradeProbeBatchResult> {
  if (
    params.outcomes.length === 0 ||
    params.outcomes.some((outcome) => outcome.success && !Number.isFinite(outcome.firstByteMs))
  ) {
    return { applied: false, winnerProviderId: null, successStates: [] };
  }
  const normalized = params.outcomes.map((outcome) => {
    const firstByteMs =
      outcome.success && Number.isFinite(outcome.firstByteMs)
        ? Math.max(0, outcome.firstByteMs ?? 0)
        : 0;
    return { ...outcome, firstByteMs };
  });

  const redis = getRedisClient();
  if (redis?.status !== "ready") {
    return { applied: false, winnerProviderId: null, successStates: [] };
  }

  try {
    const ttl = Number.parseInt(process.env.SESSION_TTL || "300", 10);
    const ttlSeconds = Number.isFinite(ttl) ? Math.max(1, ttl) : 300;
    const raw = await redis.eval(
      `
        -- PRIORITY_UPGRADE_BATCH_APPLY
        local current_epoch = tonumber(redis.call('GET', KEYS[2]) or '0')
        if current_epoch ~= tonumber(ARGV[1]) then return {0} end
        if redis.call('GET', KEYS[3]) == '1' then return {0} end

        local winner_id = 0
        local winner_average = nil
        local response = {1, '0'}
        local offset = 4
        while offset <= #ARGV do
          local provider_id = ARGV[offset]
          local succeeded = ARGV[offset + 1] == '1'
          local first_byte_ms = tonumber(ARGV[offset + 2]) or 0
          if not succeeded then
            redis.call('HDEL', KEYS[1], provider_id)
          else
            local previous = redis.call('HGET', KEYS[1], provider_id)
            local count = 0
            local total = 0
            if previous then
              local separator = string.find(previous, ':', 1, true)
              if separator then
                count = tonumber(string.sub(previous, 1, separator - 1)) or 0
                total = tonumber(string.sub(previous, separator + 1)) or 0
              end
            end
            count = count + 1
            total = total + first_byte_ms
            local encoded = tostring(count) .. ':' .. string.format('%.6f', total)
            redis.call('HSET', KEYS[1], provider_id, encoded)
            table.insert(response, provider_id)
            table.insert(response, tostring(count))
            table.insert(response, string.format('%.6f', total))

            if count >= tonumber(ARGV[2]) then
              local average = total / count
              if winner_average == nil or average < winner_average or
                 (average == winner_average and tonumber(provider_id) < winner_id) then
                winner_id = tonumber(provider_id)
                winner_average = average
              end
            end
          end
          offset = offset + 3
        end

        if redis.call('HLEN', KEYS[1]) == 0 then
          redis.call('DEL', KEYS[1])
        else
          redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
        end
        if winner_id > 0 and KEYS[4] ~= '' then
          redis.call(
            'SET',
            KEYS[4],
            tostring(winner_id) .. ':' .. tostring(current_epoch),
            'EX',
            tonumber(ARGV[3])
          )
        end
        response[2] = tostring(winner_id)
        return response
      `,
      4,
      probeSuccessStateKey(params.sessionId),
      probeEpochKey(params.sessionId),
      probeCancelledKey(params.sessionId),
      params.publishWinner === false ? "" : pendingRebindKey(params.sessionId),
      String(params.expectedEpoch),
      String(PRIORITY_UPGRADE_PROBE.REQUIRED_CONSECUTIVE_SUCCESSES),
      String(ttlSeconds),
      ...normalized.flatMap((outcome) => [
        String(outcome.providerId),
        outcome.success ? "1" : "0",
        String(outcome.firstByteMs),
      ])
    );

    if (!Array.isArray(raw) || Number(raw[0]) !== 1) {
      return { applied: false, winnerProviderId: null, successStates: [] };
    }
    const winner = Number.parseInt(String(raw[1] ?? "0"), 10);
    const successStates: PriorityUpgradeProbeSuccessState[] = [];
    for (let index = 2; index + 2 < raw.length; index += 3) {
      const providerId = Number.parseInt(String(raw[index]), 10);
      const count = Number.parseInt(String(raw[index + 1]), 10);
      const total = Number.parseFloat(String(raw[index + 2]));
      if (providerId > 0 && count > 0 && Number.isFinite(total)) {
        successStates.push({
          providerId,
          consecutiveSuccesses: count,
          totalFirstByteMs: total,
          averageFirstByteMs: total / count,
        });
      }
    }
    return {
      applied: true,
      winnerProviderId: Number.isFinite(winner) && winner > 0 ? winner : null,
      successStates,
    };
  } catch (error) {
    logger.debug("PriorityUpgradeProbe: failed to apply atomic probe batch", {
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { applied: false, winnerProviderId: null, successStates: [] };
  }
}

/**
 * Atomically append one in-SLA success or reset the provider streak on any failure.
 * Kept as a one-outcome wrapper for focused tests and callers outside batch probing.
 */
export async function recordPriorityUpgradeProbeOutcomeIfEpoch(params: {
  sessionId: string;
  providerId: number;
  success: boolean;
  firstByteMs?: number;
  expectedEpoch: number;
}): Promise<PriorityUpgradeProbeSuccessState | null> {
  const result = await applyPriorityUpgradeProbeBatchIfEpoch({
    sessionId: params.sessionId,
    expectedEpoch: params.expectedEpoch,
    publishWinner: false,
    outcomes: [
      {
        providerId: params.providerId,
        success: params.success,
        firstByteMs: params.firstByteMs,
      },
    ],
  });
  if (!result.applied) return null;
  if (!params.success) {
    return {
      providerId: params.providerId,
      consecutiveSuccesses: 0,
      totalFirstByteMs: 0,
      averageFirstByteMs: 0,
    };
  }
  return result.successStates.find((state) => state.providerId === params.providerId) ?? null;
}

export async function clearPriorityUpgradeProbeSuccessStates(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return;
  try {
    await redis.del(probeSuccessStateKey(sessionId), probeContextKey(sessionId));
  } catch {
    // Best effort: SESSION_TTL still bounds stale progress.
  }
}

async function finalizePriorityUpgradeRebindState(params: {
  sessionId: string;
  providerId: number;
  success: boolean;
}): Promise<boolean> {
  const redis = getRedisClient();
  if (redis?.status !== "ready") return false;
  try {
    const result = await redis.eval(
      `
        -- PRIORITY_UPGRADE_REBIND_FINALIZE
        local epoch = redis.call('INCR', KEYS[2])
        redis.call('EXPIRE', KEYS[2], 3600)
        redis.call('SET', KEYS[3], '1', 'EX', 60)
        redis.call('DEL', KEYS[4])
        redis.call('DEL', KEYS[5])
        if ARGV[2] == '1' then
          redis.call('DEL', KEYS[1])
        else
          redis.call('HDEL', KEYS[1], ARGV[1])
          if redis.call('HLEN', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
        end
        return epoch
      `,
      5,
      probeSuccessStateKey(params.sessionId),
      probeEpochKey(params.sessionId),
      probeCancelledKey(params.sessionId),
      pendingRebindKey(params.sessionId),
      probeContextKey(params.sessionId),
      String(params.providerId),
      params.success ? "1" : "0"
    );
    return Number.isFinite(Number(result));
  } catch (error) {
    logger.debug("PriorityUpgradeProbe: failed to finalize real rebind state", {
      sessionId: params.sessionId,
      providerId: params.providerId,
      success: params.success,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Full real-response success: invalidate older probes and clear every candidate streak. */
export function finalizePriorityUpgradeRebindSuccess(
  sessionId: string,
  providerId: number
): Promise<boolean> {
  return finalizePriorityUpgradeRebindState({ sessionId, providerId, success: true });
}

/** Real target failure: invalidate older probes and reset only the failed target. */
export function finalizePriorityUpgradeRebindFailure(
  sessionId: string,
  providerId: number
): Promise<boolean> {
  return finalizePriorityUpgradeRebindState({ sessionId, providerId, success: false });
}

export function selectPriorityUpgradeStreakWinner<
  T extends { provider: { id: number }; successState: PriorityUpgradeProbeSuccessState },
>(candidates: readonly T[]): T | null {
  let winner: T | null = null;
  for (const candidate of candidates) {
    if (
      candidate.successState.consecutiveSuccesses <
      PRIORITY_UPGRADE_PROBE.REQUIRED_CONSECUTIVE_SUCCESSES
    ) {
      continue;
    }
    if (
      !winner ||
      candidate.successState.averageFirstByteMs < winner.successState.averageFirstByteMs ||
      (candidate.successState.averageFirstByteMs === winner.successState.averageFirstByteMs &&
        candidate.provider.id < winner.provider.id)
    ) {
      winner = candidate;
    }
  }
  return winner;
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

/** Fill bounded probe batches from the already priority/weight-ordered candidate list. */
export function createPriorityUpgradeProbeBatches<T>(
  candidates: readonly T[],
  batchSize = PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_LIMIT
): T[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: T[][] = [];
  for (let offset = 0; offset < candidates.length; offset += size) {
    batches.push(candidates.slice(offset, offset + size));
  }
  return batches;
}

/**
 * Collect one logical probe window. Retained outcomes (pass or SLA timeout) consume
 * one of the three slots; direct terminal failures are reported immediately and
 * replaced from the ordered plan without exceeding the concurrency limit.
 */
export async function collectPriorityUpgradeProbeWindow<TProvider, TOutcome>(params: {
  providers: readonly TProvider[];
  startIndex: number;
  execute: (provider: TProvider) => Promise<TOutcome>;
  isDirectFailure: (outcome: TOutcome) => boolean;
  onDirectFailure: (outcome: TOutcome) => Promise<void>;
  windowSize?: number;
}): Promise<{ outcomes: TOutcome[]; nextIndex: number }> {
  const windowSize = Math.max(
    1,
    Math.floor(params.windowSize ?? PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_LIMIT)
  );
  const outcomes: TOutcome[] = [];
  const pending = new Set<Promise<TOutcome>>();
  let nextIndex = Math.max(0, Math.floor(params.startIndex));

  const launchOne = () => {
    if (nextIndex >= params.providers.length) return;
    pending.add(params.execute(params.providers[nextIndex++]));
  };

  while (
    outcomes.length < windowSize &&
    (pending.size > 0 || nextIndex < params.providers.length)
  ) {
    while (pending.size < windowSize - outcomes.length && nextIndex < params.providers.length) {
      launchOne();
    }
    if (pending.size === 0) break;

    const settled = await Promise.race(
      Array.from(pending).map(async (promise) => ({ promise, outcome: await promise }))
    );
    pending.delete(settled.promise);

    if (params.isDirectFailure(settled.outcome)) {
      await params.onDirectFailure(settled.outcome);
      continue;
    }
    outcomes.push(settled.outcome);
  }

  return { outcomes, nextIndex };
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
