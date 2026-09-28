import AdmZip from "adm-zip";
import { statSync, writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createInterface } from "readline";
import { Readable } from "stream";
import {
  ParsedTrace,
  StrictTraceMetadata,
  TraceAction,
  TraceMetadata,
  TraceSession,
  NetworkEntry,
  ConsoleMessage,
  TraceEvent,
  FrameSnapshot,
  TraceScreenshot,
  CriticalFrameResult,
  TrimTraceResult,
  StackFrame,
} from "./types.js";

// If trace_path is a URL, download it to a stable temp path keyed by URL hash.
// The file persists for the process lifetime so the LRU cache still works.
const urlTempDir = mkdtempSync(join(tmpdir(), "pw-trace-mcp-"));

export async function resolveTracePath(tracePathOrUrl: string): Promise<string> {
  if (!tracePathOrUrl.startsWith("http://") && !tracePathOrUrl.startsWith("https://")) {
    return tracePathOrUrl;
  }
  const hash = createHash("sha1").update(tracePathOrUrl).digest("hex").slice(0, 16);
  const dest = join(urlTempDir, `${hash}.zip`);
  // Re-use the cached download within the same process run
  try {
    statSync(dest);
    return dest;
  } catch {
    // not yet downloaded
  }
  const res = await fetch(tracePathOrUrl);
  if (!res.ok) {
    throw new Error(`Failed to download trace from URL: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buffer);
  return dest;
}

const CACHE_MAX = 50;
const cache = new Map<string, { mtime: number; parsed: ParsedTrace }>();

function cacheGet(key: string) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, value: { mtime: number; parsed: ParsedTrace }) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value!);
  }
}

function parseTraceStacks(buffer: Buffer): Map<number, StackFrame[]> {
  const result = new Map<number, StackFrame[]>();
  try {
    const data = JSON.parse(buffer.toString("utf8")) as {
      files?: string[];
      stacks?: Array<[number, Array<[number, number, number, string]>]>;
    };
    const files = data.files ?? [];
    for (const [callIdNum, frames] of data.stacks ?? []) {
      const callFrames: StackFrame[] = frames.map(([fileIdx, line, column, funcName]) => ({
        file: files[fileIdx] ?? `file#${fileIdx}`,
        line: Number(line ?? 0),
        column: Number(column ?? 0),
        function: funcName ? String(funcName) : undefined,
      }));
      result.set(Number(callIdNum), callFrames);
    }
  } catch {
    // skip malformed stacks
  }
  return result;
}

