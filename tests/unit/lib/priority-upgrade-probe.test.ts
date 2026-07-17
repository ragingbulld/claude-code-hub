import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const hashes = new Map<string, Map<string, string>>();

const redis = {
  status: "ready",
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  set: vi.fn(async (key: string, value: string, ...args: string[]) => {
    if (args.includes("NX") && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }),
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return "OK";
  }),
  hmget: vi.fn(async (key: string, ...fields: string[]) => {
    const hash = hashes.get(key);
    return fields.map((field) => hash?.get(field) ?? null);
  }),
  del: vi.fn(async (...keys: string[]) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key) || hashes.delete(key)) removed += 1;
    }
    return removed;
  }),
  eval: vi.fn(async (script: string, keyCount: number, ...args: string[]) => {
    if (script.includes("PRIORITY_UPGRADE_CONTEXT_PREPARE")) {
      const [contextKey, hashKey, pendingKey, epochKey, cancelledKey, context] = args;
      const changed = store.get(contextKey) !== context;
      if (changed) {
        hashes.delete(hashKey);
        store.delete(pendingKey);
        store.set(epochKey, String(Number(store.get(epochKey) ?? "0") + 1));
        store.delete(cancelledKey);
      }
      store.set(contextKey, context);
      return changed ? 1 : 0;
    }
    if (script.includes("PRIORITY_UPGRADE_BATCH_APPLY")) {
      const [hashKey, epochKey, cancelledKey, pendingKey, expectedEpoch, _required, _ttl] = args;
      if (!hashKey || !epochKey || !cancelledKey || pendingKey == null || !expectedEpoch) {
        return [0];
      }
      if ((store.get(epochKey) ?? "0") !== expectedEpoch) return [0];
      if (store.get(cancelledKey) === "1") return [0];

      const hash = hashes.get(hashKey) ?? new Map<string, string>();
      const response: Array<number | string> = [1, 0];
      let winnerId = 0;
      let winnerAverage = Number.POSITIVE_INFINITY;
      let winnerCount = 0;
      for (let index = 7; index < args.length; index += 3) {
        const providerId = args[index];
        const success = args[index + 1];
        const firstByteMs = args[index + 2];
        if (!providerId || !success || firstByteMs == null) continue;
        if (success !== "1") {
          hash.delete(providerId);
          continue;
        }
        const [countRaw = "0", totalRaw = "0"] = (hash.get(providerId) ?? "0:0").split(":");
        const count = Number.parseInt(countRaw, 10) + 1;
        const total = Number.parseFloat(totalRaw) + Number.parseFloat(firstByteMs);
        hash.set(providerId, `${count}:${total.toFixed(6)}`);
        response.push(providerId, count, total.toFixed(6));
        const average = total / count;
        const numericId = Number.parseInt(providerId, 10);
        if (
          count >= 3 &&
          (average < winnerAverage ||
            (average === winnerAverage &&
              (count > winnerCount || (count === winnerCount && numericId < winnerId))))
        ) {
          winnerId = numericId;
          winnerAverage = average;
          winnerCount = count;
        }
      }
      if (hash.size > 0) hashes.set(hashKey, hash);
      else hashes.delete(hashKey);
      response[1] = winnerId;
      if (pendingKey !== "" && winnerId > 0) {
        store.set(pendingKey, `${winnerId}:${expectedEpoch}`);
      }
      return response;
    }
    if (script.includes("PRIORITY_UPGRADE_REBIND_FINALIZE")) {
      const [hashKey, epochKey, cancelledKey, pendingKey, contextKey, providerId, success] = args;
      if (
        !epochKey ||
        !cancelledKey ||
        !pendingKey ||
        !hashKey ||
        !contextKey ||
        !providerId ||
        !success
      )
        return 0;
      const nextEpoch = Number.parseInt(store.get(epochKey) ?? "0", 10) + 1;
      store.set(epochKey, String(nextEpoch));
      store.set(cancelledKey, "1");
      store.delete(pendingKey);
      store.delete(contextKey);
      if (success === "1") {
        hashes.delete(hashKey);
      } else {
        const hash = hashes.get(hashKey);
        hash?.delete(providerId);
        if (hash?.size === 0) hashes.delete(hashKey);
      }
      return nextEpoch;
    }
    if (keyCount === 1 && script.includes("redis.call('PEXPIRE'")) {
      const [key, ownerToken] = args;
      if (!key || !ownerToken || store.get(key) !== ownerToken) return 0;
      return 1;
    }
    if (keyCount === 1 && script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
      const [key, ownerToken] = args;
      if (!key || !ownerToken || store.get(key) !== ownerToken) return 0;
      store.delete(key);
      return 1;
    }
    if (keyCount === 3 && args.length === 3) {
      const [pendingKey, epochKey, cancelledKey] = args;
      if (!pendingKey || !epochKey || !cancelledKey) return null;
      const value = store.get(pendingKey) ?? null;
      store.delete(pendingKey);
      if (!value || store.get(cancelledKey) === "1") return null;
      const [providerId, pendingEpoch] = value.split(":");
      if (!providerId || pendingEpoch !== (store.get(epochKey) ?? "0")) return null;
      return providerId;
    }

    const [pendingKey, epochKey, cancelledKey, providerId, expectedEpoch] = args;
    if (!pendingKey || !epochKey || !cancelledKey || !providerId || !expectedEpoch) return 0;
    const currentEpoch = store.get(epochKey) ?? "0";
    if (currentEpoch !== expectedEpoch) return 0;
    if (store.get(cancelledKey) === "1") return 0;
    store.set(pendingKey, `${providerId}:${expectedEpoch}`);
    return 1;
  }),
};

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redis,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import {
  applyPriorityUpgradeProbeBatchIfEpoch,
  clearPriorityUpgradeProbeSuccessStates,
  PRIORITY_UPGRADE_PROBE,
  collectPriorityUpgradeProbeWindow,
  consumePendingPriorityRebind,
  createPriorityUpgradeProbeBatches,
  finalizePriorityUpgradeRebindFailure,
  finalizePriorityUpgradeRebindSuccess,
  getPendingPriorityRebind,
  getPriorityUpgradeProbeSuccessStates,
  isPriorityUpgradeFirstByteSlaMet,
  isPriorityUpgradeProbeEnabled,
  preparePriorityUpgradeProbeContext,
  prioritizePriorityUpgradeProbeCandidates,
  recordPriorityUpgradeProbeOutcomeIfEpoch,
  refreshSessionProbeRoundLock,
  releaseProviderProbeLock,
  releaseSessionProbeRoundLock,
  selectPriorityUpgradeStreakWinner,
  setPendingPriorityRebindIfEpoch,
  tryAcquireProviderProbeLock,
  tryAcquireSessionProbeGate,
  tryAcquireSessionProbeRoundLock,
} from "@/lib/priority-upgrade-probe";

