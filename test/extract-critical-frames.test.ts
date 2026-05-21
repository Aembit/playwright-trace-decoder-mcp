import AdmZip from "adm-zip";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractCriticalFrames } from "../src/trace-parser.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "pw-trace-extract-frames-test-"));
});

afterAll(() => {
  // Temp directory cleanup
});

function buildZip(
  traceFiles: Record<string, Buffer>,
  screenshotFiles: Record<string, Buffer>
): string {
  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(traceFiles)) {
    zip.addFile(name, buf);
  }
  for (const [name, buf] of Object.entries(screenshotFiles)) {
    zip.addFile(name, buf);
  }
  const dest = join(testDir, `trace-${Date.now()}.zip`);
  writeFileSync(dest, zip.toBuffer());
  return dest;
}

describe("extractCriticalFrames", () => {
  it("extracts frames inside the divergence window and resolves step titles", async () => {
    // 1. Browser actions (t_fail will be 5000)
    const browserEvents = [
      { type: "context-options", browserName: "chromium" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        params: { selector: "#broken" },
        stepId: "pw:api@1",
        startTime: 5000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 5200,
        error: { message: "Failed locator" },
      },
    ];

    // 2. Test runner actions
    const runnerEvents = [
      {
        type: "before",
        callId: "pw:api@1",
        stepId: "pw:api@1",
        class: "Test",
        method: "pw:api",
        title: "Clicking #broken element",
        startTime: 4990,
      },
    ];

    // 3. Screenshots (timestamps: 1000, 2000, 3500, 5000, 6000, 8000)
    const screenshots: Record<string, Buffer> = {
      "resources/page@a-1000.jpeg": Buffer.from("image_1000"),
      "resources/page@a-2000.jpeg": Buffer.from("image_2000"),
      "resources/page@a-3500.jpeg": Buffer.from("image_3500"),
      "resources/page@a-5000.jpeg": Buffer.from("image_5000"),
      "resources/page@a-6000.jpeg": Buffer.from("image_6000"),
      "resources/page@a-8000.jpeg": Buffer.from("image_8000"),
    };

    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
        "test.trace": Buffer.from(
          runnerEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      screenshots
    );

    // Call extractCriticalFrames: lookback 3000ms, lookforward 1000ms
    // Window is [5000 - 3000, 5000 + 1000] = [2000, 6000]
    // Expected timestamps: 2000, 3500, 5000, 6000 (1000 and 8000 filtered out)
    const result = await extractCriticalFrames(path, 3000, 1000, 10);

    expect(result).toHaveLength(4);
    expect(result[0].timestamp).toBe(2000);
    expect(result[0].data).toBe(Buffer.from("image_2000").toString("base64"));

    // Timestamp 5000 is during the failed action, should have the step title
    const failedFrame = result.find((f) => f.timestamp === 5000);
    expect(failedFrame).toBeDefined();
    expect(failedFrame!.step_title).toBe("Clicking #broken element");
  });

  it("respects the limit argument and samples down while retaining closest to failure", async () => {
    const browserEvents = [
      { type: "context-options" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        startTime: 5000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 5100,
        error: { message: "Error" },
      },
    ];

    const screenshots: Record<string, Buffer> = {
      "resources/page@a-1000.jpeg": Buffer.from("image_1000"),
      "resources/page@a-2000.jpeg": Buffer.from("image_2000"),
      "resources/page@a-3000.jpeg": Buffer.from("image_3000"),
      "resources/page@a-4000.jpeg": Buffer.from("image_4000"),
      "resources/page@a-5000.jpeg": Buffer.from("image_5000"),
    };

    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      screenshots
    );

    // Limit to 2 frames
    const result = await extractCriticalFrames(path, 5000, 1000, 2);

    expect(result).toHaveLength(2);
    // The closest to t_fail (5000) must be present
    const timestamps = result.map((r) => r.timestamp);
    expect(timestamps).toContain(5000);
  });

  it("returns empty array if no screenshots are present in trace", async () => {
    const browserEvents = [{ type: "context-options" }];
    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      {}
    );

    const result = await extractCriticalFrames(path);
    expect(result).toEqual([]);
  });
});
