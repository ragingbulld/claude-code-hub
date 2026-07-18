import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { Window } from "happy-dom";
import { describe, expect, test, vi } from "vitest";
import providerChainMessages from "../../../../../../messages/en/provider-chain.json";

vi.mock("@/lib/utils/provider-chain-formatter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/provider-chain-formatter")>();
  return {
    ...actual,
    formatProviderDescription: () => "provider description",
  };
});

vi.mock("@/components/ui/tooltip", () => {
  type PropsWithChildren = { children?: ReactNode };

  function TooltipProvider({ children }: PropsWithChildren) {
    return <div data-slot="tooltip-provider">{children}</div>;
  }

  function Tooltip({ children }: PropsWithChildren) {
    return <div data-slot="tooltip-root">{children}</div>;
  }

  function TooltipTrigger({ children }: PropsWithChildren) {
    return <div data-slot="tooltip-trigger">{children}</div>;
  }

  function TooltipContent({ children }: PropsWithChildren) {
    return <div data-slot="tooltip-content">{children}</div>;
  }

  return { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
});

vi.mock("@/components/ui/popover", () => {
  type PropsWithChildren = { children?: ReactNode };

  function Popover({ children }: PropsWithChildren) {
    return <div data-slot="popover-root">{children}</div>;
  }

  function PopoverTrigger({ children }: PropsWithChildren) {
    return <div data-slot="popover-trigger">{children}</div>;
  }

  function PopoverContent({ children, ...props }: React.ComponentProps<"div"> & PropsWithChildren) {
    return (
      <div data-slot="popover-content" {...props}>
        {children}
      </div>
    );
  }

  return { Popover, PopoverTrigger, PopoverContent };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    className,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string }) => (
    <button className={className} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: React.ComponentProps<"span"> & { variant?: string }) => (
    <span data-slot="badge" className={className}>
      {children}
    </span>
  ),
}));

import { buildPriorityUpgradeProbeRecords, ProviderChainPopover } from "./provider-chain-popover";

const messages = {
  dashboard: {
    logs: {
      table: {
        times: "times",
      },
      providerChain: {
        decisionChain: "Decision chain",
      },
      details: {
        clickStatusCode: "Click status code",
        fake200ForwardedNotice: "Note: payload may have been forwarded",
        fake200DetectedReason: "Detected reason: {reason}",
        fake200RetryTooltipLabel: "Why no server retry?",
        fake200RetryTooltipTitle: "Why CCH cannot retry this response on the server",
        fake200RetryTooltipServerRetry:
          "The upstream already returned HTTP 200, so CCH had started forwarding the SSE body before the error appeared in-stream. Once that error is recognized, this response can no longer be retried gracefully on the server.",
        fake200RetryTooltipSessionFallback:
          "Clients can retry on their side; later requests in the same session will avoid this fake-200 provider and continue fallback.",
        statusCodeInferredBadge: "Inferred",
        statusCodeInferredTooltip: "This status code is inferred from response body content.",
        statusCodeInferredSuffix: "(inferred)",
        fake200Reasons: {
          emptyBody: "Empty response body",
          htmlBody: "HTML document returned",
          jsonErrorNonEmpty: "JSON has non-empty error field",
          jsonErrorMessageNonEmpty: "JSON has non-empty error.message",
          jsonMessageKeywordMatch: 'JSON message contains "error"',
          unknown: "Response body indicates an error",
        },
      },
    },
  },
  "provider-chain": {
    ...providerChainMessages,
    summary: {
      ...providerChainMessages.summary,
      originHint: "Session reuse - originally selected via {method}",
    },
  },
};

function renderWithIntl(node: ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <div id="root">{node}</div>
    </NextIntlClientProvider>
  );
}

function parseHtml(html: string) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document;
}

