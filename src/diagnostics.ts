import { ParsedTrace, TraceAction, LocatorSourceResult, FrameSnapshot } from "./types.js";
import {
  snapshotToAriaYaml,
  SnapNode,
  resolveRole,
  resolveName,
  extractText,
} from "./aria-translator.js";
import { getResolvedSnapshotHtml, extractScreenshots } from "./trace-parser.js";

// ---------------------------------------------------------------------------
// analyze_race_conditions
// ---------------------------------------------------------------------------

export interface RaceConditionResult {
  action_index: number;
  action_type: string;
  action_start: number;
  pending_requests: Array<{
    url: string;
    method: string;
    request_start: number;
    ms_before_action: number;
  }>;
}

const INTERACTION_ACTIONS = new Set([
  "page.click",
  "locator.click",
  "page.dblclick",
  "locator.dblclick",
  "page.fill",
  "locator.fill",
  "page.type",
  "locator.type",
  "page.press",
  "locator.press",
  "page.selectOption",
  "locator.selectOption",
  "page.check",
  "locator.check",
  "page.uncheck",
  "locator.uncheck",
  "page.hover",
  "locator.hover",
  "page.tap",
  "locator.tap",
  "page.goto",
  "page.reload",
  "page.goBack",
  "page.goForward",
]);