export async function parseTraceZip(zipPath: string): Promise<ParsedTrace> {
  const mtime = statSync(zipPath).mtimeMs;
  const cached = cacheGet(zipPath);
  if (cached && cached.mtime === mtime) return cached.parsed;

  const zip = new AdmZip(zipPath);
  const traceEvents: TraceEvent[] = [];
  const networkEvents: TraceEvent[] = [];
  let stacks: Map<number, StackFrame[]> | undefined;

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith(".trace")) {
      await parseJsonlBuffer(entry.getData(), traceEvents);
    } else if (entry.entryName.endsWith(".network")) {
      await parseJsonlBuffer(entry.getData(), networkEvents);
    } else if (entry.entryName.endsWith(".stacks") || entry.entryName === "trace.stacks") {
      stacks = parseTraceStacks(entry.getData());
    }
  }

  const resolveResource = (shaOrFile: string): string | undefined => {
    if (!shaOrFile) return undefined;
    let entry: AdmZip.IZipEntry | null | undefined = zip.getEntry(shaOrFile);
    if (!entry) {
      const stripped = shaOrFile.replace(/^resources\//, "");
      entry = zip.getEntry(`resources/${stripped}`);
      if (!entry) {
        const allEntries = zip.getEntries();
        entry = allEntries.find((e) => {
          const name = e.entryName;
          return (
            name === shaOrFile ||
            name === `resources/${shaOrFile}` ||
            name === `resources/${stripped}` ||
            name.startsWith(`resources/${stripped}.`) ||
            name.includes(stripped)
          );
        });
      }
    }
    if (entry) {
      try {
        return entry.getData().toString("utf8");
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const parsed: ParsedTrace = {
    metadata: extractMetadata(traceEvents, stacks, zipPath),
    events: traceEvents,
    actions: extractActions(traceEvents),
    network: extractNetwork(networkEvents, traceEvents, resolveResource),
    console: extractConsole(traceEvents),
    snapshots: extractSnapshots(traceEvents),
    stacks,
    resolveResource,
  };

  cacheSet(zipPath, { mtime, parsed });
  return parsed;
}

function parseJsonlSync(buffer: Buffer): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of buffer.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

export function extractTraceMetadataStrict(zipPath: string): StrictTraceMetadata {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const filename = zipPath.split("/").pop() ?? zipPath;

  const fileExtension = filename.endsWith(".pwtrace.zip") ? ".pwtrace.zip" : ".zip";

  const traceEntries = entries
    .filter((e) => e.entryName.endsWith(".trace"))
    .sort((a, b) => {
      // trace.trace = attempt 0, trace-1.trace = attempt 1, etc.
      const numA = Number(/(\d+)\.trace$/.exec(a.entryName)?.[1] ?? 0);
      const numB = Number(/(\d+)\.trace$/.exec(b.entryName)?.[1] ?? 0);
      return numA - numB;
    });

  if (traceEntries.length === 0) {
    throw new Error("No .trace files found — archive is not a valid Playwright trace");
  }

  let formatVersion = "unknown";
  const sessions: TraceSession[] = traceEntries.map((entry, idx) => {
    const events = parseJsonlSync(entry.getData());

    if (idx === 0) {
      const versionEvent = events.find(
        (e) => e.type === "version" || typeof (e as Record<string, unknown>).version === "number"
      );
      if (versionEvent) {
        const v = (versionEvent as Record<string, unknown>).version;
        formatVersion = v !== undefined ? String(v) : "unknown";
      }
    }

    const actions = extractActions(events);
    const hasError = actions.some((a) => a.error);
    const startTimes = actions.map((a) => a.startTime).filter((t) => t > 0);
    const endTimes = actions.map((a) => a.endTime).filter((t) => t > 0);
    const duration =
      startTimes.length && endTimes.length ? Math.max(...endTimes) - Math.min(...startTimes) : 0;

    return {
      session_id: entry.entryName,
      retry_index: idx,
      status: hasError ? "failed" : "passed",
      duration_ms: Math.round(duration),
      action_count: actions.length,
    };
  });

  const retryAttemptIndex = sessions.reduce((acc, s, i) => (s.status === "failed" ? i : acc), -1);

  const networkEntries = entries.filter((e) => e.entryName.endsWith(".network"));
  let harResolutionStatus: "embed" | "attach" | "omit" = "omit";
  let embeddedPayloadsFlag = false;

  if (networkEntries.length > 0) {
    const networkEvents = parseJsonlSync(networkEntries[0].getData());
    for (const snap of networkEvents.filter((e) => e.type === "resource-snapshot").slice(0, 20)) {
      const snapshot = snap.snapshot as Record<string, unknown> | undefined;
      const resp = snapshot?.response as Record<string, unknown> | undefined;
      const content = resp?.content as Record<string, unknown> | undefined;
      if (content?._base64 || content?.text) {
        harResolutionStatus = "embed";
        embeddedPayloadsFlag = true;
        break;
      }
    }

    if (harResolutionStatus !== "embed") {
      const hasAttachedResources = entries.some(
        (e) =>
          e.entryName.startsWith("resources/") &&
          !SCREENSHOT_RE.test(e.entryName) &&
          !e.entryName.endsWith(".jpeg") &&
          !e.entryName.endsWith(".png")
      );
      if (hasAttachedResources) harResolutionStatus = "attach";
    }
  }

  return {
    trace_format_version: formatVersion,
    file_extension: fileExtension,
    session_count: sessions.length,
    retry_attempt_index: retryAttemptIndex,
    har_resolution_status: harResolutionStatus,
    embedded_payloads_flag: embeddedPayloadsFlag,
    test_sessions_array: sessions,
  };
}

async function parseJsonlBuffer(buffer: Buffer, target: TraceEvent[]): Promise<void> {
  const rl = createInterface({ input: Readable.from(buffer), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      target.push(JSON.parse(trimmed) as TraceEvent);
    } catch {
      // skip malformed lines
    }
  }
}

export function extractMetadata(
  events: TraceEvent[],
  stacks?: Map<number, StackFrame[]>,
  zipPath?: string
): TraceMetadata {
  const ctx = events.find((e) => e.type === "context-options");
  const options = ctx?.options as Record<string, unknown> | undefined;

  let testTitle: string | undefined = ctx?.title ? String(ctx.title) : undefined;

  // Fallback 1: Resolve from trace.stacks (e.g. pytest-playwright)
  if (!testTitle && stacks) {
    // Pass 1: Look across all calls for a function explicitly starting with test_
    for (const frames of stacks.values()) {
      const testFrame = frames.find(
        (f) => f.function && /^test_/i.test(f.function) && !f.file?.includes("site-packages")
      );
      if (testFrame?.function) {
        testTitle = testFrame.function;
        break;
      }
    }

    // Pass 2: If no function starts with test_, check for non-fixture functions in test files
    if (!testTitle) {
      for (const frames of stacks.values()) {
        const testFrame = frames.find(
          (f) =>
            f.file &&
            /(?:test_[^/]+|[^/]+_test|\.test|\.spec)\.[a-zA-Z0-9]+$/i.test(f.file) &&
            !f.file?.includes("site-packages") &&
            f.function &&
            !f.function.startsWith("<") &&
            !f.function.endsWith("Page") &&
            !f.function.endsWith("Fixture")
        );
        if (testFrame?.function) {
          testTitle = testFrame.function;
          break;
        }
      }
    }
  }

  // Fallback 2: Resolve from zip base filename
  if (!testTitle && zipPath) {
    const base = zipPath.split("/").pop() ?? zipPath;
    const cleaned = base
      .replace(/\.pwtrace\.zip$/i, "")
      .replace(/\.trimmed\.zip$/i, "")
      .replace(/\.zip$/i, "")
      .replace(/-retry\d+$/i, "")
      .replace(/\.trace$/i, "");
    if (cleaned && cleaned !== "trace") {
      testTitle = cleaned;
    }
  }

  return {
    title: testTitle,
    testTitle,
    browser: ctx?.browserName ? String(ctx.browserName) : undefined,
    platform: ctx?.platform ? String(ctx.platform) : undefined,
    viewport: options?.viewport as { width: number; height: number } | undefined,
    wallTime: ctx?.wallTime ? Number(ctx.wallTime) : undefined,
  };
}

const ANSI_RE = /\x1b\[[0-9;]*[mGKHF]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function normalizeActionType(before: TraceEvent): string {
  if (before.apiName) return String(before.apiName);

  // If apiName is missing, try to use title first (usually has the most descriptive name)
  const { class: className, method, title } = before as Record<string, unknown>;

  if (title) {
    return String(title);
  }

  if (className && method) {
    return `${className}.${method}`;
  }

  // Fallback to callId but keep it recognizable
  return String(before.callId ? `pw:api@${before.callId}` : "unknown");
}

function extractActions(events: TraceEvent[]): TraceAction[] {
  const afterMap = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === "after" && e.callId) {
      afterMap.set(String(e.callId), e);
    }
  }

  return events
    .filter((e) => e.type === "before")
    .map((before) => {
      const after = afterMap.get(String(before.callId));
      const params = (before.params ?? {}) as Record<string, unknown>;
      const error = after?.error as Record<string, unknown> | undefined;
      return {
        type: normalizeActionType(before),
        startTime: Number(before.startTime ?? 0),
        endTime: Number(after?.endTime ?? 0),
        locator: params.selector
          ? String(params.selector)
          : params.locator
            ? String(params.locator)
            : undefined,
        error: error?.message ? stripAnsi(String(error.message)) : undefined,
        metadata: { before, after },
      };
    });
}

export function extractNetwork(
  networkEvents: TraceEvent[],
  traceEvents?: TraceEvent[],
  resolveResource?: (shaOrFile: string) => string | undefined
): NetworkEntry[] {
  let monotonicBase: number | undefined;
  let wallBase: number | undefined;

  if (traceEvents) {
    const ctx = traceEvents.find((e) => e.type === "context-options");
    if (typeof ctx?.monotonicTime === "number") {
      monotonicBase = Number(ctx.monotonicTime);
    }
    if (typeof ctx?.wallTime === "number") {
      wallBase = Number(ctx.wallTime);
    }
  }

  return networkEvents
    .filter((e) => e.type === "resource-snapshot")
    .map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      const req = snap.request as Record<string, unknown>;
      const resp = snap.response as Record<string, unknown>;
      const content = resp?.content as Record<string, unknown> | undefined;

      let resource_ref: string | undefined;
      if (content?._file) {
        resource_ref = String(content._file);
      } else if (content?._sha1) {
        resource_ref = String(content._sha1);
      }

      let body_snippet: string | undefined;
      if (content?._base64) {
        body_snippet = Buffer.from(String(content._base64), "base64")
          .toString("utf8")
          .slice(0, 500);
      } else if (content?.text) {
        body_snippet = String(content.text).slice(0, 500);
      } else if (resource_ref && resolveResource) {
        const resolved = resolveResource(resource_ref);
        if (resolved) {
          body_snippet = resolved.slice(0, 500);
        }
      }

      let startTime = 0;
      if (typeof snap._monotonicTime === "number" && snap._monotonicTime > 0) {
        startTime = Number(snap._monotonicTime);
      } else if (snap.startedDateTime) {
        const startedDateTimeMs = new Date(String(snap.startedDateTime)).getTime();
        if (!isNaN(startedDateTimeMs)) {
          if (monotonicBase !== undefined && wallBase !== undefined) {
            startTime = monotonicBase + (startedDateTimeMs - wallBase);
          } else {
            startTime = startedDateTimeMs;
          }
        }
      } else {
        startTime = Number(snap.time ?? 0);
      }

      return {
        url: String(req?.url ?? ""),
        method: String(req?.method ?? "GET"),
        status: Number(resp?.status ?? 0),
        startTime,
        duration: Number(snap.time ?? 0),
        mimeType: String(content?.mimeType ?? "other"),
        ...(resource_ref !== undefined ? { resource_ref } : {}),
        ...(body_snippet !== undefined ? { body_snippet } : {}),
      };
    });
}

