import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Unit-level contract for sticky first-byte timeout streak helpers.
 * Uses a minimal redis mock so we don't need a live Redis.
 */

const store = new Map<string, string>();

vi.mock("@/lib/redis", () => {
  return {
    getRedisClient: () => ({
      status: "ready",
      incr: async (key: string) => {
        const next = Number.parseInt(store.get(key) ?? "0", 10) + 1;
        store.set(key, String(next));
        return next;
      },
      expire: async () => 1,
      del: async (...keys: string[]) => {
        for (const k of keys) store.delete(k);
        return keys.length;
      },
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      },
      setex: async (key: string, _ttl: number, value: string) => {
        store.set(key, value);
        return "OK";
      },
      eval: async (_script: string, _keyCount: number, ...args: string[]) => {
        const [epochKey, cancelledKey, pendingKey] = args;
        if (!epochKey || !cancelledKey || !pendingKey) return 0;
        const next = Number.parseInt(store.get(epochKey) ?? "0", 10) + 1;
        store.set(epochKey, String(next));
        store.set(cancelledKey, "1");
        store.delete(pendingKey);
        return next;
      },
      pipeline: () => {
        const operations: Array<() => void> = [];
        const pipeline = {
          incr: (key: string) => {
            operations.push(() => {
              const next = Number.parseInt(store.get(key) ?? "0", 10) + 1;
              store.set(key, String(next));
            });
            return pipeline;
          },
          expire: () => pipeline,
          set: (key: string, value: string) => {
            operations.push(() => store.set(key, value));
            return pipeline;
          },
          del: (key: string) => {
            operations.push(() => store.delete(key));
            return pipeline;
          },
          exec: async () => {
            for (const operation of operations) operation();
            return [];
          },
        };
        return pipeline;
      },
    }),
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

import { SessionManager } from "@/lib/session-manager";

describe("SessionManager sticky first-byte timeout streak", () => {
  beforeEach(() => {
    store.clear();
  });

  it("first consecutive timeout is soft grace; second is hard exclude", async () => {
    const sid = "sess_test_soft_grace";
    const first = await SessionManager.recordStickyFirstByteTimeout(sid);
    expect(first.hardExclude).toBe(false);
    expect(first.streak).toBe(1);

    const second = await SessionManager.recordStickyFirstByteTimeout(sid);
    expect(second.hardExclude).toBe(true);
    expect(second.streak).toBe(2);
  });

  it("success resets streak so a later timeout is soft again", async () => {
    const sid = "sess_test_reset";
    await SessionManager.recordStickyFirstByteTimeout(sid);
    await SessionManager.resetStickyFirstByteTimeoutStreak(sid);
    const again = await SessionManager.recordStickyFirstByteTimeout(sid);
    expect(again.hardExclude).toBe(false);
    expect(again.streak).toBe(1);
  });

  it("probe cancel flag can be set, read, and cleared", async () => {
    const sid = "sess_test_probe_cancel";
    expect(await SessionManager.isPriorityUpgradeProbeCancelled(sid)).toBe(false);
    expect(await SessionManager.getPriorityUpgradeProbeEpoch(sid)).toBe(0);
    await SessionManager.markPriorityUpgradeProbeCancelled(sid);
    expect(await SessionManager.isPriorityUpgradeProbeCancelled(sid)).toBe(true);
    expect(await SessionManager.getPriorityUpgradeProbeEpoch(sid)).toBe(1);
    await SessionManager.clearPriorityUpgradeProbeCancelled(sid);
    expect(await SessionManager.isPriorityUpgradeProbeCancelled(sid)).toBe(false);
    expect(await SessionManager.getPriorityUpgradeProbeEpoch(sid)).toBe(1);
    await SessionManager.markPriorityUpgradeProbeCancelled(sid);
    expect(await SessionManager.getPriorityUpgradeProbeEpoch(sid)).toBe(2);
  });
});