export function analyzeRaceConditions(trace: ParsedTrace): RaceConditionResult[] {
  const results: RaceConditionResult[] = [];

  trace.actions.forEach((action, index) => {
    const type = action.type.toLowerCase();
    const isInteraction =
      INTERACTION_ACTIONS.has(action.type) ||
      [...INTERACTION_ACTIONS].some((t) => type.includes(t.split(".")[1])) ||
      type.startsWith("expect") ||
      type.startsWith("locator.expect");
    if (!isInteraction) return;

    const pending = trace.network.filter((n) => {
      const networkEnd = n.startTime + n.duration;
      return n.startTime < action.startTime && networkEnd > action.startTime;
    });

    if (pending.length === 0) return;

    results.push({
      action_index: index,
      action_type: action.type,
      action_start: action.startTime,
      pending_requests: pending.map((n) => ({
        url: n.url,
        method: n.method,
        request_start: n.startTime,
        ms_before_action: Math.round(action.startTime - n.startTime),
      })),
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// get_dom_mutation_delta
// ---------------------------------------------------------------------------

export interface DomDeltaResult {
  action_index: number;
  action_type: string;
  before_snapshot: string | null;
  after_snapshot: string | null;
  added: string[];
  removed: string[];
  unchanged_count: number;
}

export function getDomMutationDelta(trace: ParsedTrace, actionIndex: number): DomDeltaResult {
  const action = trace.actions[actionIndex];
  const base: DomDeltaResult = {
    action_index: actionIndex,
    action_type: action?.type ?? "unknown",
    before_snapshot: null,
    after_snapshot: null,
    added: [],
    removed: [],
    unchanged_count: 0,
  };

  if (!action) return base;

  const callId = (action.metadata as Record<string, { callId?: string }>)?.before?.callId;
  if (!callId) return base;

  const beforeSnap = trace.snapshots.find(
    (s) => s.callId === callId && (s.phase === "before" || s.snapshotName.startsWith("before@"))
  );
  const afterSnap = trace.snapshots.find(
    (s) => s.callId === callId && (s.phase === "after" || s.snapshotName.startsWith("after@"))
  );

  if (!beforeSnap && !afterSnap) return base;

  const beforeHtml = beforeSnap ? getResolvedSnapshotHtml(trace, beforeSnap) : null;
  const afterHtml = afterSnap ? getResolvedSnapshotHtml(trace, afterSnap) : null;

  const beforeLines = new Set(
    beforeHtml ? snapshotToAriaYaml(beforeHtml).split("\n").filter(Boolean) : []
  );
  const afterLines = new Set(
    afterHtml ? snapshotToAriaYaml(afterHtml).split("\n").filter(Boolean) : []
  );

  const added = [...afterLines].filter((l) => !beforeLines.has(l));
  const removed = [...beforeLines].filter((l) => !afterLines.has(l));
  const unchanged = [...afterLines].filter((l) => beforeLines.has(l)).length;

  return {
    ...base,
    before_snapshot: beforeSnap?.snapshotName || beforeSnap?.phase || null,
    after_snapshot: afterSnap?.snapshotName || afterSnap?.phase || null,
    added,
    removed,
    unchanged_count: unchanged,
  };
}

// ---------------------------------------------------------------------------
// correlate_dom_and_network
// ---------------------------------------------------------------------------

export interface NetworkDomCorrelation {
  action_id: string;
  triggering_request_url: string;
  response_status_code: number;
  response_body_snippet: string;
  time_to_dom_mutation_ms: number;
  resulting_dom_mutations: Array<{ type: "added" | "removed" | "changed"; selector: string }>;
}

const NOISE_PATTERNS = [
  /analytics/i,
  /tracking/i,
  /beacon/i,
  /telemetry/i,
  /metrics/i,
  /ping\b/i,
  /pixel/i,
  /\.gif(\?|$)/i,
];

export function correlateNetworkAndDom(trace: ParsedTrace): NetworkDomCorrelation[] {
  const results: NetworkDomCorrelation[] = [];

  trace.actions.forEach((action, index) => {
    const delta = getDomMutationDelta(trace, index);
    const mutations: Array<{ type: "added" | "removed" | "changed"; selector: string }> = [
      ...delta.added.map((s) => ({ type: "added" as const, selector: s })),
      ...delta.removed.map((s) => ({ type: "removed" as const, selector: s })),
    ];

    if (mutations.length === 0) return;

    // Network requests whose response completed during this action's window (±100ms)
    const windowStart = action.startTime - 100;
    const windowEnd = action.endTime + 100;

    const candidates = trace.network.filter((n) => {
      const responseComplete = n.startTime + n.duration;
      return (
        responseComplete >= windowStart &&
        responseComplete <= windowEnd &&
        !NOISE_PATTERNS.some((p) => p.test(n.url)) &&
        !(n.mimeType.startsWith("image/") && n.status === 204)
      );
    });

    if (candidates.length === 0) return;

    // Pick the request whose response completed closest to the action start
    const trigger = candidates.reduce((best, n) => {
      const dA = Math.abs(n.startTime + n.duration - action.startTime);
      const dB = Math.abs(best.startTime + best.duration - action.startTime);
      return dA < dB ? n : best;
    });

    const responseCompleteTime = trigger.startTime + trigger.duration;

    results.push({
      action_id: `${index}:${action.type}`,
      triggering_request_url: trigger.url,
      response_status_code: trigger.status,
      response_body_snippet: trigger.body_snippet ?? "",
      time_to_dom_mutation_ms: Math.round(action.endTime - responseCompleteTime),
      resulting_dom_mutations: mutations.slice(0, 10),
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// get_causal_chain_for_failure
// ---------------------------------------------------------------------------

export interface CausalChainEvent {
  time: number;
  kind: "action" | "network_error" | "console_error" | "failed_action";
  description: string;
  detail?: string;
}

export interface CausalChainResult {
  failed_action: string | null;
  failure_time: number | null;
  lookback_ms: number;
  chain: CausalChainEvent[];
}

export function getCausalChain(trace: ParsedTrace, lookbackMs = 5000): CausalChainResult {
  const failed = trace.actions.find((a) => a.error);

  if (!failed) {
    return { failed_action: null, failure_time: null, lookback_ms: lookbackMs, chain: [] };
  }

  const failureTime = failed.startTime;
  const windowStart = failureTime - lookbackMs;
  const chain: CausalChainEvent[] = [];

  // Preceding user-facing actions in the window
  trace.actions
    .filter((a) => a !== failed && a.startTime >= windowStart && a.startTime < failureTime)
    .filter((a) => {
      const type = a.type.toLowerCase();
      return (
        INTERACTION_ACTIONS.has(a.type) ||
        [...INTERACTION_ACTIONS].some((t) => type.includes(t.split(".")[1])) ||
        type.startsWith("expect") ||
        type.startsWith("locator.expect")
      );
    })
    .forEach((a) => {
      chain.push({
        time: a.startTime,
        kind: "action",
        description: a.type,
        detail: a.locator ?? undefined,
      });
    });

  // Network errors (4xx/5xx) in the window
  trace.network
    .filter((n) => n.status >= 400 && n.startTime >= windowStart && n.startTime < failureTime)
    .forEach((n) => {
      chain.push({
        time: n.startTime,
        kind: "network_error",
        description: `${n.method} ${n.status}`,
        detail: n.url,
      });
    });

  // Console errors before failure
  trace.console
    .filter((c) => c.type === "error" && c.time >= windowStart && c.time < failureTime)
    .forEach((c) => {
      chain.push({
        time: c.time,
        kind: "console_error",
        description: "console.error",
        detail: c.text,
      });
    });

  // The failure itself
  chain.push({
    time: failureTime,
    kind: "failed_action",
    description: failed.type,
    detail: failed.error ?? undefined,
  });

  chain.sort((a, b) => a.time - b.time);

  return {
    failed_action: failed.type,
    failure_time: failureTime,
    lookback_ms: lookbackMs,
    chain,
  };
}

// ---------------------------------------------------------------------------
// detect_performance_anomalies
// ---------------------------------------------------------------------------

export interface PerformanceAnomaly {
  kind: "slow_action" | "frame_drop";
  blocked_action_id: string;
  task_duration_ms: number;
  threshold_ms: number;
  concurrent_network_load: number;
  frame_drop_count: number;
  worst_frame_gap_ms: number;
  suspected_cause:
    | "main_thread_blocked"
    | "network_saturation"
    | "timeout_or_navigation"
    | "unknown";
}

export interface PerformanceReport {
  anomalies: PerformanceAnomaly[];
  suspected_memory_leak_flag: boolean;
  p50_action_duration_ms: number;
  p95_action_duration_ms: number;
  total_frame_drop_count: number;
}

function getActionType(action: TraceAction): string {
  const before = (action.metadata as Record<string, Record<string, unknown>> | undefined)?.before;
  if (before?.apiName) return String(before.apiName);
  if (before?.class && before?.method) return `${String(before.class)}.${String(before.method)}`;
  return action.type;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

export function detectPerformanceAnomalies(
  trace: ParsedTrace,
  slowActionThresholdMs = 500,
  frameDropThresholdMs = 50
): PerformanceReport {
  // Frame gaps from screencast-frame events
  const frameTimestamps = trace.events
    .filter((e) => e.type === "screencast-frame")
    .map((e) => Number(e.timestamp ?? 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);

  const frameGaps: Array<{ gapMs: number; windowStart: number; windowEnd: number }> = [];
  for (let i = 1; i < frameTimestamps.length; i++) {
    const gap = frameTimestamps[i] - frameTimestamps[i - 1];
    if (gap > frameDropThresholdMs) {
      frameGaps.push({
        gapMs: gap,
        windowStart: frameTimestamps[i - 1],
        windowEnd: frameTimestamps[i],
      });
    }
  }

  const totalFrameDropCount = frameGaps.length;

  // Action durations for stats
  const actionDurations = trace.actions.map((a) =>
    a.endTime > a.startTime ? a.endTime - a.startTime : 0
  );
  const nonTrivial = actionDurations.filter((d) => d > 10).sort((a, b) => a - b);
  const p50 = percentile(nonTrivial, 50);
  const p95 = percentile(nonTrivial, 95);

  function concurrentNetworkLoad(windowStart: number, windowEnd: number): number {
    return trace.network.filter((n) => {
      const end = n.startTime + n.duration;
      return n.startTime < windowEnd && end > windowStart;
    }).length;
  }

  function frameDropsInWindow(windowStart: number, windowEnd: number) {
    const drops = frameGaps.filter(
      (g) => g.windowStart >= windowStart && g.windowStart <= windowEnd
    );
    return {
      count: drops.length,
      worstGap: drops.length > 0 ? Math.max(...drops.map((g) => g.gapMs)) : 0,
    };
  }

  const anomalies: PerformanceAnomaly[] = [];
  const coveredGapIndices = new Set<number>();

  trace.actions.forEach((action, index) => {
    const dur = actionDurations[index];
    if (dur < slowActionThresholdMs) return;

    const type = getActionType(action);
    const netLoad = concurrentNetworkLoad(action.startTime, action.endTime);
    const { count: dropCount, worstGap } = frameDropsInWindow(action.startTime, action.endTime);

    let suspectedCause: PerformanceAnomaly["suspected_cause"] = "unknown";
    if (dropCount > 0) {
      suspectedCause = "main_thread_blocked";
    } else if (netLoad >= 5) {
      suspectedCause = "network_saturation";
    } else if (dur > 3000) {
      suspectedCause = "timeout_or_navigation";
    }

    // Mark overlapping frame drops as covered
    frameGaps.forEach((g, i) => {
      if (g.windowStart >= action.startTime && g.windowStart <= action.endTime) {
        coveredGapIndices.add(i);
      }
    });

    anomalies.push({
      kind: "slow_action",
      blocked_action_id: `${index}:${type}`,
      task_duration_ms: Math.round(dur),
      threshold_ms: slowActionThresholdMs,
      concurrent_network_load: netLoad,
      frame_drop_count: dropCount,
      worst_frame_gap_ms: Math.round(worstGap),
      suspected_cause: suspectedCause,
    });
  });

  // Prominent standalone frame drops (>= 200ms) not covered by a slow action
  const PROMINENT_DROP_MS = 200;
  frameGaps.forEach((gap, i) => {
    if (coveredGapIndices.has(i) || gap.gapMs < PROMINENT_DROP_MS) return;

    const overlappingIdx = trace.actions.findIndex(
      (a) => a.startTime <= gap.windowStart && a.endTime >= gap.windowEnd
    );
    const overlapping = overlappingIdx >= 0 ? trace.actions[overlappingIdx] : null;
    const netLoad = concurrentNetworkLoad(gap.windowStart, gap.windowEnd);

    anomalies.push({
      kind: "frame_drop",
      blocked_action_id: overlapping ? `${overlappingIdx}:${getActionType(overlapping)}` : "none",
      task_duration_ms: Math.round(gap.gapMs),
      threshold_ms: PROMINENT_DROP_MS,
      concurrent_network_load: netLoad,
      frame_drop_count: 1,
      worst_frame_gap_ms: Math.round(gap.gapMs),
      suspected_cause: netLoad >= 3 ? "network_saturation" : "main_thread_blocked",
    });
  });

  // Memory leak: same action type (class.method), >= 3 occurrences with strictly
  // increasing durations (allowing 10% variance)
  const durationsByType = new Map<string, number[]>();
  trace.actions.forEach((action, i) => {
    const dur = actionDurations[i];
    if (dur < 10) return;
    const type = getActionType(action);
    const list = durationsByType.get(type);
    if (list) list.push(dur);
    else durationsByType.set(type, [dur]);
  });

  let suspectedMemoryLeakFlag = false;
  for (const durs of durationsByType.values()) {
    if (durs.length < 3) continue;
    let increasing = true;
    for (let i = 1; i < durs.length; i++) {
      if (durs[i] < durs[i - 1] * 0.9) {
        increasing = false;
        break;
      }
    }
    if (increasing) {
      suspectedMemoryLeakFlag = true;
      break;
    }
  }

  anomalies.sort((a, b) => b.task_duration_ms - a.task_duration_ms);

  return {
    anomalies,
    suspected_memory_leak_flag: suspectedMemoryLeakFlag,
    p50_action_duration_ms: Math.round(p50),
    p95_action_duration_ms: Math.round(p95),
    total_frame_drop_count: totalFrameDropCount,
  };
}

// ---------------------------------------------------------------------------
// map_locator_to_source
// ---------------------------------------------------------------------------

export function mapLocatorToSource(trace: ParsedTrace, actionIndex?: number): LocatorSourceResult {
  let action: TraceAction | undefined;

  if (actionIndex !== undefined) {
    action = trace.actions[actionIndex];
  } else {
    action = trace.actions.find((a) => a.error);
  }

  if (!action) {
    throw new Error(
      actionIndex !== undefined
        ? `Action at index ${actionIndex} not found`
        : "No failing action found in trace"
    );
  }

  const beforeEvent = action.metadata?.before as Record<string, unknown> | undefined;
  const stepId = beforeEvent?.stepId;
  const callId = String(beforeEvent?.callId ?? "");
  const callNum = Number(callId.replace(/^call@/, ""));

  let stepTitle: string | undefined;
  let stack: LocatorSourceResult["stack"] = [];

  // 1. Check trace.stacks (standard in modern Playwright traces and Python / non-JS runners)
  if (trace.stacks && !isNaN(callNum) && trace.stacks.has(callNum)) {
    stack = trace.stacks.get(callNum) ?? [];
  }

  // 2. Fall back to runnerEvent in trace.events if stack is empty
  if (stack.length === 0 && stepId) {
    const runnerEvent = trace.events.find(
      (e) =>
        (e.class === "Test" || e.origin === "testRunner") &&
        e.type === "before" &&
        (e.stepId === stepId || e.callId === stepId)
    );

    if (runnerEvent) {
      stepTitle = runnerEvent.title ? String(runnerEvent.title) : undefined;
      if (runnerEvent.stack && Array.isArray(runnerEvent.stack)) {
        stack = runnerEvent.stack.map((frame: unknown) => {
          const f = frame as Record<string, unknown>;
          return {
            file: String(f.file ?? ""),
            line: Number(f.line ?? 0),
            column: Number(f.column ?? 0),
            function: f.function ? String(f.function) : undefined,
          };
        });
      }
    }
  }

  // Pick source location: prefer the first test file (e.g. test_*.py, *.spec.ts, *.test.ts)
  // that is not inside framework internals (site-packages, node_modules)
  let sourceLocation = stack.length > 0 ? stack[0] : null;
  const testFrame = stack.find(
    (f) =>
      !f.file.includes("site-packages") &&
      !f.file.includes("node_modules") &&
      (f.file.includes("test_") || f.file.includes(".spec.") || f.file.includes(".test."))
  );
  if (testFrame) {
    sourceLocation = testFrame;
  }

  return {
    action_type: action.type,
    locator: action.locator,
    error: action.error,
    step_title: stepTitle,
    stack,
    source_location: sourceLocation,
  };
}

// ---------------------------------------------------------------------------
// get_element_state_at_failure
// ---------------------------------------------------------------------------

export interface ElementDetails {
  tag: string;
  role?: string;
  name?: string;
  id?: string;
  classes?: string;
  is_disabled?: boolean;
  is_hidden?: boolean;
  text_content?: string;
  attributes: Record<string, string>;
}

export interface ElementStateResult {
  failed_action?: string;
  locator?: string;
  error?: string;
  time?: number;
  element_found: boolean;
  element?: ElementDetails;
  message?: string;
  raw?: Record<string, unknown>;
}

export interface ParsedLocator {
  role?: string;
  name?: string;
  id?: string;
  attrName?: string;
  attrValue?: string;
  tag?: string;
  text?: string;
}

export function parseLocatorString(locator: string): ParsedLocator {
  const result: ParsedLocator = {};

  // 1. Role pattern: internal:role=button[name="Edit"i]
  const roleMatch = /internal:role=([a-zA-Z0-9_-]+)(?:\[name="([^"]+)"i?\])?/i.exec(locator);
  if (roleMatch) {
    result.role = roleMatch[1].toLowerCase();
    if (roleMatch[2]) {
      result.name = roleMatch[2].toLowerCase();
    }
    return result;
  }

  // 2. Text pattern: internal:text="Save"i
  const textMatch = /internal:text="([^"]+)"i?/i.exec(locator);
  if (textMatch) {
    result.text = textMatch[1].toLowerCase();
    return result;
  }

  // 3. ID pattern: [id='foo'] or #foo
  const idMatch = /^(?:\[id=['"]([^'"]+)['"]\]|#([a-zA-Z0-9_-]+))$/i.exec(locator.trim());
  if (idMatch) {
    result.id = idMatch[1] ?? idMatch[2];
    return result;
  }

  // 4. Attribute pattern: [formcontrolname='foo'] or [name='bar']
  const attrMatch = /^\[([a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]$/i.exec(locator.trim());
  if (attrMatch) {
    result.attrName = attrMatch[1];
    result.attrValue = attrMatch[2];
    return result;
  }

  // 5. Fallback for tag or word: button, input, etc.
  if (/^[a-zA-Z0-9_-]+$/.test(locator.trim())) {
    result.tag = locator.trim().toUpperCase();
  }

  return result;
}

export function matchSingleLocatorNode(node: SnapNode, parsedLocator: ParsedLocator): boolean {
  if (!Array.isArray(node) || node.length === 0) return false;
  const tag = node[0];
  if (typeof tag !== "string") return false;

  const attrs: Record<string, string> =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1])
      ? (node[1] as Record<string, string>)
      : {};
  const childStart =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1]) ? 2 : 1;
  const children = node.slice(childStart) as (SnapNode | string)[];

  if (parsedLocator.id) {
    return attrs["id"] === parsedLocator.id;
  } else if (parsedLocator.attrName && parsedLocator.attrValue) {
    return attrs[parsedLocator.attrName] === parsedLocator.attrValue;
  } else if (parsedLocator.role) {
    const role = resolveRole(tag, attrs)?.toLowerCase() ?? attrs["role"]?.toLowerCase();
    if (role === parsedLocator.role) {
      if (parsedLocator.name) {
        const name = resolveName(tag, attrs, children).toLowerCase();
        const ariaLabel = (attrs["aria-label"] ?? "").toLowerCase();
        return name.includes(parsedLocator.name) || ariaLabel.includes(parsedLocator.name);
      }
      return true;
    }
    return false;
  } else if (parsedLocator.text) {
    const text = extractText(children).toLowerCase();
    return text.includes(parsedLocator.text);
  } else if (parsedLocator.tag) {
    return tag.toUpperCase() === parsedLocator.tag;
  }

  return false;
}

export function findMatchingNode(
  node: SnapNode,
  parsedLocator: ParsedLocator
): ElementDetails | null {
  if (!Array.isArray(node) || node.length === 0) return null;
  const tag = node[0];
  if (typeof tag !== "string") return null;

  const attrs: Record<string, string> =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1])
      ? (node[1] as Record<string, string>)
      : {};
  const childStart =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1]) ? 2 : 1;
  const children = node.slice(childStart) as (SnapNode | string)[];

  if (matchSingleLocatorNode(node, parsedLocator)) {
    const role = resolveRole(tag, attrs) ?? attrs["role"];
    const name = resolveName(tag, attrs, children);
    const text_content = extractText(children);
    const is_disabled = "disabled" in attrs || attrs["aria-disabled"] === "true";
    const is_hidden =
      attrs["aria-hidden"] === "true" ||
      (attrs["style"] ? /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs["style"]) : false);

    return {
      tag,
      role: role ?? undefined,
      name: name || undefined,
      id: attrs["id"] || undefined,
      classes: attrs["class"] || undefined,
      is_disabled,
      is_hidden,
      text_content: text_content || undefined,
      attributes: attrs,
    };
  }

  // Traverse children
  for (const child of children) {
    if (Array.isArray(child)) {
      const match = findMatchingNode(child as SnapNode, parsedLocator);
      if (match) return match;
    }
  }

  return null;
}

export function getElementStateAtFailure(trace: ParsedTrace): ElementStateResult {
  const failedAction = trace.actions.find((a) => a.error);
  if (!failedAction) {
    return {
      element_found: false,
      message: "No failure found in trace",
    };
  }

  const locator =
    failedAction.locator ??
    ((
      (failedAction.metadata?.before as Record<string, unknown> | undefined)?.params as
        | Record<string, unknown>
        | undefined
    )?.selector as string | undefined);

  const result: ElementStateResult = {
    failed_action: failedAction.type,
    locator,
    error: failedAction.error,
    time: failedAction.startTime,
    element_found: false,
    raw: failedAction.metadata,
  };

  if (!locator) {
    result.message = "Failed action does not have an associated locator selector";
    return result;
  }

  // Find snapshot for failed action
  const callId = (failedAction.metadata as Record<string, { callId?: string }>)?.before?.callId;
  let snapshot =
    trace.snapshots.find(
      (s) => s.callId === callId && (s.phase === "after" || s.snapshotName.startsWith("after@"))
    ) ??
    trace.snapshots.find(
      (s) => s.callId === callId && (s.phase === "before" || s.snapshotName.startsWith("before@"))
    );

  if (!snapshot && trace.snapshots.length > 0) {
    snapshot = trace.snapshots[trace.snapshots.length - 1];
  }

  if (!snapshot || !snapshot.html) {
    result.message = "No DOM snapshot available at moment of failure";
    return result;
  }

  const resolvedHtml = getResolvedSnapshotHtml(trace, snapshot);
  if (!Array.isArray(resolvedHtml)) {
    result.message = "Resolved DOM snapshot is not in a valid node format";
    return result;
  }

  const parsedLocator = parseLocatorString(locator);
  const element = findMatchingNode(resolvedHtml as SnapNode, parsedLocator);

  if (element) {
    result.element_found = true;
    result.element = element;
  } else {
    result.element_found = false;
    result.message = `Element matching locator "${locator}" was not found in the DOM snapshot at failure.`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// query_network_requests
// ---------------------------------------------------------------------------

export interface QueryNetworkOptions {
  url_pattern?: string;
  method?: string;
  status?: number;
  status_range?: string;
  start_time?: number;
  end_time?: number;
  include_body?: boolean;
  max_body_chars?: number;
  limit?: number;
}

export interface NetworkQueryItem {
  url: string;
  method: string;
  status: number;
  start_time: number;
  end_time: number;
  duration: number;
  mime_type: string;
  resource_ref?: string;
  body_snippet?: string;
  response_body?: string;
}

export interface NetworkQueryResult {
  total_matches: number;
  requests: NetworkQueryItem[];
}

export function queryNetworkRequests(
  trace: ParsedTrace,
  options?: QueryNetworkOptions
): NetworkQueryResult {
  let entries = trace.network;

  if (options?.url_pattern) {
    const pat = options.url_pattern;
    try {
      const regex = new RegExp(pat, "i");
      entries = entries.filter((e) => regex.test(e.url));
    } catch {
      const lower = pat.toLowerCase();
      entries = entries.filter((e) => e.url.toLowerCase().includes(lower));
    }
  }

  if (options?.method) {
    const methodUpper = options.method.toUpperCase();
    entries = entries.filter((e) => e.method.toUpperCase() === methodUpper);
  }

  if (options?.status !== undefined) {
    entries = entries.filter((e) => e.status === options.status);
  }

  if (options?.status_range) {
    const range = options.status_range.toLowerCase();
    const prefix = parseInt(range[0], 10);
    if (!isNaN(prefix)) {
      entries = entries.filter((e) => Math.floor(e.status / 100) === prefix);
    }
  }

  if (options?.start_time !== undefined && options?.end_time !== undefined) {
    const start = options.start_time;
    const end = options.end_time;
    entries = entries.filter((e) => {
      const reqStart = e.startTime;
      const reqEnd = e.startTime + e.duration;
      return reqStart <= end && reqEnd >= start;
    });
  } else if (options?.start_time !== undefined) {
    const start = options.start_time;
    entries = entries.filter((e) => e.startTime + e.duration >= start);
  } else if (options?.end_time !== undefined) {
    const end = options.end_time;
    entries = entries.filter((e) => e.startTime <= end);
  }

  const totalMatches = entries.length;
  const limit = options?.limit ?? 50;
  const sliced = limit > 0 ? entries.slice(0, limit) : entries;

  const maxBodyChars = options?.max_body_chars ?? 500;
  const includeBody = options?.include_body ?? false;

  const requests: NetworkQueryItem[] = sliced.map((e) => {
    let body_snippet = e.body_snippet;
    if (!body_snippet && e.resource_ref && trace.resolveResource) {
      const resolved = trace.resolveResource(e.resource_ref);
      if (resolved) {
        body_snippet = resolved.slice(0, 500);
      }
    }

    let responseBody: string | undefined;
    if (includeBody) {
      if (e.resource_ref && trace.resolveResource) {
        const resolved = trace.resolveResource(e.resource_ref);
        if (resolved) {
          responseBody = maxBodyChars > 0 ? resolved.slice(0, maxBodyChars) : resolved;
        }
      }
      if (!responseBody && body_snippet) {
        responseBody = maxBodyChars > 0 ? body_snippet.slice(0, maxBodyChars) : body_snippet;
      }
    }

    return {
      url: e.url,
      method: e.method,
      status: e.status,
      start_time: e.startTime,
      end_time: e.startTime + e.duration,
      duration: e.duration,
      mime_type: e.mimeType,
      ...(e.resource_ref ? { resource_ref: e.resource_ref } : {}),
      ...(body_snippet ? { body_snippet } : {}),
      ...(responseBody !== undefined ? { response_body: responseBody } : {}),
    };
  });

  return {
    total_matches: totalMatches,
    requests,
  };
}

// ---------------------------------------------------------------------------
// search_dom_snapshots
// ---------------------------------------------------------------------------

export interface ParsedCssCompound {
  tag?: string;
  id?: string;
  classes: string[];
  attributes: Array<{ name: string; op?: string; val?: string }>;
}

export function parseCssCompound(s: string): ParsedCssCompound {
  let tag: string | undefined;
  const tagMatch = s.match(/^[a-zA-Z0-9_-]+/);
  if (tagMatch) tag = tagMatch[0].toUpperCase();

  let id: string | undefined;
  const idMatch = s.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) id = idMatch[1];

  const classes: string[] = [];
  const classMatches = s.matchAll(/\.([a-zA-Z0-9_-]+)/g);
  for (const m of classMatches) classes.push(m[1]);

  const attributes: Array<{ name: string; op?: string; val?: string }> = [];
  const attrMatches = s.matchAll(
    /\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:["']([^"']*)["']|([^"'\]]+)))?\]/g
  );
  for (const m of attrMatches) {
    attributes.push({ name: m[1], op: m[2], val: m[3] ?? m[4] });
  }

  return { tag, id, classes, attributes };
}

export function matchCssCompound(node: SnapNode, parsed: ParsedCssCompound): boolean {
  const tag = node[0].toUpperCase();
  const attrs: Record<string, string> =
    node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1])
      ? (node[1] as Record<string, string>)
      : {};

  if (parsed.tag && tag !== parsed.tag) return false;
  if (parsed.id && attrs["id"] !== parsed.id) return false;

  if (parsed.classes.length > 0) {
    const nodeClasses = (attrs["class"] || "").split(/\s+/);
    for (const c of parsed.classes) {
      if (!nodeClasses.includes(c)) return false;
    }
  }

  for (const a of parsed.attributes) {
    if (!a.op) {
      if (!(a.name in attrs)) return false;
    } else if (a.op === "=") {
      if (attrs[a.name] !== a.val) return false;
    } else if (a.op === "*=") {
      if (!attrs[a.name] || !attrs[a.name].includes(a.val ?? "")) return false;
    } else if (a.op === "^=") {
      if (!attrs[a.name] || !attrs[a.name].startsWith(a.val ?? "")) return false;
    } else if (a.op === "$=") {
      if (!attrs[a.name] || !attrs[a.name].endsWith(a.val ?? "")) return false;
    }
  }

  return true;
}

export function matchesDescendantSelector(
  ancestors: SnapNode[],
  node: SnapNode,
  parts: ParsedCssCompound[]
): boolean {
  if (!matchCssCompound(node, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;

  let currentAncestorIdx = ancestors.length - 1;
  for (let pIdx = parts.length - 2; pIdx >= 0; pIdx--) {
    const part = parts[pIdx];
    let found = false;
    while (currentAncestorIdx >= 0) {
      if (matchCssCompound(ancestors[currentAncestorIdx], part)) {
        found = true;
        currentAncestorIdx--;
        break;
      }
      currentAncestorIdx--;
    }
    if (!found) return false;
  }
  return true;
}

export interface SearchDomOptions {
  text?: string;
  pattern?: string;
  selector?: string;
  action_index?: number;
  call_id?: string;
  phase?: string;
  limit?: number;
}

export interface DomSearchResultItem {
  tag: string;
  role?: string;
  name?: string;
  id?: string;
  classes?: string;
  text_content?: string;
  attributes: Record<string, string>;
  parent_context: string;
  matched_by: string;
}

export interface DomSearchResult {
  found: boolean;
  total_matches: number;
  call_id?: string;
  phase?: string;
  snapshot_name?: string;
  matches: DomSearchResultItem[];
  message?: string;
}

export function searchDomSnapshots(
  trace: ParsedTrace,
  options?: SearchDomOptions
): DomSearchResult {
  if (!options?.text && !options?.pattern && !options?.selector) {
    return {
      found: false,
      total_matches: 0,
      matches: [],
      message: "At least one search parameter (text, pattern, or selector) must be provided.",
    };
  }

  let snapshot: FrameSnapshot | undefined;

  if (options.action_index !== undefined) {
    const action = trace.actions[options.action_index];
    if (!action) {
      return {
        found: false,
        total_matches: 0,
        matches: [],
        message: `Action index ${options.action_index} out of range (0-${trace.actions.length - 1})`,
      };
    }
    const callId =
      (action.metadata?.before as Record<string, { callId?: string }> | undefined)?.callId ??
      ((action.metadata?.before as Record<string, unknown> | undefined)?.callId as
        | string
        | undefined);
    if (callId) {
      if (options.phase) {
        snapshot = trace.snapshots.find(
          (s) =>
            s.callId === callId &&
            (s.phase === options.phase || s.snapshotName.startsWith(`${options.phase}@`))
        );
      }
      if (!snapshot) {
        snapshot =
          trace.snapshots.find(
            (s) =>
              s.callId === callId && (s.phase === "after" || s.snapshotName.startsWith("after@"))
          ) ??
          trace.snapshots.find(
            (s) =>
              s.callId === callId && (s.phase === "before" || s.snapshotName.startsWith("before@"))
          ) ??
          trace.snapshots.find((s) => s.callId === callId);
      }
    }
  } else if (options.call_id) {
    if (options.phase) {
      snapshot = trace.snapshots.find(
        (s) =>
          s.callId === options.call_id &&
          (s.phase === options.phase || s.snapshotName.startsWith(`${options.phase}@`))
      );
    }
    if (!snapshot) {
      snapshot =
        trace.snapshots.find(
          (s) =>
            s.callId === options.call_id &&
            (s.phase === "after" || s.snapshotName.startsWith("after@"))
        ) ??
        trace.snapshots.find(
          (s) =>
            s.callId === options.call_id &&
            (s.phase === "before" || s.snapshotName.startsWith("before@"))
        ) ??
        trace.snapshots.find((s) => s.callId === options.call_id);
    }
  } else {
    // Default to failing action's snapshot or latest snapshot
    const failedAction = trace.actions.find((a) => a.error);
    const callId =
      (failedAction?.metadata?.before as Record<string, { callId?: string }> | undefined)?.callId ??
      ((failedAction?.metadata?.before as Record<string, unknown> | undefined)?.callId as
        | string
        | undefined);
    if (callId) {
      snapshot =
        trace.snapshots.find(
          (s) => s.callId === callId && (s.phase === "after" || s.snapshotName.startsWith("after@"))
        ) ??
        trace.snapshots.find(
          (s) =>
            s.callId === callId && (s.phase === "before" || s.snapshotName.startsWith("before@"))
        );
    }
    if (!snapshot && trace.snapshots.length > 0) {
      snapshot = trace.snapshots[trace.snapshots.length - 1];
    }
  }

  if (!snapshot || !snapshot.html) {
    return {
      found: false,
      total_matches: 0,
      matches: [],
      message: "No DOM snapshot found for specified criteria",
    };
  }

  const resolvedHtml = getResolvedSnapshotHtml(trace, snapshot);
  if (!Array.isArray(resolvedHtml)) {
    return {
      found: false,
      total_matches: 0,
      matches: [],
      message: "Resolved DOM snapshot is not in a valid node format",
    };
  }

  let parsedLocator: ParsedLocator | undefined;
  let parsedCssParts: ParsedCssCompound[] | undefined;

  if (options.selector) {
    if (options.selector.startsWith("internal:")) {
      parsedLocator = parseLocatorString(options.selector);
    } else {
      parsedCssParts = options.selector.trim().split(/\s+/).map(parseCssCompound);
    }
  }

  let regex: RegExp | undefined;
  if (options.pattern) {
    try {
      regex = new RegExp(options.pattern, "i");
    } catch {
      // ignore invalid regex, will fall back
    }
  }

  const limit = options.limit ?? 20;
  const matches: DomSearchResultItem[] = [];

  function formatParentContext(parent: SnapNode | null): string {
    if (!parent) return "root";
    const pTag = String(parent[0]).toLowerCase();
    const pAttrs: Record<string, string> =
      parent[1] !== null && typeof parent[1] === "object" && !Array.isArray(parent[1])
        ? (parent[1] as Record<string, string>)
        : {};
    const idStr = pAttrs["id"] ? ` id="${pAttrs["id"]}"` : "";
    const classStr = pAttrs["class"] ? ` class="${pAttrs["class"]}"` : "";
    const roleStr = pAttrs["role"] ? ` role="${pAttrs["role"]}"` : "";
    return `<${pTag}${idStr}${classStr}${roleStr}>`;
  }

  function walk(node: SnapNode, ancestors: SnapNode[], parent: SnapNode | null): void {
    if (matches.length >= limit) return;
    if (!Array.isArray(node) || node.length === 0 || typeof node[0] !== "string") return;

    const tag = node[0];
    const attrs: Record<string, string> =
      node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1])
        ? (node[1] as Record<string, string>)
        : {};
    const childStart =
      node[1] !== null && typeof node[1] === "object" && !Array.isArray(node[1]) ? 2 : 1;
    const children = node.slice(childStart) as (SnapNode | string)[];

    const textContent = extractText(children);

    let matchText = true;
    let matchPattern = true;
    let matchSelector = true;
    const matchedReasons: string[] = [];

    if (options!.text) {
      const queryLower = options!.text.toLowerCase();
      const inAttrs = Object.values(attrs).some((v) =>
        String(v).toLowerCase().includes(queryLower)
      );
      const inText = textContent.toLowerCase().includes(queryLower);
      if (inAttrs) {
        matchedReasons.push("text");
      } else if (inText) {
        const childElementMatches = children.some(
          (c) =>
            Array.isArray(c) &&
            extractText(
              c.slice(
                c[1] !== null && typeof c[1] === "object" && !Array.isArray(c[1]) ? 2 : 1
              ) as (SnapNode | string)[]
            )
              .toLowerCase()
              .includes(queryLower)
        );
        if (!childElementMatches) {
          matchedReasons.push("text");
        } else {
          matchText = false;
        }
      } else {
        matchText = false;
      }
    }

    if (options!.pattern) {
      if (regex) {
        const inAttrs = Object.values(attrs).some((v) => regex!.test(String(v)));
        const inText = regex.test(textContent);
        if (inAttrs) {
          matchedReasons.push("pattern");
        } else if (inText) {
          const childElementMatches = children.some(
            (c) =>
              Array.isArray(c) &&
              regex!.test(
                extractText(
                  c.slice(
                    c[1] !== null && typeof c[1] === "object" && !Array.isArray(c[1]) ? 2 : 1
                  ) as (SnapNode | string)[]
                )
              )
          );
          if (!childElementMatches) {
            matchedReasons.push("pattern");
          } else {
            matchPattern = false;
          }
        } else {
          matchPattern = false;
        }
      } else {
        matchPattern = false;
      }
    }

    if (options!.selector) {
      if (parsedLocator) {
        if (matchSingleLocatorNode(node, parsedLocator)) {
          matchedReasons.push("selector");
        } else {
          matchSelector = false;
        }
      } else if (parsedCssParts) {
        if (matchesDescendantSelector(ancestors, node, parsedCssParts)) {
          matchedReasons.push("selector");
        } else {
          matchSelector = false;
        }
      }
    }

    if (matchText && matchPattern && matchSelector && matchedReasons.length > 0) {
      matches.push({
        tag,
        role: resolveRole(tag, attrs) ?? attrs["role"] ?? undefined,
        name: resolveName(tag, attrs, children) || undefined,
        id: attrs["id"] || undefined,
        classes: attrs["class"] || undefined,
        text_content: textContent ? textContent.slice(0, 500) : undefined,
        attributes: attrs,
        parent_context: formatParentContext(parent),
        matched_by: matchedReasons.join(", "),
      });
    }

    const nextAncestors = [...ancestors, node];
    for (const child of children) {
      if (Array.isArray(child)) {
        walk(child as SnapNode, nextAncestors, node);
      }
    }
  }

  walk(resolvedHtml as SnapNode, [], null);

  return {
    found: matches.length > 0,
    total_matches: matches.length,
    call_id: snapshot.callId,
    phase: snapshot.phase,
    snapshot_name: snapshot.snapshotName,
    matches,
  };
}

// ---------------------------------------------------------------------------
// triage_failure_bundle
// ---------------------------------------------------------------------------

export interface TriageFailureBundleResult {
  has_failure: boolean;
  message?: string;
  test_title?: string;
  error_message?: string;
  failed_action?: {
    action_index: number;
    type: string;
    start_time: number;
    end_time: number;
    locator?: string;
    error?: string;
  };
  source_location?: {
    file: string;
    line: number;
    column: number;
    function?: string;
  } | null;
  step_title?: string;
  element_state?: ElementStateResult;
  recent_network_requests?: NetworkQueryItem[];
  screenshot?: {
    timestamp: number;
    delta_ms: number;
    mime_type: string;
    data: string;
  } | null;
}

export function triageFailureBundle(
  trace: ParsedTrace,
  zipPath?: string,
  lookbackMs = 5000
): TriageFailureBundleResult {
  const failedAction = trace.actions.find((a) => a.error);
  if (!failedAction) {
    return {
      has_failure: false,
      message: "No failure found in trace",
    };
  }

  const actionIndex = trace.actions.indexOf(failedAction);

  // 1. Source mapping
  const sourceResult = mapLocatorToSource(trace, actionIndex);

  // 2. Element state
  const elementState = getElementStateAtFailure(trace);

  // 3. Screenshot at failure
  let screenshot: TriageFailureBundleResult["screenshot"] = null;
  if (zipPath) {
    try {
      const screenshots = extractScreenshots(zipPath, trace.events);
      if (screenshots.length > 0) {
        const before = screenshots.filter((s) => s.timestamp <= failedAction.startTime);
        const target =
          before.length > 0 ? before[before.length - 1] : screenshots[screenshots.length - 1];
        screenshot = {
          timestamp: target.timestamp,
          delta_ms: Math.round(failedAction.startTime - target.timestamp),
          mime_type: "image/jpeg",
          data: target.data.toString("base64"),
        };
      }
    } catch {
      // screenshot extraction failed or file not accessible
    }
  }

  // 4. Recent network requests within lookbackMs
  const tFail = failedAction.startTime;
  const startTime = Math.max(0, tFail - lookbackMs);
  const netResult = queryNetworkRequests(trace, {
    start_time: startTime,
    end_time: tFail,
    include_body: true,
    max_body_chars: 500,
  });

  return {
    has_failure: true,
    test_title: trace.metadata.testTitle ?? trace.metadata.title,
    error_message: failedAction.error,
    failed_action: {
      action_index: actionIndex,
      type: failedAction.type,
      start_time: failedAction.startTime,
      end_time: failedAction.endTime,
      locator: failedAction.locator,
      error: failedAction.error,
    },
    source_location: sourceResult.source_location ?? null,
    step_title: sourceResult.step_title,
    element_state: elementState,
    recent_network_requests: netResult.requests,
    screenshot,
  };
}
