import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import {
  parseTraceZip,
  extractScreenshots,
  extractCriticalFrames,
  trimTraceArchive,
  getResolvedSnapshotHtml,
} from "../src/trace-parser.js";
import {
  mapLocatorToSource,
  getCausalChain,
  getDomMutationDelta,
  getElementStateAtFailure,
  queryNetworkRequests,
  searchDomSnapshots,
  triageFailureBundle,
} from "../src/diagnostics.js";
import { generateErrorSignature } from "../src/cross-trace.js";
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

  it("extracts canonical test title and uses it in error signature", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    expect(trace.metadata.testTitle).toBe(
      "test_credential_provider_edit_azure_key_vault_username_password"
    );
    expect(trace.metadata.title).toBe(
      "test_credential_provider_edit_azure_key_vault_username_password"
    );

    const sig = generateErrorSignature(trace);
    expect(sig.test_title).toBe("test_credential_provider_edit_azure_key_vault_username_password");
    expect(sig.components.test_title).toBe(
      "test_credential_provider_edit_azure_key_vault_username_password"
    );
  });

  it("inspects failing element state in DOM snapshot at failure", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const state = getElementStateAtFailure(trace);

    expect(state.failed_action).toBe("Frame.click");
    expect(state.locator).toBe('internal:role=button[name="Edit"i]');
    expect(state.error).toContain("Timeout 30000ms exceeded");
    expect(state.element_found).toBe(false);
    expect(state.message).toContain("was not found in the DOM snapshot at failure");
  });

  it("queries real trace network requests and decodes attached JSON payload", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const result = queryNetworkRequests(trace, {
      url_pattern: "/api/v2/credential-providers",
      include_body: true,
    });

    expect(result.total_matches).toBeGreaterThan(0);
    const match = result.requests.find((r) => r.method === "PUT" || r.method === "GET");
    expect(match).toBeDefined();
    expect(match?.response_body).toBeDefined();
    // JSON decoded from attached resource
    expect(match?.response_body).toContain("secretName1");
  });

  it("searches real trace DOM snapshots by text and CSS selector without full ARIA dump", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);

    // Search by selector
    const selectorResult = searchDomSnapshots(trace, {
      selector: "table",
    });
    expect(selectorResult.found).toBe(true);
    expect(selectorResult.matches.length).toBeGreaterThan(0);
    expect(selectorResult.matches[0].tag.toLowerCase()).toBe("table");

    // Search by text
    const textResult = searchDomSnapshots(trace, {
      text: "Credential Providers",
    });
    expect(textResult.found).toBe(true);
    expect(textResult.matches.length).toBeGreaterThan(0);
    expect(textResult.matches[0].parent_context).toBeDefined();
  });

  it("assembles complete single-turn failure triage bundle from real trace", async () => {
    const trace = await parseTraceZip(REAL_TRACE_PATH);
    const bundle = triageFailureBundle(trace, REAL_TRACE_PATH);

    expect(bundle.has_failure).toBe(true);
    expect(bundle.test_title).toBe(
      "test_credential_provider_edit_azure_key_vault_username_password"
    );
    expect(bundle.error_message).toContain("Timeout 30000ms exceeded");
    expect(bundle.failed_action?.type).toBe("Frame.click");
    expect(bundle.failed_action?.locator).toBe('internal:role=button[name="Edit"i]');

    // Source location mapped from execution stack
    expect(bundle.source_location?.file).toContain("test_credential_providers.py");
    expect(bundle.source_location?.line).toBe(1210);

    // Element state at failure
    expect(bundle.element_state?.element_found).toBe(false);

    // Failure screenshot
    expect(bundle.screenshot).toBeDefined();
    expect(bundle.screenshot?.mime_type).toBe("image/jpeg");
    expect(bundle.screenshot?.data.length).toBeGreaterThan(100);

    // Recent network requests
    expect(bundle.recent_network_requests).toBeDefined();
    expect(bundle.recent_network_requests!.length).toBeGreaterThan(0);
  });
});