function extractSnapshots(events: TraceEvent[]): FrameSnapshot[] {
  return events
    .filter((e) => e.type === "frame-snapshot")
    .map((e) => {
      const snap = e.snapshot as Record<string, unknown>;
      return {
        callId: String(snap.callId ?? ""),
        snapshotName: String(snap.snapshotName ?? ""),
        phase: snap.phase ? String(snap.phase) : undefined,
        frameUrl: String(snap.frameUrl ?? ""),
        html: snap.html,
        timestamp: Number(snap.timestamp ?? 0),
      };
    });
}

function isNodeNameAttrs(n: unknown): n is [string, Record<string, unknown>, ...unknown[]] {
  return Array.isArray(n) && n.length > 0 && typeof n[0] === "string";
}

function isSubtreeRef(n: unknown): n is [[number, number]] {
  return Array.isArray(n) && n.length > 0 && Array.isArray(n[0]) && typeof n[0][0] === "number";
}

const snapshotNodesCache = new WeakMap<FrameSnapshot, unknown[]>();

function getSnapshotNodes(snapshot: FrameSnapshot): unknown[] {
  const cached = snapshotNodesCache.get(snapshot);
  if (cached) return cached;
  const nodes: unknown[] = [];
  const visit = (n: unknown) => {
    if (typeof n === "string") {
      nodes.push(n);
    } else if (isNodeNameAttrs(n)) {
      const hasAttrs = n[1] !== null && typeof n[1] === "object" && !Array.isArray(n[1]);
      const children = n.slice(hasAttrs ? 2 : 1);
      for (const c of children) visit(c);
      nodes.push(n);
    }
  };
  visit(snapshot.html);
  snapshotNodesCache.set(snapshot, nodes);
  return nodes;
}

