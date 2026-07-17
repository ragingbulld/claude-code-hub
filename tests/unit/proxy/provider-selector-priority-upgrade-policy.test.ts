import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

const circuitMocks = vi.hoisted(() => ({
  getCircuitState: vi.fn(() => "closed"),
  isCircuitOpen: vi.fn(async () => false),
}));
vi.mock("@/lib/circuit-breaker", () => circuitMocks);

const vendorCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async (vendorId: number) => vendorId === 33),
}));
vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorCircuitMocks);

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async (providerId: number) => ({ allowed: providerId !== 3 })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
  },
}));
vi.mock("@/lib/rate-limit", () => rateLimitMocks);

const probeMocks = vi.hoisted(() => ({
  consumePendingPriorityRebind: vi.fn(async () => null),
  isPriorityUpgradeProbeEnabled: vi.fn(() => true),
  preparePriorityUpgradeProbeContext: vi.fn(async () => true),
}));
vi.mock("@/lib/priority-upgrade-probe", () => probeMocks);
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn(async () => "UTC") }));

function provider(overrides: Partial<Provider> & Pick<Provider, "id" | "name">): Provider {
  return {
    id: overrides.id,
    name: overrides.name,
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 1,
    costMultiplier: 1,
    firstByteTimeoutStreamingMs: 20_000,
    allowedModels: ["claude-test"],
    allowedClients: [],
    blockedClients: [],
    disableSessionReuse: false,
    providerVendorId: null,
    ...overrides,
  } as Provider;
}

describe("priority-upgrade candidate policy parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("filters client-blocked, cost-limited, and vendor-circuit providers", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const sticky = provider({ id: 10, name: "sticky", priority: 4 });
    const allowed = provider({ id: 1, name: "allowed" });
    const clientBlocked = provider({
      id: 2,
      name: "client-blocked",
      blockedClients: ["bad-client"],
    });
    const costLimited = provider({ id: 3, name: "cost-limited" });
    const vendorCircuit = provider({ id: 4, name: "vendor-circuit", providerVendorId: 33 });
    const allProviders = [sticky, allowed, clientBlocked, costLimited, vendorCircuit];

    const session = {
      sessionId: "priority-policy-session",
      originalFormat: "claude",
      authState: null,
      userAgent: "bad-client/1.0",
      headers: new Headers(),
      request: { message: { metadata: null } },
      getOriginalModel: () => "claude-test",
      getProvidersSnapshot: async () => allProviders,
    };

    const plan = await (
      ProxyProviderResolver as unknown as {
        planPriorityUpgrade: (
          currentSession: typeof session,
          currentSticky: Provider
        ) => Promise<{ candidates: Provider[] } | null>;
      }
    ).planPriorityUpgrade(session, sticky);

    expect(plan?.candidates.map((candidate) => candidate.id)).toEqual([allowed.id]);
    expect(vendorCircuitMocks.isVendorTypeCircuitOpen).toHaveBeenCalledWith(33, "claude");
    expect(rateLimitMocks.RateLimitService.checkCostLimitsWithLease).toHaveBeenCalledWith(
      costLimited.id,
      "provider",
      expect.any(Object)
    );
  });

  test("plans every eligible provider above the sticky priority in tier order", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const sticky = provider({ id: 10, name: "sticky", priority: 5 });
    const p1a = provider({ id: 1, name: "p1-a", priority: 1 });
    const p1b = provider({ id: 2, name: "p1-b", priority: 1 });
    const p3 = provider({ id: 3, name: "p3", priority: 3 });
    const sameTier = provider({ id: 4, name: "same-tier", priority: 5 });
    const lower = provider({ id: 6, name: "lower", priority: 6 });
    rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValue({ allowed: true });

    const session = {
      sessionId: "priority-all-candidates",
      originalFormat: "claude",
      authState: null,
      userAgent: "test-client/1.0",
      headers: new Headers(),
      request: { message: { metadata: null } },
      getOriginalModel: () => "claude-test",
      getProvidersSnapshot: async () => [sticky, p3, sameTier, p1a, lower, p1b],
    };

    const plan = await (
      ProxyProviderResolver as unknown as {
        planPriorityUpgrade: (
          currentSession: typeof session,
          currentSticky: Provider
        ) => Promise<{ candidates: Provider[] } | null>;
      }
    ).planPriorityUpgrade(session, sticky);

    expect(plan?.candidates.map((candidate) => candidate.id)).toEqual([p1a.id, p1b.id, p3.id]);
  });

  test("fills a real three-provider race window across weighted priority tiers", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const excluded = provider({ id: 10, name: "already-launched", priority: 0 });
    const p1Heavy = provider({ id: 1, name: "p1-heavy", priority: 1, weight: 20 });
    const p1Light = provider({ id: 2, name: "p1-light", priority: 1, weight: 1 });
    const p2 = provider({ id: 3, name: "p2", priority: 2, weight: 10 });
    const p3 = provider({ id: 4, name: "p3", priority: 3, weight: 10 });
    rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValue({ allowed: true });

    const session = {
      sessionId: "real-race-weighted-fill",
      originalFormat: "claude",
      authState: null,
      userAgent: "test-client/1.0",
      headers: new Headers(),
      request: { message: { metadata: null } },
      getOriginalModel: () => "claude-test",
      getProvidersSnapshot: async () => [excluded, p1Heavy, p1Light, p2, p3],
    };

    const candidates = await (
      ProxyProviderResolver as unknown as {
        selectPriorityRaceCandidates: (
          currentSession: typeof session,
          excludeIds: number[],
          limit: number
        ) => Promise<Provider[]>;
      }
    ).selectPriorityRaceCandidates(session, [excluded.id], 3);

    expect(candidates.map((candidate) => candidate.id)).toEqual([p1Heavy.id, p1Light.id, p2.id]);
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(3);
  });

  test("orders same-priority probe candidates by weighted sampling without replacement", async () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0.9)
      .mockReturnValueOnce(0);
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const sticky = provider({ id: 10, name: "sticky", priority: 5 });
    const low = provider({ id: 1, name: "low", priority: 1, weight: 1 });
    const zero = provider({ id: 2, name: "zero", priority: 1, weight: 0 });
    const high = provider({ id: 3, name: "high", priority: 1, weight: 20 });
    const medium = provider({ id: 4, name: "medium", priority: 1, weight: 5 });
    rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValue({ allowed: true });

    const session = {
      sessionId: "priority-weighted-order",
      originalFormat: "claude",
      authState: null,
      userAgent: "test-client/1.0",
      headers: new Headers(),
      request: { message: { metadata: null } },
      getOriginalModel: () => "claude-test",
      getProvidersSnapshot: async () => [sticky, low, zero, high, medium],
    };

    const plan = await (
      ProxyProviderResolver as unknown as {
        planPriorityUpgrade: (
          currentSession: typeof session,
          currentSticky: Provider
        ) => Promise<{ candidates: Provider[] } | null>;
      }
    ).planPriorityUpgrade(session, sticky);

    expect(plan?.candidates.map((candidate) => candidate.id)).toEqual([
      high.id,
      medium.id,
      low.id,
      zero.id,
    ]);
    expect(new Set(plan?.candidates.map((candidate) => candidate.id)).size).toBe(4);
  });
});