describe("provider-chain-popover probability formatting", () => {
  test("renders probability 0.5 as 50% in tooltip", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "initial_selection",
            decisionContext: {
              totalProviders: 2,
              enabledProviders: 2,
              targetType: "claude",
              groupFilterApplied: false,
              beforeHealthCheck: 2,
              afterHealthCheck: 2,
              priorityLevels: [1],
              selectedPriority: 1,
              candidatesAtPriority: [
                { id: 1, name: "p1", weight: 50, costMultiplier: 1, probability: 0.5 },
                { id: 2, name: "p2", weight: 50, costMultiplier: 1, probability: 0.5 },
              ],
            },
          },
          { id: 1, name: "p1", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="p1"
      />
    );

    // Should show 50%, not 0%
    expect(html).toContain("50%");
    expect(html).not.toContain("0.5%");
  });

  test("renders probability 100 (out-of-range) as 100% not 10000%", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "initial_selection",
            decisionContext: {
              totalProviders: 2,
              enabledProviders: 2,
              targetType: "claude",
              groupFilterApplied: false,
              beforeHealthCheck: 2,
              afterHealthCheck: 2,
              priorityLevels: [1],
              selectedPriority: 1,
              candidatesAtPriority: [
                { id: 1, name: "p1", weight: 100, costMultiplier: 1, probability: 100 },
                { id: 2, name: "p2", weight: 0, costMultiplier: 1, probability: 0 },
              ],
            },
          },
          { id: 1, name: "p1", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="p1"
      />
    );

    // Should show 100%, not 10000%
    expect(html).toContain("100%");
    expect(html).not.toContain("10000%");
  });

  test("hides probability when undefined", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "initial_selection",
            decisionContext: {
              totalProviders: 1,
              enabledProviders: 1,
              targetType: "claude",
              groupFilterApplied: false,
              beforeHealthCheck: 1,
              afterHealthCheck: 1,
              priorityLevels: [1],
              selectedPriority: 1,
              candidatesAtPriority: [{ id: 1, name: "p1", weight: 100, costMultiplier: 1 }],
            },
          },
          { id: 1, name: "p1", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="p1"
      />
    );

    // Should not show any percentage
    expect(html).not.toMatch(/\d+%\)/);
  });
});

