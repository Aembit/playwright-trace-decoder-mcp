import AdmZip from "adm-zip";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseTraceZip } from "../src/trace-parser.js";
import { mapLocatorToSource } from "../src/diagnostics.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "pw-trace-map-source-test-"));
});

afterAll(() => {
  // Temp directory cleanup
});

function buildZip(traceFiles: Record<string, Buffer>): string {
  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(traceFiles)) {
    zip.addFile(name, buf);
  }
  const dest = join(testDir, `trace-${Date.now()}.zip`);
  writeFileSync(dest, zip.toBuffer());
  return dest;
}

describe("mapLocatorToSource", () => {
  it("correlates browser action with test runner stack via stepId", async () => {
    // 1. Browser events (like in 0-trace.trace)
    const browserEvents = [
      { type: "context-options", browserName: "chromium" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        params: { selector: "#submit-button", strict: true },
        stepId: "pw:api@99", // The link
        startTime: 1000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 1200,
        error: { message: "Timeout 5000ms exceeded." },
      },
    ];

    // 2. Test runner events (like in test.trace)
    const runnerEvents = [
      {
        type: "before",
        callId: "pw:api@99", // matches stepId from browserEvent
        stepId: "pw:api@99",
        class: "Test",
        method: "pw:api",
        title: "Clicking submit button",
        startTime: 990,
        stack: [
          {
            file: "/src/tests/login.spec.ts",
            line: 42,
            column: 15,
            function: "TestPage.login",
          },
        ],
      },
    ];

    const traceBuffer = Buffer.from(
      browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
    const testTraceBuffer = Buffer.from(
      runnerEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );

    const path = buildZip({
      "0-trace.trace": traceBuffer,
      "test.trace": testTraceBuffer,
    });

    const parsed = await parseTraceZip(path);
    const result = mapLocatorToSource(parsed);

    expect(result.action_type).toBe("Frame.click");
    expect(result.locator).toBe("#submit-button");
    expect(result.error).toContain("Timeout 5000ms exceeded");
    expect(result.step_title).toBe("Clicking submit button");
    expect(result.stack).toHaveLength(1);
    expect(result.stack[0].file).toBe("/src/tests/login.spec.ts");
    expect(result.stack[0].line).toBe(42);
    expect(result.stack[0].column).toBe(15);
    expect(result.stack[0].function).toBe("TestPage.login");
    expect(result.source_location).toEqual(result.stack[0]);
  });

  it("throws when action_index is out of range", async () => {
    const traceBuffer = Buffer.from(JSON.stringify({ type: "context-options" }) + "\n", "utf8");
    const path = buildZip({ "0-trace.trace": traceBuffer });
    const parsed = await parseTraceZip(path);

    expect(() => mapLocatorToSource(parsed, 99)).toThrow("Action at index 99 not found");
  });

  it("throws when no failing action is present and no index is passed", async () => {
    const browserEvents = [
      { type: "context-options" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        startTime: 1000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 1200,
      },
    ];
    const traceBuffer = Buffer.from(
      browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
    const path = buildZip({ "0-trace.trace": traceBuffer });
    const parsed = await parseTraceZip(path);

    expect(() => mapLocatorToSource(parsed)).toThrow("No failing action found in trace");
  });
});
