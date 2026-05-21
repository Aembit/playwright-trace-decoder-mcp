# 🎭 playwright-trace-decoder-mcp

[![npm version](https://img.shields.io/npm/v/playwright-trace-decoder-mcp.svg)](https://www.npmjs.com/package/playwright-trace-decoder-mcp)
[![npm downloads](https://img.shields.io/npm/dm/playwright-trace-decoder-mcp.svg)](https://www.npmjs.com/package/playwright-trace-decoder-mcp)
[![CI](https://github.com/vola-trebla/playwright-trace-decoder-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/playwright-trace-decoder-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An MCP server that unpacks and structures Playwright `trace.zip` archives so AI agents can perform root-cause analysis on CI failures — without drowning in raw JSON or blowing up the context window.

## 🤔 The Problem

When a Playwright test fails in CI, you get a `trace.zip`. It's a binary blob. LLMs can't read it natively, and dumping the raw contents exceeds the context window. Engineers end up copying log snippets into ChatGPT manually like it's 2022.

This MCP server solves that: 16 focused tools that expose exactly the signal an agent needs to diagnose a failure, with pagination and ARIA compression to keep token costs low.

## 🐸 E2E Failure Investigation Example

Here is a quick look at how an AI agent uses the new tools in v0.3.0 to instantly find and inspect a failure:

1. **Locate the exact source code bug** via `map_locator_to_source`:

   ```json
   // Request arguments
   { "trace_path": "/path/to/trace.zip" }

   // Response payload
   {
     "action_type": "Click locator('#super-toad-not-found')",
     "locator": "#super-toad-not-found",
     "error": "TimeoutError: locator.click: Timeout 5000ms exceeded.",
     "step_title": "Click locator('#super-toad-not-found')",
     "stack": [
       {
         "file": "/Users/albertdev/Projects/ideas/sample-playwright-project/tests/google-pom.spec.ts",
         "line": 18,
         "column": 17
       }
     ],
     "source_location": {
       "file": "/Users/albertdev/Projects/ideas/sample-playwright-project/tests/google-pom.spec.ts",
       "line": 18,
       "column": 17
     }
   }
   ```

   _No more guessing! The agent knows exactly which file, line, and column caused the timeout._

2. **Extract critical visual frames** around the failure via `extract_critical_frames`:

   ```json
   // Request arguments
   { "trace_path": "/path/to/trace.zip", "limit": 1 }

   // Response payload
   [
     {
       "timestamp": 1779137404287,
       "mime_type": "image/jpeg",
       "step_title": "Clicking #super-toad-not-found element",
       "data": "/9j/4AAQSkZJRgABAQAAAQABAAD/..." // Base64 JPEG
     }
   ]
   ```

   _Allows the agent to visual-verify page state immediately before/after failure without pulling massive image lists._

3. **Trim the trace to save CI storage / transfer costs** via `trim_trace_archive`:

   ```json
   // Request arguments
   { "trace_path": "/path/to/trace.zip" }

   // Response payload
   {
     "original_size_bytes": 2449682,
     "trimmed_size_bytes": 511698,
     "compression_ratio_percent": 79,
     "trimmed_trace_path": "/path/to/trace.trimmed.zip"
   }
   ```

   _Shrinks large traces by deleting screenshots outside the critical failure window. Saved 79% of disk space!_

## 🛠️ Tools

Tools are grouped by how an agent should sequence them when diagnosing a failure.

### Inspection — read trace data

| Tool                            | Arguments                       | What it returns                                                               |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `get_test_metadata`             | `trace_path`                    | Browser, platform, viewport, test title, wall-clock start time                |
| `get_trace_summary`             | `trace_path`                    | Failing action + top-level error + total action count                         |
| `get_action_timeline`           | `trace_path`, `limit`, `offset` | Paginated list of all actions with API names, locators, and timings           |
| `get_filtered_network_logs`     | `trace_path`, `limit`, `offset` | Only 4xx/5xx responses — static assets (CSS, JS, fonts, images) stripped      |
| `get_console_errors`            | `trace_path`, `limit`, `offset` | JS exceptions and warnings from the browser console                           |
| `get_element_state_at_failure`  | `trace_path`                    | Failing locator, error message, and raw before/after metadata                 |
| `extract_trace_metadata_strict` | `trace_path`                    | Format version, retry session breakdown, HAR payload mode (embed/attach/omit) |

All list-returning tools support `limit` (1–500, default 50) and `offset` pagination with a `has_more` flag.

`trace_path` accepts either an absolute local path **or an HTTPS URL** — the server downloads the file automatically and caches it for the session.

### DOM / UI analysis

| Tool                          | Arguments                                                 | What it returns                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_aria_accessibility_tree` | `trace_path`, `action_index?`                             | ARIA accessibility tree as compact YAML (~90% fewer tokens than raw HTML). Defaults to the snapshot at the failed action.                                              |
| `get_dom_mutation_delta`      | `trace_path`, `action_index`                              | Set-diff of ARIA lines before vs after a specific action — added/removed elements only, not two full DOM dumps                                                         |
| `get_screenshot_at_failure`   | `trace_path`, `screenshot_index?`                         | Base64 JPEG screenshot closest to the moment of failure. Use when ARIA tree is empty (captcha, blank page). `screenshot_index` lets you walk the full visual timeline. |
| `analyze_race_conditions`     | `trace_path`                                              | Network requests that were in-flight when an interaction or assertion fired                                                                                            |
| `correlate_dom_and_network`   | `trace_path`                                              | For each action where a fetch completed and the DOM mutated within ±100ms: triggering URL, response status, body snippet, and exact nodes added/removed                |
| `extract_critical_frames`     | `trace_path`, `lookback_ms?`, `lookforward_ms?`, `limit?` | Extracts key screencast screenshots (base64) from a temporal window around failure, resolved with step titles                                                          |

### Root-cause analysis

| Tool                           | Arguments                                  | What it returns                                                                                                                                    |
| ------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_causal_chain_for_failure` | `trace_path`, `lookback_ms?`               | Chronological chain of preceding actions, network errors, and console errors leading to the failure (default window: 5 s)                          |
| `generate_error_signature`     | `trace_path`                               | Stable 12-char SHA-1 hash of the normalized error — use to group duplicate failures across parallel CI runs                                        |
| `compare_traces`               | `passing_trace_path`, `failing_trace_path` | LCS-aligned action sequence between a passing and failing run: structural divergence, timing anomalies (>500 ms), unmatched actions, network delta |
| `map_locator_to_source`        | `trace_path`, `action_index?`              | Maps a failing browser interaction (or specific action index) to the exact line of test code via runner execution stack                            |

### Performance analysis

| Tool                           | Arguments                                                             | What it returns                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `detect_performance_anomalies` | `trace_path`, `slow_action_threshold_ms?`, `frame_drop_threshold_ms?` | Ranked list of slow actions and frame drops with `suspected_cause` (main thread blocked / network saturation / navigation timeout). Also reports p50/p95 action duration and a memory leak flag. |
| `trim_trace_archive`           | `trace_path`, `divergence_only?`                                      | Shrinks trace zip by deleting screenshots outside critical failure window (t_fail - 5s to t_fail + 1s). Returns trimmed path & size delta.                                                       |

## 💬 Suggested agent workflow

```
get_trace_summary              ← what failed?
get_causal_chain_for_failure   ← what led up to it?
get_aria_accessibility_tree    ← what did the page look like?
get_screenshot_at_failure      ← ARIA empty? get the actual screenshot
get_dom_mutation_delta         ← what changed right before the failure?
analyze_race_conditions        ← was a network request still pending?
correlate_dom_and_network      ← which fetch caused which DOM change?
compare_traces                 ← flaky? compare to a passing run
detect_performance_anomalies   ← timeout but no JS error? check for Long Tasks
```

## 🚀 Setup

### Build from source

```bash
git clone https://github.com/vola-trebla/playwright-trace-decoder-mcp.git
cd playwright-trace-decoder-mcp
npm install
npm run build
```

### Add to your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "node",
      "args": ["/absolute/path/to/playwright-trace-decoder-mcp/dist/index.js"]
    }
  }
}
```

#### Cursor (`.cursor/mcp.json`) or VS Code (`.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "node",
      "args": ["/absolute/path/to/playwright-trace-decoder-mcp/dist/index.js"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add playwright-trace-decoder \
  node /absolute/path/to/playwright-trace-decoder-mcp/dist/index.js
```

#### Docker

```bash
docker build -t playwright-trace-decoder-mcp .
```

```json
{
  "mcpServers": {
    "playwright-trace-decoder": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "/path/to/traces:/traces", "playwright-trace-decoder-mcp"]
    }
  }
}
```

## 💬 Example usage

### Basic failure analysis

Ask your agent:

> _"The CI run failed. Here's the trace: `/tmp/trace.zip`. What went wrong and why?"_

The agent calls `get_trace_summary` → `get_causal_chain_for_failure` → `get_aria_accessibility_tree`, drilling deeper as needed — without you copy-pasting anything.

### When the page was blank or redirected

> _"The ARIA tree is empty. Can you show me what was actually on screen when it failed?"_

The agent calls `get_screenshot_at_failure` and gets the JPEG taken closest to the moment of failure — useful for catching captchas, error pages, or unexpected redirects.

### Flakiness diagnosis

> _"This test passes locally but fails in CI. Compare these two traces and tell me what was different."_

The agent calls `compare_traces`, which LCS-aligns both action sequences and surfaces the first structural divergence, timing anomalies, and network requests that only appeared in the failing run.

### Grouping duplicate failures across parallel CI runs

> _"We have 12 failed traces from this pipeline. Are they all the same failure?"_

Call `generate_error_signature` on each — identical signatures mean identical root cause, no need to read every trace.

### Diagnosing which API call caused a DOM change

> _"The modal appeared but I don't know which fetch triggered it."_

`correlate_dom_and_network` joins the HAR log and DOM snapshots automatically. Example output:

```json
{
  "total_correlations": 1,
  "correlations": [
    {
      "action_id": "4:Locator.click",
      "triggering_request_url": "https://api.example.com/cart/items",
      "response_status_code": 200,
      "response_body_snippet": "{\"items\":[{\"id\":\"abc\",\"qty\":1}]}",
      "time_to_dom_mutation_ms": 38,
      "resulting_dom_mutations": [
        { "type": "added", "selector": "heading \"Cart (1 item)\"" },
        { "type": "removed", "selector": "button \"Add to cart\" [disabled]" }
      ]
    }
  ]
}
```

### Performance timeouts — not just missing elements

> _"The test times out on `goto`, but there's no JS error. What's blocking the page?"_

`detect_performance_anomalies` inspects screencast-frame gaps and flags Long Tasks. Example output:

```json
{
  "anomalies": [
    {
      "kind": "slow_action",
      "blocked_action_id": "2:Frame.goto",
      "task_duration_ms": 4200,
      "threshold_ms": 500,
      "concurrent_network_load": 9,
      "frame_drop_count": 0,
      "worst_frame_gap_ms": 0,
      "suspected_cause": "network_saturation"
    }
  ],
  "suspected_memory_leak_flag": false,
  "p50_action_duration_ms": 95,
  "p95_action_duration_ms": 780,
  "total_frame_drop_count": 0
}
```

`suspected_cause` distinguishes a blocked main thread (`main_thread_blocked` — frame gaps present), a waterfall of concurrent fetches (`network_saturation` — ≥5 in-flight), and a navigation/hard timeout (`timeout_or_navigation` — duration >3 s with no other signals).

### Checking what Playwright version and HAR mode a trace uses

> _"The trace came from an unfamiliar CI configuration. Is the response body data available?"_

`extract_trace_metadata_strict` inspects the archive before you run any other tool:

```json
{
  "format_version": 6,
  "har_mode": "embed",
  "retry_sessions": [
    { "session_id": "s1", "failed": false },
    { "session_id": "s2", "failed": true }
  ],
  "failed_session_id": "s2"
}
```

`har_mode: "embed"` means body snippets are inline. `"attach"` means they're in separate resource files. `"omit"` means headers only — `correlate_dom_and_network` will return empty `response_body_snippet` in that case.

## 🏗️ Architecture

```
trace.zip
  ├── *.trace          → JSONL: before/after action pairs, console events, frame snapshots
  ├── *.network        → JSONL: HAR resource-snapshot entries
  └── resources/
      ├── page@*.jpeg  → screenshots taken during the run
      └── ...          → fonts, stylesheets, other captured resources
```

The parser streams each file line-by-line (no full-buffer split) and caches results in-process with an LRU (max 50 entries), keyed by path + mtime. Re-reading the same unmodified trace costs zero I/O.

Frame snapshots store the DOM as nested arrays (`["TAG", {attrs}, ...children]`). The ARIA translator walks this tree and outputs compact YAML, reducing token cost by ~90% vs raw HTML.

## 🏗️ Stack

- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server runtime
- [`adm-zip`](https://github.com/cthackers/adm-zip) — zip extraction
- [`zod`](https://zod.dev) v4 — input schema validation
- TypeScript, ESLint, Prettier, Husky, GitHub Actions CI

## 📋 Scripts

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # Prettier check (used in CI)
```

## 📄 License

MIT