describe("provider-chain-popover priority-upgrade test marker", () => {
  test("renders an icon-only marker for a single successful request that triggered a probe", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "sticky", reason: "session_reuse" },
          { id: 1, name: "sticky", reason: "request_success", statusCode: 200 },
          {
            id: 2,
            name: "higher-priority",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
            priority: 2,
            costMultiplier: 0.01,
          },
        ]}
        finalProvider="sticky"
      />
    );

    const document = parseHtml(html);
    const marker = document.querySelector('[data-priority-upgrade-test="true"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe("");
    expect(marker?.getAttribute("data-probe-status")).toBe("testing");
    expect(marker?.classList.contains("text-sky-500")).toBe(true);
    expect(marker?.querySelector(".animate-spin")).not.toBeNull();
    expect(marker?.getAttribute("title")).toBeNull();
    expect(marker?.getAttribute("aria-label")).toBe("Open priority-upgrade test details");
    const details = document.querySelector('[data-priority-upgrade-probe-details="true"]');
    expect(details?.textContent).toContain("Priority upgrade test");
    expect(details?.textContent).toContain("higher-priority");
    expect(details?.textContent).toContain("Testing");
    expect(details?.textContent).toContain("P2");
    expect(details?.textContent).toContain("x0.01");
  });

  test("renders a completed failure without a spinner and shows first-byte latency", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "sticky", reason: "session_reuse" },
          { id: 1, name: "sticky", reason: "request_success", statusCode: 200 },
          {
            id: 2,
            name: "candidate",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
            priority: 2,
            costMultiplier: 0.01,
          },
          {
            id: 2,
            name: "candidate",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_fail_status=red_first_byte_ms=824_streak=0/3",
            priority: 2,
            costMultiplier: 0.01,
          },
        ]}
        finalProvider="sticky"
      />
    );

    const document = parseHtml(html);
    const marker = document.querySelector('[data-priority-upgrade-test="true"]');
    expect(marker?.getAttribute("data-probe-status")).toBe("failed");
    expect(marker?.classList.contains("text-rose-500")).toBe(true);
    expect(marker?.querySelector(".animate-spin")).toBeNull();
    const details = document.querySelector('[data-priority-upgrade-probe-details="true"]');
    expect(details?.textContent).toContain("Test failed");
    expect(details?.textContent).toContain("Successful probes 0/3");
    expect(details?.querySelector('[data-probe-streak="0/3"]')).not.toBeNull();
    expect(details?.textContent).toContain("First byte 824ms");
  });

  test("shows independent 1/3 and 2/3 success counts for candidates in the same batch", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 2,
            name: "candidate-one",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
          },
          {
            id: 3,
            name: "candidate-two",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
          },
          {
            id: 2,
            name: "candidate-one",
            reason: "priority_upgrade_probe",
            errorMessage:
              "cheap_test_ok_not_selected_streak=1/3_first_byte_ms=620_average_first_byte_ms=620",
          },
          {
            id: 3,
            name: "candidate-two",
            reason: "priority_upgrade_probe",
            errorMessage:
              "cheap_test_ok_not_selected_streak=2/3_first_byte_ms=540_average_first_byte_ms=560",
          },
        ]}
        finalProvider="sticky"
      />
    );

    const details = parseHtml(html).querySelector('[data-priority-upgrade-probe-details="true"]');
    expect(details?.textContent).toContain("Successful probes 1/3");
    expect(details?.textContent).toContain("Successful probes 2/3");
    expect(details?.querySelector('[data-probe-streak="1/3"]')).not.toBeNull();
    expect(details?.querySelector('[data-probe-streak="2/3"]')).not.toBeNull();
  });

  test("uses cyan for a completed winning probe", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "sticky", reason: "session_reuse" },
          { id: 1, name: "sticky", reason: "request_success", statusCode: 200 },
          {
            id: 2,
            name: "candidate",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
          },
          {
            id: 2,
            name: "candidate",
            reason: "priority_upgrade_probe",
            errorMessage:
              "cheap_test_ok_pending_rebind_streak=3/3_first_byte_ms=320_average_first_byte_ms=280",
          },
        ]}
        finalProvider="sticky"
      />
    );

    const document = parseHtml(html);
    const marker = document.querySelector('[data-priority-upgrade-test="true"]');
    expect(marker?.getAttribute("data-probe-status")).toBe("passed");
    expect(marker?.classList.contains("text-cyan-500")).toBe(true);
    expect(marker?.querySelector(".animate-spin")).toBeNull();
    const details = document.querySelector('[data-priority-upgrade-probe-details="true"]');
    expect(details?.textContent).toContain("Successful probes 3/3");
    expect(details?.querySelector('[data-probe-streak="3/3"]')).not.toBeNull();
  });

  test("groups raw start and terminal events into one status per provider", () => {
    const records = buildPriorityUpgradeProbeRecords([
      { id: 2, name: "winner", reason: "priority_upgrade_probe", errorMessage: "cheap_test_start" },
      { id: 3, name: "slower", reason: "priority_upgrade_probe", errorMessage: "cheap_test_start" },
      {
        id: 4,
        name: "errored",
        reason: "priority_upgrade_probe",
        errorMessage: "cheap_test_start",
      },
      {
        id: 3,
        name: "slower",
        reason: "priority_upgrade_probe",
        errorMessage:
          "cheap_test_ok_not_selected_streak=2/3_first_byte_ms=900_average_first_byte_ms=850",
      },
      {
        id: 4,
        name: "errored",
        reason: "priority_upgrade_probe",
        errorMessage: "cheap_test_error_streak=0/3",
      },
      {
        id: 2,
        name: "winner",
        reason: "priority_upgrade_probe",
        errorMessage:
          "cheap_test_ok_pending_rebind_streak=3/3_first_byte_ms=500_average_first_byte_ms=470",
      },
    ]);

    expect(
      records.map((record) => [
        record.provider.id,
        record.status,
        record.firstByteMs,
        record.consecutiveSuccesses,
        record.requiredSuccesses,
      ])
    ).toEqual([
      [2, "passed", 500, 3, 3],
      [3, "passedNotSelected", 900, 2, 3],
      [4, "failed", undefined, 0, 3],
    ]);
  });

  test("does not render the marker when the request did not trigger a probe", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "sticky", reason: "session_reuse" },
          { id: 1, name: "sticky", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="sticky"
      />
    );

    const document = parseHtml(html);
    expect(document.querySelector('[data-priority-upgrade-test="true"]')).toBeNull();
  });

  test("also renders the icon-only marker in retry or hedge popover triggers", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "first", reason: "retry_failed", statusCode: 500 },
          { id: 2, name: "winner", reason: "retry_success", statusCode: 200 },
          {
            id: 3,
            name: "higher-priority",
            reason: "priority_upgrade_probe",
            errorMessage: "cheap_test_start",
          },
        ]}
        finalProvider="winner"
      />
    );

    const document = parseHtml(html);
    const marker = document.querySelector('[data-priority-upgrade-test="true"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toBe("");
  });
});