export function dereferenceSnapshot(snapshots: FrameSnapshot[], index: number): unknown {
  const target = snapshots[index];
  if (!target) return undefined;

  function resolve(n: unknown, snapIdx: number, depth = 0): unknown {
    if (depth > 100) return null;
    if (typeof n === "string") return n;
    if (isSubtreeRef(n)) {
      const delta = n[0][0];
      const refIdx = snapIdx - delta;
      if (refIdx >= 0 && refIdx <= snapIdx) {
        const refSnapshot = snapshots[refIdx];
        if (refSnapshot) {
          const nodes = getSnapshotNodes(refSnapshot);
          const nodeIdx = n[0][1];
          if (nodeIdx >= 0 && nodeIdx < nodes.length) {
            return resolve(nodes[nodeIdx], refIdx, depth + 1);
          }
        }
      }
      return null;
    }
    if (isNodeNameAttrs(n)) {
      const tag = n[0];
      const hasAttrs = n[1] !== null && typeof n[1] === "object" && !Array.isArray(n[1]);
      const attrs = hasAttrs ? (n[1] as Record<string, unknown>) : {};
      const childStart = hasAttrs ? 2 : 1;
      const children = n.slice(childStart);
      const resolvedChildren: unknown[] = [];
      for (const c of children) {
        const r = resolve(c, snapIdx, depth + 1);
        if (r !== null && r !== undefined) {
          resolvedChildren.push(r);
        }
      }
      return [tag, attrs, ...resolvedChildren];
    }
    return null;
  }

  return resolve(target.html, index);
}

