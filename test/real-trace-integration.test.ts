import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import {
  parseTraceZip,
  extractScreenshots,
  extractCriticalFrames,
  trimTraceArchive,
  getResolvedSnapshotHtml,
} from "../src/trace-parser.js";
import { mapLocatorToSource, getCausalChain, getDomMutationDelta } from "../src/diagnostics.js";
import { snapshotToAriaYaml } from "../src/aria-translator.js";

const REAL_TRACE_PATH =
  "/tmp/playwright-trace-eval/regression-recording/traces/test_credential_provider_edit_azure_key_vault_username_password.zip";

describe("Real Trace Integration Tests", () => {
  if (!existsSync(REAL_TRACE_PATH)) {
    it.skip("Real trace fixture not available at /tmp/playwright-trace-eval", () => {});
    return;
  }

  it("extracts screencast frames using monotonic timestamps", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const screenshots = extractScreenshots(REAL_TRACE_PATH, trace.events);

    expect(screenshots.length).toBeGreaterThan(400);
    expect(screenshots[0].entryName).toMatch(/^screencast\//);
    // Timestamp should be monotonic (e.g. 335000+), not epoch (1790000000000)
    expect(screenshots[0].timestamp).toBeLessThan(1_000_000);
    expect(screenshots[0].timestamp).toBeGreaterThan(0);
  });

  it("extracts critical frames inside divergence window around failure", async () => {
    const frames = await extractCriticalFrames(REAL_TRACE_PATH, 5000, 1000, 5);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(5);
    expect(frames[0].data).toBeDefined();
    expect(frames[0].mime_type).toBe("image/jpeg");
  });

  it("maps failing locator to python source code in test_credential_providers.py", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const source = mapLocatorToSource(trace);

    expect(source.stack.length).toBeGreaterThan(0);
    expect(source.source_location).toBeDefined();
    expect(source.source_location?.file).toContain("test_credential_providers.py");
    expect(source.source_location?.line).toBe(1210);
    expect(source.source_location?.function).toBe(
      "test_credential_provider_edit_azure_key_vault_username_password"
    );
  });

  it("dereferences incremental snapshot to render full ARIA tree", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const lastSnapshot = trace.snapshots[trace.snapshots.length - 1];
    const resolvedHtml = getResolvedSnapshotHtml(trace, lastSnapshot);
    const yaml = snapshotToAriaYaml(resolvedHtml);

    expect(yaml.split("\n").length).toBeGreaterThan(30);
    expect(yaml).toContain("table");
    expect(yaml).toContain("button");
  });

  it("includes preceding Frame actions in causal chain", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const causal = getCausalChain(trace, 10000);

    expect(causal.chain.length).toBeGreaterThan(1);
    const actions = causal.chain.filter((c) => c.kind === "action");
    expect(actions.length).toBeGreaterThan(0);
  });

  it("trims screencast frames outside failure window", async () => {
    const trimResult = await trimTraceArchive(REAL_TRACE_PATH, true);
    expect(trimResult.trimmed_size_bytes).toBeLessThan(trimResult.original_size_bytes);
    expect(trimResult.compression_ratio_percent).toBeGreaterThan(20);
  });
});