describe("provider-chain-popover group badges", () => {
  test("renders multiple deduped group badges with tooltip content", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "initial_selection",
            decisionContext: {
              totalProviders: 1,
              enabledProviders: 1,
              targetType: "claude",
              groupFilterApplied: false,
              beforeHealthCheck: 1,
              afterHealthCheck: 1,
              priorityLevels: [1],
              selectedPriority: 1,
              candidatesAtPriority: [{ id: 1, name: "p1", weight: 100, costMultiplier: 1 }],
            },
          },
          {
            id: 2,
            name: "p1",
            reason: "retry_failed",
            statusCode: 500,
          },
          {
            id: 3,
            name: "p1",
            reason: "request_success",
            statusCode: 200,
            groupTag: "alpha, beta, alpha",
          },
        ]}
        finalProvider="p1"
      />
    );

    const document = parseHtml(html);
    const badgeTexts = Array.from(document.querySelectorAll("[data-slot='badge']")).map(
      (node) => node.textContent
    );
    expect(badgeTexts.filter((text) => text === "alpha").length).toBe(1);
    expect(badgeTexts.filter((text) => text === "beta").length).toBe(1);
    expect(document.body.textContent).toContain("alpha");
    expect(document.body.textContent).toContain("beta");
  });
});

describe("provider-chain-popover layout", () => {
  test("renders fake-200 forwarded notice when chain has FAKE_200_* errorMessage", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "retry_failed",
            statusCode: 502,
            errorMessage: "FAKE_200_EMPTY_BODY",
          },
        ]}
        finalProvider="p1"
      />
    );

    expect(html).toContain("Note: payload may have been forwarded");
    expect(html).toContain("Why CCH cannot retry this response on the server");
    expect(html).toContain(
      "The upstream already returned HTTP 200, so CCH had started forwarding the SSE body before the error appeared in-stream. Once that error is recognized, this response can no longer be retried gracefully on the server."
    );
    expect(html).toContain(
      "Clients can retry on their side; later requests in the same session will avoid this fake-200 provider and continue fallback."
    );
  });

  test("renders inferred status code badge when statusCodeInferred=true", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "retry_failed",
            statusCode: 429,
            statusCodeInferred: true,
          },
        ]}
        finalProvider="p1"
      />
    );

    expect(html).toContain("Inferred");
  });

  test("requestCount<=1 branch keeps truncation container shrinkable", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[{ id: 1, name: "p1", reason: "request_success", statusCode: 200 }]}
        finalProvider={"Very long provider name that should truncate"}
      />
    );
    const document = parseHtml(html);

    const container = document.querySelector("#root > div");
    const containerClass = container?.getAttribute("class") ?? "";
    expect(containerClass).toContain("min-w-0");
    expect(containerClass).toContain("w-full");

    const truncateNode = document.querySelector("#root span.truncate");
    expect(truncateNode).not.toBeNull();
  });

  test("session_reuse item with selectionMethod shows origin hint text", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "session_reuse",
            selectionMethod: "weighted_random",
          },
          { id: 1, name: "p1", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="p1"
      />
    );
    expect(html).toContain("Weighted Random");
    expect(html).toContain("Session reuse - originally selected via");
  });

  test("non-session-reuse item does NOT show origin hint", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          {
            id: 1,
            name: "p1",
            reason: "initial_selection",
            decisionContext: {
              totalProviders: 1,
              enabledProviders: 1,
              targetType: "claude",
              groupFilterApplied: false,
              beforeHealthCheck: 1,
              afterHealthCheck: 1,
              priorityLevels: [1],
              selectedPriority: 1,
              candidatesAtPriority: [
                { id: 1, name: "p1", weight: 100, costMultiplier: 1, probability: 1 },
              ],
            },
          },
          { id: 1, name: "p1", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider="p1"
      />
    );
    expect(html).not.toContain("Session reuse - originally selected via");
  });

  test("requestCount>1 branch uses w-full/min-w-0 button and flex-1 name container", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "p1", reason: "retry_failed" },
          { id: 2, name: "p2", reason: "request_success", statusCode: 200 },
        ]}
        finalProvider={"Very long provider name that should truncate"}
      />
    );
    const document = parseHtml(html);

    const button = document.querySelector("#root button");
    expect(button).not.toBeNull();
    const buttonClass = button?.getAttribute("class") ?? "";
    expect(buttonClass).toContain("w-full");
    expect(buttonClass).toContain("min-w-0");

    // The button contains a span with flex+min-w-0, and inside it the provider name span has truncate+min-w-0
    const buttonInnerSpan = document.querySelector("#root button span.flex.min-w-0");
    expect(buttonInnerSpan).not.toBeNull();

    // The name container has truncate and min-w-0
    const nameContainer = document.querySelector("#root button span.truncate.min-w-0");
    expect(nameContainer).not.toBeNull();

    // Find the count badge by checking content (it should contain "times" text from translation)
    const countBadge = Array.from(document.querySelectorAll('#root [data-slot="badge"]')).find(
      (node) => (node.textContent ?? "").includes("times")
    );
    expect(countBadge).not.toBeUndefined();
  });
});