export function getResolvedSnapshotHtml(trace: ParsedTrace, snapshot: FrameSnapshot): unknown {
  const index = trace.snapshots.indexOf(snapshot);
  if (index >= 0) {
    return dereferenceSnapshot(trace.snapshots, index) ?? snapshot.html;
  }
  return snapshot.html;
}

// Filename pattern: resources/page@<id>-<timestamp>.jpeg or screencast/page@<id>-<timestamp>.jpeg
const SCREENSHOT_RE = /^(?:resources|screencast)\/page@[^-]+-(\d+)\.(?:jpeg|jpg|png)$/;

export function extractScreenshots(zipPath: string, traceEvents?: TraceEvent[]): TraceScreenshot[] {
  const zip = new AdmZip(zipPath);
  const results: TraceScreenshot[] = [];

  let events = traceEvents;
  if (!events) {
    const traceEntries = zip.getEntries().filter((e) => e.entryName.endsWith(".trace"));
    if (traceEntries.length > 0) {
      events = [];
      for (const entry of traceEntries) {
        events.push(...parseJsonlSync(entry.getData()));
      }
    }
  }

  const screencastEvents = (events ?? []).filter(
    (e) => e.type === "screencast-frame" && e.file && typeof e.timestamp === "number"
  );

  if (screencastEvents.length > 0) {
    for (const e of screencastEvents) {
      const filePath = String(e.file).replace(/^\//, "");
      const entry = zip.getEntry(filePath);
      if (!entry) continue;
      results.push({
        entryName: filePath,
        timestamp: Number(e.timestamp),
        data: entry.getData(),
      });
    }
  } else {
    for (const entry of zip.getEntries()) {
      const match = SCREENSHOT_RE.exec(entry.entryName);
      if (!match) continue;
      const timestamp = Number(match[1]);
      results.push({ entryName: entry.entryName, timestamp, data: entry.getData() });
    }
  }

  results.sort((a, b) => a.timestamp - b.timestamp);
  return results;
}

function extractConsole(events: TraceEvent[]): ConsoleMessage[] {
  const objectMap = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === "object" && e.guid) {
      objectMap.set(String(e.guid), e);
    }
  }

  return events
    .filter((e) => e.type === "event" && e.method === "console")
    .map((e) => {
      const params = e.params as Record<string, unknown>;
      const msgRef = params.message as Record<string, unknown> | undefined;
      const msgObj = objectMap.get(String(msgRef?.guid ?? ""));
      const init = msgObj?.initializer as Record<string, unknown> | undefined;
      return {
        type: (init?.type as ConsoleMessage["type"]) ?? "log",
        text: init?.text ? String(init.text) : "",
        time: Number(e.time ?? 0),
      };
    });
}

