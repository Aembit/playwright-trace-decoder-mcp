import { describe, expect, it } from "vitest";
import { extractMetadata, extractNetwork } from "../src/trace-parser.js";
import { StackFrame, TraceEvent } from "../src/types.js";

describe("extractMetadata test title resolution", () => {
  it("uses ctx.title if present on context-options", () => {
    const events: TraceEvent[] = [
      {
        type: "context-options",
        title: "node_playwright_test_case",
        browserName: "chromium",
        platform: "linux",
      },
    ];

    const meta = extractMetadata(events);
    expect(meta.testTitle).toBe("node_playwright_test_case");
    expect(meta.browser).toBe("chromium");
  });

  it("resolves test function from trace.stacks when ctx.title is absent", () => {
    const events: TraceEvent[] = [
      {
        type: "context-options",
        browserName: "chromium",
        platform: "linux",
      },
    ];

    const stacks = new Map<number, StackFrame[]>([
      [
        1001,
        [
          {
            file: "/app/tests/test_login.py",
            line: 42,
            column: 0,
            function: "test_valid_login_redirect",
          },
          {
            file: "/usr/lib/python3.11/site-packages/_pytest/runner.py",
            line: 100,
            column: 0,
            function: "pytest_runtest_call",
          },
        ],
      ],
    ]);

    const meta = extractMetadata(events, stacks);
    expect(meta.testTitle).toBe("test_valid_login_redirect");
  });

  it("falls back to zip base filename when ctx.title and stacks are absent", () => {
    const events: TraceEvent[] = [
      {
        type: "context-options",
        browserName: "webkit",
      },
    ];

    const meta = extractMetadata(
      events,
      undefined,
      "/artifacts/test_user_profile_edit-retry1.pwtrace.zip"
    );
    expect(meta.testTitle).toBe("test_user_profile_edit");
  });
});

describe("extractNetwork monotonic timestamp normalization and resource resolution", () => {
  it("normalizes ISO wall timestamp to monotonic time using context-options baseline", () => {
    const traceEvents: TraceEvent[] = [
      {
        type: "context-options",
        wallTime: 1700000000000,
        monotonicTime: 50000,
      },
    ];

    const networkEvents: TraceEvent[] = [
      {
        type: "resource-snapshot",
        snapshot: {
          request: { method: "GET", url: "https://example.com/api/v1/users" },
          response: { status: 200, content: { mimeType: "application/json" } },
          startedDateTime: new Date(1700000002500).toISOString(),
          time: 150,
        },
      },
    ];

    const entries = extractNetwork(networkEvents, traceEvents);
    expect(entries).toHaveLength(1);
    // 50000 + (1700000002500 - 1700000000000) = 52500
    expect(entries[0].startTime).toBe(52500);
    expect(entries[0].duration).toBe(150);
  });

  it("prefers _monotonicTime when present", () => {
    const traceEvents: TraceEvent[] = [
      {
        type: "context-options",
        wallTime: 1700000000000,
        monotonicTime: 50000,
      },
    ];

    const networkEvents: TraceEvent[] = [
      {
        type: "resource-snapshot",
        snapshot: {
          _monotonicTime: 65432,
          request: { method: "POST", url: "https://example.com/api/v1/auth" },
          response: { status: 201, content: { mimeType: "application/json" } },
          startedDateTime: new Date(1700000002500).toISOString(),
          time: 200,
        },
      },
    ];

    const entries = extractNetwork(networkEvents, traceEvents);
    expect(entries).toHaveLength(1);
    expect(entries[0].startTime).toBe(65432);
  });

  it("resolves attached resource payload via resolveResource and captures resource_ref", () => {
    const networkEvents: TraceEvent[] = [
      {
        type: "resource-snapshot",
        snapshot: {
          _monotonicTime: 10000,
          request: { method: "GET", url: "https://example.com/api/data" },
          response: {
            status: 200,
            content: {
              mimeType: "application/json",
              _file: "resources/abcd1234ef5678.json",
            },
          },
          time: 80,
        },
      },
    ];

    const mockResolver = (ref: string) => {
      if (ref === "resources/abcd1234ef5678.json") {
        return JSON.stringify({ key: "resolved_payload_value" });
      }
      return undefined;
    };

    const entries = extractNetwork(networkEvents, undefined, mockResolver);
    expect(entries).toHaveLength(1);
    expect(entries[0].resource_ref).toBe("resources/abcd1234ef5678.json");
    expect(entries[0].body_snippet).toBe(JSON.stringify({ key: "resolved_payload_value" }));
  });
});