describe("provider-chain-popover hedge/abort reason handling", () => {
  test("hedge_triggered is not counted as actual request", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "p1", reason: "initial_selection" },
          { id: 1, name: "p1", reason: "hedge_triggered", attemptNumber: 1 },
          { id: 2, name: "p2", reason: "hedge_winner", statusCode: 200, attemptNumber: 2 },
          { id: 1, name: "p1", reason: "hedge_loser_cancelled", attemptNumber: 1 },
        ]}
        finalProvider="p2"
      />
    );

    // hedge_triggered is informational, not an actual request
    // so the request count should be 2 (winner + loser), not 3
    const document = parseHtml(html);
    const requestRows = document.querySelectorAll("#root .relative.flex.gap-2");
    expect(requestRows).toHaveLength(2);
  });

  test("hedge_winner is treated as successful provider", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "p1", reason: "initial_selection" },
          { id: 2, name: "p2", reason: "hedge_winner", statusCode: 200, attemptNumber: 2 },
          { id: 1, name: "p1", reason: "hedge_loser_cancelled", attemptNumber: 1 },
        ]}
        finalProvider="p2"
      />
    );

    // Should render without error
    expect(html).toContain("p2");
  });

  test("client_abort is counted as actual request", () => {
    const html = renderWithIntl(
      <ProviderChainPopover
        chain={[
          { id: 1, name: "p1", reason: "initial_selection" },
          { id: 1, name: "p1", reason: "client_abort", attemptNumber: 1 },
        ]}
        finalProvider="p1"
      />
    );

    // client_abort should be counted as actual request (requestCount=1 -> single view)
    expect(html).toContain("p1");
  });
});
