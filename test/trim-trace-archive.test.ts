import AdmZip from "adm-zip";
import { writeFileSync, mkdtempSync, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trimTraceArchive } from "../src/trace-parser.js";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "pw-trace-trim-test-"));
});

afterAll(() => {
  // Cleanup if needed
});

function buildZip(
  traceFiles: Record<string, Buffer>,
  screenshotFiles: Record<string, Buffer>,
  nameSuffix = "trace"
): string {
  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(traceFiles)) {
    zip.addFile(name, buf);
  }
  for (const [name, buf] of Object.entries(screenshotFiles)) {
    zip.addFile(name, buf);
  }
  const dest = join(testDir, `${nameSuffix}-${Date.now()}.zip`);
  writeFileSync(dest, zip.toBuffer());
  return dest;
}

describe("trimTraceArchive", () => {
  it("deletes screenshots outside divergence window and creates trimmed archive", async () => {
    // Action starts at 10000 and fails
    const browserEvents = [
      { type: "context-options", browserName: "chromium" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        startTime: 10000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 10200,
        error: { message: "Failed locator" },
      },
    ];

    // Screenshots:
    // Window: [10000 - 5000, 10000 + 1000] = [5000, 11000]
    // Out (below): 4000
    // In: 6000, 9000, 10500
    // Out (above): 12000
    const screenshots: Record<string, Buffer> = {
      "resources/page@a-4000.jpeg": Buffer.from("image_4000"),
      "resources/page@a-6000.jpeg": Buffer.from("image_6000"),
      "resources/page@a-9000.jpeg": Buffer.from("image_9000"),
      "resources/page@a-10500.jpeg": Buffer.from("image_10500"),
      "resources/page@a-12000.jpeg": Buffer.from("image_12000"),
    };

    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      screenshots,
      "failing-trace"
    );

    const result = await trimTraceArchive(path, true);

    expect(result.original_size_bytes).toBeGreaterThan(0);
    expect(result.trimmed_size_bytes).toBeGreaterThan(0);
    expect(result.trimmed_trace_path).toContain(".trimmed.zip");
    expect(existsSync(result.trimmed_trace_path)).toBe(true);

    // Verify zip contents of trimmed archive
    const trimmedZip = new AdmZip(result.trimmed_trace_path);
    const entryNames = trimmedZip.getEntries().map((e) => e.entryName);

    // The trace file itself should be preserved
    expect(entryNames).toContain("0-trace.trace");

    // Outside window should be deleted
    expect(entryNames).not.toContain("resources/page@a-4000.jpeg");
    expect(entryNames).not.toContain("resources/page@a-12000.jpeg");

    // Inside window should be preserved
    expect(entryNames).toContain("resources/page@a-6000.jpeg");
    expect(entryNames).toContain("resources/page@a-9000.jpeg");
    expect(entryNames).toContain("resources/page@a-10500.jpeg");
  });

  it("handles case when divergenceOnly is false (does not delete screenshots)", async () => {
    const browserEvents = [
      { type: "context-options" },
      {
        type: "before",
        callId: "call@1",
        class: "Frame",
        method: "click",
        startTime: 10000,
      },
      {
        type: "after",
        callId: "call@1",
        endTime: 10200,
        error: { message: "Failed" },
      },
    ];

    const screenshots: Record<string, Buffer> = {
      "resources/page@a-4000.jpeg": Buffer.from("image_4000"),
      "resources/page@a-12000.jpeg": Buffer.from("image_12000"),
    };

    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      screenshots,
      "no-trim"
    );

    const result = await trimTraceArchive(path, false);
    const trimmedZip = new AdmZip(result.trimmed_trace_path);
    const entryNames = trimmedZip.getEntries().map((e) => e.entryName);

    expect(entryNames).toContain("resources/page@a-4000.jpeg");
    expect(entryNames).toContain("resources/page@a-12000.jpeg");
  });

  it("falls back to last screenshot timestamp if no failing action is found", async () => {
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
        endTime: 5200,
      },
    ];

    // Screenshots: last one is 15000. Window should be [15000 - 5000, 15000 + 1000] = [10000, 16000]
    // Out: 9000
    // In: 11000, 15000
    const screenshots: Record<string, Buffer> = {
      "resources/page@a-9000.jpeg": Buffer.from("image_9000"),
      "resources/page@a-11000.jpeg": Buffer.from("image_11000"),
      "resources/page@a-15000.jpeg": Buffer.from("image_15000"),
    };

    const path = buildZip(
      {
        "0-trace.trace": Buffer.from(
          browserEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
          "utf8"
        ),
      },
      screenshots,
      "fallback-trace"
    );

    const result = await trimTraceArchive(path, true);
    const trimmedZip = new AdmZip(result.trimmed_trace_path);
    const entryNames = trimmedZip.getEntries().map((e) => e.entryName);

    expect(entryNames).not.toContain("resources/page@a-9000.jpeg");
    expect(entryNames).toContain("resources/page@a-11000.jpeg");
    expect(entryNames).toContain("resources/page@a-15000.jpeg");
  });
});
