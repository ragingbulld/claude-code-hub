import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

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
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  eval: vi.fn(async (script: string, keyCount: number, ...args: string[]) => {
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
  PRIORITY_UPGRADE_PROBE,
  consumePendingPriorityRebind,
  getPendingPriorityRebind,
  isPriorityUpgradeFirstByteSlaMet,
  isPriorityUpgradeProbeEnabled,
  refreshSessionProbeRoundLock,
  releaseProviderProbeLock,
  releaseSessionProbeRoundLock,
  setPendingPriorityRebindIfEpoch,
  tryAcquireProviderProbeLock,
  tryAcquireSessionProbeGate,
  tryAcquireSessionProbeRoundLock,
} from "@/lib/priority-upgrade-probe";

beforeEach(() => {
  store.clear();
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