export async function extractCriticalFrames(
  zipPath: string,
  lookbackMs = 5000,
  lookforwardMs = 1000,
  limit = 10
): Promise<CriticalFrameResult[]> {
  const trace = await parseTraceZip(zipPath);
  const screenshots = extractScreenshots(zipPath, trace.events);

  if (screenshots.length === 0) {
    return [];
  }

  // 1. Find t_fail (startTime of failing action)
  const failedAction = trace.actions.find((a) => a.error);
  let t_fail = 0;

  if (failedAction) {
    t_fail = failedAction.startTime;
  } else {
    t_fail = screenshots[screenshots.length - 1].timestamp;
  }

  // 2. Define temporal window
  const windowStart = t_fail - lookbackMs;
  const windowEnd = t_fail + lookforwardMs;

  // 3. Filter screenshots by window
  let candidates = screenshots.filter(
    (s) => s.timestamp >= windowStart && s.timestamp <= windowEnd
  );

  if (candidates.length === 0) {
    const sortedByDiff = [...screenshots].sort(
      (a, b) => Math.abs(a.timestamp - t_fail) - Math.abs(b.timestamp - t_fail)
    );
    candidates = [sortedByDiff[0]];
  }

  // 4. Sample down to limit, keeping the one closest to t_fail
  let selected = candidates;
  if (candidates.length > limit) {
    let closestIdx = 0;
    let minDiff = Infinity;
    candidates.forEach((s, idx) => {
      const diff = Math.abs(s.timestamp - t_fail);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });

    if (limit === 1) {
      selected = [candidates[closestIdx]];
    } else {
      const indices = new Set<number>();
      indices.add(closestIdx);
      indices.add(0);
      indices.add(candidates.length - 1);

      const step = (candidates.length - 1) / (limit - 1);
      for (let i = 1; i < limit - 1; i++) {
        indices.add(Math.round(i * step));
      }

      let nextIdx = 0;
      while (indices.size < limit && nextIdx < candidates.length) {
        indices.add(nextIdx++);
      }

      selected = Array.from(indices)
        .sort((a, b) => a - b)
        .slice(0, limit)
        .map((idx) => candidates[idx]);
    }
  }

  // 5. Correlate timestamps with test runner steps
  const results: CriticalFrameResult[] = [];
  for (const s of selected) {
    const activeAction = trace.actions.find(
      (a) => s.timestamp >= a.startTime && s.timestamp <= a.endTime
    );

    let stepTitle: string | undefined;
    if (activeAction) {
      const stepId = (activeAction.metadata?.before as Record<string, unknown> | undefined)?.stepId;
      if (stepId) {
        const runnerEvent = trace.events.find(
          (e) =>
            (e.class === "Test" || e.origin === "testRunner") &&
            e.type === "before" &&
            (e.stepId === stepId || e.callId === stepId)
        );
        if (runnerEvent?.title) {
          stepTitle = String(runnerEvent.title);
        }
      }
      if (!stepTitle) {
        stepTitle = activeAction.type;
      }
    }

    results.push({
      timestamp: s.timestamp,
      data: s.data.toString("base64"),
      mime_type: "image/jpeg",
      step_title: stepTitle,
    });
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function trimTraceArchive(
  zipPath: string,
  divergenceOnly = true
): Promise<TrimTraceResult> {
  const originalStats = statSync(zipPath);
  const originalSize = originalStats.size;

  const trace = await parseTraceZip(zipPath);
  const zip = new AdmZip(zipPath);

  // 1. Find failing action timestamp
  const failedAction = trace.actions.find((a) => a.error);
  let t_fail = 0;

  const screenshots = extractScreenshots(zipPath, trace.events);

  if (failedAction) {
    t_fail = failedAction.startTime;
  } else if (screenshots.length > 0) {
    t_fail = screenshots[screenshots.length - 1].timestamp;
  } else {
    const dest = zipPath.replace(/\.zip$/, ".trimmed.zip");
    zip.writeZip(dest);
    const newStats = statSync(dest);
    return {
      original_size_bytes: originalSize,
      trimmed_size_bytes: newStats.size,
      compression_ratio_percent: 0,
      trimmed_trace_path: dest,
    };
  }

  // Window: t_fail - 5000ms to t_fail + 1000ms
  const windowStart = t_fail - 5000;
  const windowEnd = t_fail + 1000;

  if (divergenceOnly) {
    for (const s of screenshots) {
      if (s.timestamp < windowStart || s.timestamp > windowEnd) {
        zip.deleteFile(s.entryName);
      }
    }
  }

  let dest = "";
  if (zipPath.endsWith(".pwtrace.zip")) {
    dest = zipPath.replace(/\.pwtrace\.zip$/, ".trimmed.pwtrace.zip");
  } else {
    dest = zipPath.replace(/\.zip$/, ".trimmed.zip");
  }

  zip.writeZip(dest);

  const trimmedStats = statSync(dest);
  const trimmedSize = trimmedStats.size;

  const ratio =
    originalSize > 0 ? Math.round(((originalSize - trimmedSize) / originalSize) * 100) : 0;

  return {
    original_size_bytes: originalSize,
    trimmed_size_bytes: trimmedSize,
    compression_ratio_percent: ratio,
    trimmed_trace_path: dest,
  };
}