beforeEach(() => {
  store.clear();
  hashes.clear();
  redis.status = "ready";
  vi.clearAllMocks();
});

describe("priority-upgrade probe", () => {
  it("exposes bounded probe defaults", () => {
    expect(typeof isPriorityUpgradeProbeEnabled()).toBe("boolean");
    expect(PRIORITY_UPGRADE_PROBE.ROUND_INTERVAL_MS).toBe(60_000);
    expect(PRIORITY_UPGRADE_PROBE.GLOBAL_INFLIGHT_LIMIT).toBe(3);
    expect(PRIORITY_UPGRADE_PROBE.SESSION_ROUND_LOCK_MS).toBe(210_000);
    expect(PRIORITY_UPGRADE_PROBE.SESSION_ROUND_LOCK_REFRESH_MS).toBe(60_000);
    expect(PRIORITY_UPGRADE_PROBE.REQUIRED_CONSECUTIVE_SUCCESSES).toBe(3);
  });

  it("fills a probe batch across priority boundaries", () => {
    const p1 = { id: 1, priority: 1 };
    const p2a = { id: 2, priority: 2 };
    const p2b = { id: 3, priority: 2 };
    const p2c = { id: 4, priority: 2 };

    expect(createPriorityUpgradeProbeBatches([p1, p2a, p2b, p2c])).toEqual([[p1, p2a, p2b], [p2c]]);
  });

  it("immediately refills a probe slot after direct failure", async () => {
    type Outcome = { id: number; state: "ok" | "error" };
    const launched: number[] = [];
    const resolvers = new Map<number, (outcome: Outcome) => void>();
    const onDirectFailure = vi.fn(async () => {});

    const collection = collectPriorityUpgradeProbeWindow({
      providers: [1, 2, 3, 4],
      startIndex: 0,
      execute: (id) => {
        launched.push(id);
        return new Promise<Outcome>((resolve) => resolvers.set(id, resolve));
      },
      isDirectFailure: (outcome) => outcome.state === "error",
      onDirectFailure,
    });

    expect(launched).toEqual([1, 2, 3]);
    resolvers.get(2)!({ id: 2, state: "error" });
    await vi.waitFor(() => expect(launched).toEqual([1, 2, 3, 4]));
    expect(onDirectFailure).toHaveBeenCalledWith({ id: 2, state: "error" });

    resolvers.get(1)!({ id: 1, state: "ok" });
    resolvers.get(3)!({ id: 3, state: "ok" });
    resolvers.get(4)!({ id: 4, state: "ok" });

    await expect(collection).resolves.toEqual({
      outcomes: [
        { id: 1, state: "ok" },
        { id: 3, state: "ok" },
        { id: 4, state: "ok" },
      ],
      nextIndex: 4,
    });
  });

  it("waits for every retained result when multiple providers pass in one batch", async () => {
    type Outcome = { id: number; state: "ok" };
    const resolvers = new Map<number, (outcome: Outcome) => void>();
    let settled = false;
    const collection = collectPriorityUpgradeProbeWindow({
      providers: [1, 2, 3],
      startIndex: 0,
      execute: (id) => new Promise<Outcome>((resolve) => resolvers.set(id, resolve)),
      isDirectFailure: () => false,
      onDirectFailure: async () => {},
    });
    void collection.then(() => {
      settled = true;
    });

    resolvers.get(2)!({ id: 2, state: "ok" });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvers.get(1)!({ id: 1, state: "ok" });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolvers.get(3)!({ id: 3, state: "ok" });

    const result = await collection;
    expect(new Set(result.outcomes.map((outcome) => outcome.id))).toEqual(new Set([1, 2, 3]));
    expect(result.nextIndex).toBe(3);
  });

  it("rejects a success without a finite first-byte measurement", async () => {
    const sessionId = "session-missing-first-byte";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "1");
    expect(
      await recordPriorityUpgradeProbeOutcomeIfEpoch({
        sessionId,
        providerId: 99,
        success: true,
        expectedEpoch: 1,
      })
    ).toBeNull();
    expect(await getPriorityUpgradeProbeSuccessStates(sessionId, [99])).toEqual([]);
  });

  it("keeps consecutive success progress, resets on one failure, and qualifies again at three", async () => {
    const sessionId = "session-three-successes";
    const providerId = 22;
    const expectedEpoch = 7;
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, String(expectedEpoch));

    const first = await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: true,
      firstByteMs: 120,
      expectedEpoch,
    });
    const second = await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: true,
      firstByteMs: 180,
      expectedEpoch,
    });
    expect(first?.consecutiveSuccesses).toBe(1);
    expect(second).toMatchObject({
      consecutiveSuccesses: 2,
      totalFirstByteMs: 300,
      averageFirstByteMs: 150,
    });

    const reset = await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: false,
      expectedEpoch,
    });
    expect(reset?.consecutiveSuccesses).toBe(0);
    await expect(getPriorityUpgradeProbeSuccessStates(sessionId, [providerId])).resolves.toEqual(
      []
    );

    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: true,
      firstByteMs: 90,
      expectedEpoch,
    });
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: true,
      firstByteMs: 110,
      expectedEpoch,
    });
    const third = await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId,
      success: true,
      firstByteMs: 100,
      expectedEpoch,
    });
    expect(third).toMatchObject({
      consecutiveSuccesses: 3,
      totalFirstByteMs: 300,
      averageFirstByteMs: 100,
    });
  });

  it("applies a complete batch atomically and publishes the lowest three-pass average", async () => {
    const sessionId = "session-atomic-batch";
    const expectedEpoch = 5;
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, String(expectedEpoch));

    for (const firstByteMs of [300, 300]) {
      await recordPriorityUpgradeProbeOutcomeIfEpoch({
        sessionId,
        providerId: 11,
        success: true,
        firstByteMs,
        expectedEpoch,
      });
    }
    for (const firstByteMs of [100, 100]) {
      await recordPriorityUpgradeProbeOutcomeIfEpoch({
        sessionId,
        providerId: 22,
        success: true,
        firstByteMs,
        expectedEpoch,
      });
    }
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId: 33,
      success: true,
      firstByteMs: 50,
      expectedEpoch,
    });

    const result = await applyPriorityUpgradeProbeBatchIfEpoch({
      sessionId,
      expectedEpoch,
      outcomes: [
        { providerId: 11, success: true, firstByteMs: 100 },
        { providerId: 22, success: true, firstByteMs: 200 },
        { providerId: 33, success: false },
      ],
    });

    expect(result).toMatchObject({ applied: true, winnerProviderId: 22 });
    expect(result.successStates).toEqual([
      {
        providerId: 11,
        consecutiveSuccesses: 3,
        totalFirstByteMs: 700,
        averageFirstByteMs: 700 / 3,
      },
      {
        providerId: 22,
        consecutiveSuccesses: 3,
        totalFirstByteMs: 400,
        averageFirstByteMs: 400 / 3,
      },
    ]);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBe(22);
    expect(store.get(`session:${sessionId}:priority_upgrade_pending`)).toBe(`22:${expectedEpoch}`);
    await expect(getPriorityUpgradeProbeSuccessStates(sessionId, [33])).resolves.toEqual([]);
  });

  it("invalidates old progress and in-flight epochs when routing context changes", async () => {
    const sessionId = "session-context-scope";
    store.set(`session:${sessionId}:priority_upgrade_probe_context`, "old-context");
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "8");
    const state = await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId: 55,
      success: true,
      firstByteMs: 90,
      expectedEpoch: 8,
    });
    expect(state?.consecutiveSuccesses).toBe(1);
    await setPendingPriorityRebindIfEpoch(sessionId, 55, 8);
    store.set(`session:${sessionId}:priority_upgrade_probe_cancelled`, "1");

    await expect(preparePriorityUpgradeProbeContext(sessionId, "new-context")).resolves.toBe(true);
    await expect(getPriorityUpgradeProbeSuccessStates(sessionId, [55])).resolves.toEqual([]);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBeNull();
    expect(store.get(`session:${sessionId}:priority_upgrade_probe_epoch`)).toBe("9");
    expect(store.has(`session:${sessionId}:priority_upgrade_probe_cancelled`)).toBe(false);
  });

  it("prioritizes candidates with success progress before the frozen weighted remainder", () => {
    const weightedPlan = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const ordered = prioritizePriorityUpgradeProbeCandidates(weightedPlan, [
      {
        providerId: 2,
        consecutiveSuccesses: 1,
        totalFirstByteMs: 80,
        averageFirstByteMs: 80,
      },
      {
        providerId: 3,
        consecutiveSuccesses: 2,
        totalFirstByteMs: 500,
        averageFirstByteMs: 250,
      },
    ]);
    expect(ordered.map((candidate) => candidate.id)).toEqual([3, 2, 1, 4]);
  });

  it("requires three successes and chooses the lowest average when two qualify together", () => {
    const notQualified = {
      provider: { id: 1 },
      successState: {
        providerId: 1,
        consecutiveSuccesses: 2,
        totalFirstByteMs: 100,
        averageFirstByteMs: 50,
      },
    };
    const slowerAverage = {
      provider: { id: 11 },
      successState: {
        providerId: 11,
        consecutiveSuccesses: 3,
        totalFirstByteMs: 600,
        averageFirstByteMs: 200,
      },
    };
    const fasterAverage = {
      provider: { id: 22 },
      successState: {
        providerId: 22,
        consecutiveSuccesses: 3,
        totalFirstByteMs: 450,
        averageFirstByteMs: 150,
      },
    };
    expect(selectPriorityUpgradeStreakWinner([notQualified])).toBeNull();
    expect(selectPriorityUpgradeStreakWinner([notQualified, slowerAverage, fasterAverage])).toBe(
      fasterAverage
    );
  });

  it("finalizes a real pending rebind atomically", async () => {
    const successSession = "session-rebind-success";
    store.set(`session:${successSession}:priority_upgrade_probe_epoch`, "9");
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId: successSession,
      providerId: 22,
      success: true,
      firstByteMs: 100,
      expectedEpoch: 9,
    });
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId: successSession,
      providerId: 33,
      success: true,
      firstByteMs: 120,
      expectedEpoch: 9,
    });
    store.set(`session:${successSession}:priority_upgrade_pending`, "22:9");

    await expect(finalizePriorityUpgradeRebindSuccess(successSession, 22)).resolves.toBe(true);
    expect(store.get(`session:${successSession}:priority_upgrade_probe_epoch`)).toBe("10");
    expect(store.get(`session:${successSession}:priority_upgrade_probe_cancelled`)).toBe("1");
    expect(store.has(`session:${successSession}:priority_upgrade_pending`)).toBe(false);
    await expect(getPriorityUpgradeProbeSuccessStates(successSession, [22, 33])).resolves.toEqual(
      []
    );

    const failureSession = "session-rebind-failure";
    store.set(`session:${failureSession}:priority_upgrade_probe_epoch`, "4");
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId: failureSession,
      providerId: 22,
      success: true,
      firstByteMs: 100,
      expectedEpoch: 4,
    });
    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId: failureSession,
      providerId: 33,
      success: true,
      firstByteMs: 120,
      expectedEpoch: 4,
    });

    await expect(finalizePriorityUpgradeRebindFailure(failureSession, 22)).resolves.toBe(true);
    expect(store.get(`session:${failureSession}:priority_upgrade_probe_epoch`)).toBe("5");
    await expect(getPriorityUpgradeProbeSuccessStates(failureSession, [22, 33])).resolves.toEqual([
      {
        providerId: 33,
        consecutiveSuccesses: 1,
        totalFirstByteMs: 120,
        averageFirstByteMs: 120,
      },
    ]);
  });

  it("rejects stale streak updates and clears all progress only after a real rebind", async () => {
    const sessionId = "session-stale-streak";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "9");
    await expect(
      recordPriorityUpgradeProbeOutcomeIfEpoch({
        sessionId,
        providerId: 5,
        success: true,
        firstByteMs: 100,
        expectedEpoch: 8,
      })
    ).resolves.toBeNull();

    await recordPriorityUpgradeProbeOutcomeIfEpoch({
      sessionId,
      providerId: 5,
      success: true,
      firstByteMs: 100,
      expectedEpoch: 9,
    });
    await expect(getPriorityUpgradeProbeSuccessStates(sessionId, [5])).resolves.toHaveLength(1);
    await clearPriorityUpgradeProbeSuccessStates(sessionId);
    await expect(getPriorityUpgradeProbeSuccessStates(sessionId, [5])).resolves.toEqual([]);
  });

  it("allows one complete probe round per session interval", async () => {
    const sessionId = "session-round-gate";

    await expect(tryAcquireSessionProbeGate(sessionId)).resolves.toBe(true);
    await expect(tryAcquireSessionProbeGate(sessionId)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith(
      `session:${sessionId}:priority_upgrade_probe_gate`,
      "1",
      "PX",
      60_000,
      "NX"
    );
  });

  it("allows only one in-flight probe round per session and renews its owner lease", async () => {
    const sessionId = "session-round-inflight";
    const lockKey = `session:${sessionId}:priority_upgrade_probe_inflight`;

    const owner = await tryAcquireSessionProbeRoundLock(sessionId);
    expect(owner).toBeTruthy();
    await expect(tryAcquireSessionProbeRoundLock(sessionId)).resolves.toBeNull();
    await expect(refreshSessionProbeRoundLock(sessionId, owner!)).resolves.toBe(true);
    expect(store.get(lockKey)).toBe(owner);
    expect(redis.set).toHaveBeenCalledWith(lockKey, owner, "PX", 210_000, "NX");
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("PEXPIRE"),
      1,
      lockKey,
      owner,
      "210000"
    );

    await releaseSessionProbeRoundLock(sessionId, owner!);
    expect(store.has(lockKey)).toBe(false);
    await expect(tryAcquireSessionProbeRoundLock(sessionId)).resolves.toBeTruthy();
  });

  it("does not let an expired round owner renew or release a newer session lease", async () => {
    const sessionId = "session-round-owner-safe";
    const lockKey = `session:${sessionId}:priority_upgrade_probe_inflight`;
    const oldOwner = await tryAcquireSessionProbeRoundLock(sessionId);
    expect(oldOwner).toBeTruthy();

    store.delete(lockKey); // simulate lease expiry
    const newOwner = await tryAcquireSessionProbeRoundLock(sessionId);
    expect(newOwner).toBeTruthy();
    expect(newOwner).not.toBe(oldOwner);

    await expect(refreshSessionProbeRoundLock(sessionId, oldOwner!)).resolves.toBe(false);
    await releaseSessionProbeRoundLock(sessionId, oldOwner!);
    expect(store.get(lockKey)).toBe(newOwner);
  });

  it("fails closed when Redis cannot protect the session round", async () => {
    redis.status = "connecting";
    await expect(tryAcquireSessionProbeRoundLock("session-no-redis")).resolves.toBeNull();
  });

  it("qualifies providers by first-byte SLA", () => {
    expect(isPriorityUpgradeFirstByteSlaMet({ success: true, firstByteMs: 400 }, 500)).toBe(true);
    expect(isPriorityUpgradeFirstByteSlaMet({ success: true, firstByteMs: 600 }, 500)).toBe(false);
    expect(isPriorityUpgradeFirstByteSlaMet({ success: true }, 500)).toBe(false);
    expect(isPriorityUpgradeFirstByteSlaMet({ success: false, firstByteMs: 100 }, 500)).toBe(false);
  });

  it("publishes pending rebind only when the session epoch is unchanged", async () => {
    const sessionId = "session-current";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "4");

    await expect(setPendingPriorityRebindIfEpoch(sessionId, 22, 4)).resolves.toBe(true);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBe(22);
  });

  it("atomically consumes a pending rebind only once", async () => {
    const sessionId = "session-consume-once";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "4");
    await expect(setPendingPriorityRebindIfEpoch(sessionId, 22, 4)).resolves.toBe(true);

    const results = await Promise.all([
      consumePendingPriorityRebind(sessionId),
      consumePendingPriorityRebind(sessionId),
    ]);

    expect(results.filter((id) => id === 22)).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(1);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBeNull();
  });

  it("rejects a stale result after a real race advances the epoch", async () => {
    const sessionId = "session-stale";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "5");

    await expect(setPendingPriorityRebindIfEpoch(sessionId, 22, 4)).resolves.toBe(false);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBeNull();
  });

  it("rejects a result while the cancellation flag is active", async () => {
    const sessionId = "session-cancelled";
    store.set(`session:${sessionId}:priority_upgrade_probe_epoch`, "4");
    store.set(`session:${sessionId}:priority_upgrade_probe_cancelled`, "1");

    await expect(setPendingPriorityRebindIfEpoch(sessionId, 22, 4)).resolves.toBe(false);
    await expect(getPendingPriorityRebind(sessionId)).resolves.toBeNull();
  });

  it("drops published pending state if epoch or cancellation changed before consumption", async () => {
    const staleSession = "session-stale-consume";
    store.set(`session:${staleSession}:priority_upgrade_probe_epoch`, "4");
    await expect(setPendingPriorityRebindIfEpoch(staleSession, 22, 4)).resolves.toBe(true);
    store.set(`session:${staleSession}:priority_upgrade_probe_epoch`, "5");
    await expect(consumePendingPriorityRebind(staleSession)).resolves.toBeNull();

    const cancelledSession = "session-cancel-consume";
    store.set(`session:${cancelledSession}:priority_upgrade_probe_epoch`, "4");
    await expect(setPendingPriorityRebindIfEpoch(cancelledSession, 22, 4)).resolves.toBe(true);
    store.set(`session:${cancelledSession}:priority_upgrade_probe_cancelled`, "1");
    await expect(consumePendingPriorityRebind(cancelledSession)).resolves.toBeNull();
  });

  it("does not let an expired lock owner release a newer provider lock", async () => {
    const providerId = 22;
    const lockKey = `cch:priority_upgrade:lock:${providerId}`;
    const oldOwner = await tryAcquireProviderProbeLock(providerId);
    expect(oldOwner).toBeTruthy();

    store.delete(lockKey); // simulate lease expiry
    const newOwner = await tryAcquireProviderProbeLock(providerId);
    expect(newOwner).toBeTruthy();
    expect(newOwner).not.toBe(oldOwner);

    await releaseProviderProbeLock(providerId, oldOwner!);
    expect(store.get(lockKey)).toBe(newOwner);
    await releaseProviderProbeLock(providerId, newOwner!);
    expect(store.has(lockKey)).toBe(false);
  });
});
