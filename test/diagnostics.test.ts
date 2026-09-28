import { describe, expect, it } from "vitest";
import {
  parseLocatorString,
  findMatchingNode,
  getElementStateAtFailure,
  queryNetworkRequests,
  searchDomSnapshots,
  triageFailureBundle,
} from "../src/diagnostics.js";
import { SnapNode } from "../src/aria-translator.js";
import { ParsedTrace } from "../src/types.js";

describe("parseLocatorString", () => {
  it("parses role and name locator", () => {
    const loc = parseLocatorString('internal:role=button[name="Save Changes"i]');
    expect(loc.role).toBe("button");
    expect(loc.name).toBe("save changes");
  });

  it("parses id locator", () => {
    const loc1 = parseLocatorString("[id='AzureEntraFederation']");
    expect(loc1.id).toBe("AzureEntraFederation");

    const loc2 = parseLocatorString("#submit-btn");
    expect(loc2.id).toBe("submit-btn");
  });

  it("parses attribute selector", () => {
    const loc = parseLocatorString("[name='username']");
    expect(loc.attrName).toBe("name");
    expect(loc.attrValue).toBe("username");
  });
});

describe("findMatchingNode", () => {
  const sampleTree: SnapNode = [
    "DIV",
    { id: "container", class: "wrapper" },
    [
      "FORM",
      { id: "login-form" },
      ["INPUT", { id: "username", name: "user_field", type: "text", placeholder: "Enter user" }],
      ["BUTTON", { id: "submit-btn", class: "btn btn-primary", disabled: "true" }, "Submit Form"],
    ],
  ];

  it("finds matching node by role and name", () => {
    const parsed = parseLocatorString('internal:role=button[name="Submit"i]');
    const match = findMatchingNode(sampleTree, parsed);

    expect(match).not.toBeNull();
    expect(match?.tag).toBe("BUTTON");
    expect(match?.role).toBe("button");
    expect(match?.id).toBe("submit-btn");
    expect(match?.is_disabled).toBe(true);
    expect(match?.text_content).toContain("Submit");
  });

  it("finds matching node by id", () => {
    const parsed = parseLocatorString("[id='username']");
    const match = findMatchingNode(sampleTree, parsed);

    expect(match).not.toBeNull();
    expect(match?.tag).toBe("INPUT");
    expect(match?.attributes["name"]).toBe("user_field");
  });

  it("returns null when element is not in tree", () => {
    const parsed = parseLocatorString('internal:role=button[name="Delete"i]');
    const match = findMatchingNode(sampleTree, parsed);

    expect(match).toBeNull();
  });
});

describe("getElementStateAtFailure", () => {
  it("reports element_found: false when element is missing at failure", () => {
    const mockTrace = {
      actions: [
        {
          type: "Frame.click",
          startTime: 1000,
          endTime: 2000,
          locator: 'internal:role=button[name="NonExistent"i]',
          error: "Timeout 30000ms exceeded",
          metadata: {
            before: {
              callId: "call@1",
            },
          },
        },
      ],
      snapshots: [
        {
          callId: "call@1",
          phase: "after",
          snapshotName: "after@1",
          frameUrl: "http://localhost",
          timestamp: 1500,
          html: ["DIV", {}, ["BUTTON", { id: "other" }, "Other"]],
        },
      ],
      events: [],
      network: [],
      console: [],
      metadata: {},
    } as unknown as ParsedTrace;

    const result = getElementStateAtFailure(mockTrace);
    expect(result.element_found).toBe(false);
    expect(result.message).toContain("was not found in the DOM snapshot");
  });

  it("reports real element details when found at failure", () => {
    const mockTrace = {
      actions: [
        {
          type: "Frame.click",
          startTime: 1000,
          endTime: 2000,
          locator: 'internal:role=button[name="DisabledBtn"i]',
          error: "Timeout 30000ms exceeded",
          metadata: {
            before: {
              callId: "call@1",
            },
          },
        },
      ],
      snapshots: [
        {
          callId: "call@1",
          phase: "after",
          snapshotName: "after@1",
          frameUrl: "http://localhost",
          timestamp: 1500,
          html: [
            "DIV",
            {},
            ["BUTTON", { id: "btn1", class: "btn disabled", disabled: "true" }, "DisabledBtn"],
          ],
        },
      ],
      events: [],
      network: [],
      console: [],
      metadata: {},
    } as unknown as ParsedTrace;

    const result = getElementStateAtFailure(mockTrace);
    expect(result.element_found).toBe(true);
    expect(result.element?.id).toBe("btn1");
    expect(result.element?.is_disabled).toBe(true);
    expect(result.element?.classes).toBe("btn disabled");
  });
});

describe("queryNetworkRequests", () => {
  const mockTrace: ParsedTrace = {
    metadata: {},
    events: [],
    actions: [],
    snapshots: [],
    console: [],
    network: [
      {
        url: "https://example.com/api/v2/workspaces",
        method: "GET",
        status: 200,
        startTime: 1000,
        duration: 200,
        mimeType: "application/json",
        resource_ref: "resources/sha12345.json",
      },
      {
        url: "https://example.com/api/v2/workspaces",
        method: "POST",
        status: 201,
        startTime: 2000,
        duration: 300,
        mimeType: "application/json",
        body_snippet: '{"id":"ws-1"}',
      },
      {
        url: "https://example.com/api/v2/tokens/generate",
        method: "POST",
        status: 400,
        startTime: 3000,
        duration: 150,
        mimeType: "application/json",
      },
      {
        url: "https://example.com/static/bundle.js",
        method: "GET",
        status: 200,
        startTime: 500,
        duration: 100,
        mimeType: "application/javascript",
      },
    ],
    resolveResource: (ref: string) => {
      if (ref === "resources/sha12345.json") {
        return JSON.stringify({ workspaces: [{ id: "ws-1", name: "Engineering" }] });
      }
      return undefined;
    },
  };

  it("filters requests by URL pattern and status", () => {
    const result = queryNetworkRequests(mockTrace, {
      url_pattern: "/api/v2/workspaces",
      status: 200,
    });
    expect(result.total_matches).toBe(1);
    expect(result.requests[0].method).toBe("GET");
    expect(result.requests[0].status).toBe(200);
    expect(result.requests[0].duration).toBe(200);
  });

  it("filters requests by status range and method", () => {
    const result = queryNetworkRequests(mockTrace, {
      method: "POST",
      status_range: "2xx",
    });
    expect(result.total_matches).toBe(1);
    expect(result.requests[0].status).toBe(201);
  });

  it("filters requests by temporal window", () => {
    // Window [900, 1100] captures GET /workspaces (startTime 1000, endTime 1200)
    const result = queryNetworkRequests(mockTrace, {
      start_time: 900,
      end_time: 1100,
    });
    expect(result.total_matches).toBe(1);
    expect(result.requests[0].url).toContain("/api/v2/workspaces");

    // Window [2500, 3500] captures POST /tokens/generate (startTime 3000, endTime 3150)
    const result2 = queryNetworkRequests(mockTrace, {
      start_time: 2500,
      end_time: 3500,
    });
    expect(result2.total_matches).toBe(1);
    expect(result2.requests[0].url).toContain("/tokens/generate");
  });

  it("resolves attached response payloads from resource entries when include_body is true", () => {
    const result = queryNetworkRequests(mockTrace, {
      url_pattern: "/api/v2/workspaces",
      status: 200,
      include_body: true,
    });
    expect(result.total_matches).toBe(1);
    expect(result.requests[0].response_body).toBe(
      JSON.stringify({ workspaces: [{ id: "ws-1", name: "Engineering" }] })
    );
  });

  it("truncates response_body using max_body_chars", () => {
    const result = queryNetworkRequests(mockTrace, {
      url_pattern: "/api/v2/workspaces",
      status: 200,
      include_body: true,
      max_body_chars: 10,
    });
    expect(result.total_matches).toBe(1);
    expect(result.requests[0].response_body?.length).toBe(10);
  });
});

describe("searchDomSnapshots", () => {
  const sampleDom: SnapNode = [
    "HTML",
    {},
    [
      "BODY",
      { class: "main-body" },
      [
        "DIV",
        { id: "app-container", class: "container" },
        [
          "FORM",
          { id: "edit-form", class: "form-horizontal" },
          [
            "DIV",
            { class: "form-group" },
            ["INPUT", { id: "name-input", name: "workspace_name", value: "Engineering Workspace" }],
            [
              "BUTTON",
              {
                id: "save-btn",
                class: "btn btn-primary",
                "data-testid": "save-button",
                type: "submit",
              },
              "Save Changes",
            ],
            ["BUTTON", { id: "cancel-btn", class: "btn btn-secondary", type: "button" }, "Cancel"],
          ],
        ],
      ],
    ],
  ];

  const mockTrace: ParsedTrace = {
    metadata: {},
    events: [],
    actions: [
      {
        type: "Frame.click",
        startTime: 1000,
        endTime: 1200,
        locator: 'internal:role=button[name="Save Changes"i]',
        metadata: { before: { callId: "call@100" } },
      },
    ],
    snapshots: [
      {
        callId: "call@100",
        snapshotName: "before@100",
        phase: "before",
        frameUrl: "https://example.com/app",
        timestamp: 1000,
        html: ["HTML", {}, ["BODY", {}, ["P", {}, "Old Content"]]],
      },
      {
        callId: "call@100",
        snapshotName: "after@100",
        phase: "after",
        frameUrl: "https://example.com/app",
        timestamp: 1200,
        html: sampleDom,
      },
    ],
    console: [],
    network: [],
  };

  it("searches text presence and reports tag name and parent container context", () => {
    const result = searchDomSnapshots(mockTrace, {
      text: "Save Changes",
      action_index: 0,
    });

    expect(result.found).toBe(true);
    expect(result.total_matches).toBe(1);
    expect(result.matches[0].tag).toBe("BUTTON");
    expect(result.matches[0].id).toBe("save-btn");
    expect(result.matches[0].parent_context).toContain('<div class="form-group">');
    expect(result.matches[0].matched_by).toContain("text");
  });

  it("resolves snapshot by callId and phase", () => {
    const resultBefore = searchDomSnapshots(mockTrace, {
      text: "Old Content",
      call_id: "call@100",
      phase: "before",
    });
    expect(resultBefore.found).toBe(true);
    expect(resultBefore.matches[0].tag).toBe("P");

    const resultAfter = searchDomSnapshots(mockTrace, {
      text: "Save Changes",
      call_id: "call@100",
      phase: "after",
    });
    expect(resultAfter.found).toBe(true);
    expect(resultAfter.matches[0].tag).toBe("BUTTON");
  });

  it("matches CSS compound and descendant selectors", () => {
    const result1 = searchDomSnapshots(mockTrace, {
      selector: "button.btn-primary",
      call_id: "call@100",
    });
    expect(result1.found).toBe(true);
    expect(result1.matches[0].id).toBe("save-btn");

    const result2 = searchDomSnapshots(mockTrace, {
      selector: "form [data-testid='save-button']",
      call_id: "call@100",
    });
    expect(result2.found).toBe(true);
    expect(result2.matches[0].id).toBe("save-btn");
  });

  it("matches regular expression patterns", () => {
    const result = searchDomSnapshots(mockTrace, {
      pattern: "Engineering\\s+Workspace",
      call_id: "call@100",
    });
    expect(result.found).toBe(true);
    expect(result.matches[0].tag).toBe("INPUT");
    expect(result.matches[0].id).toBe("name-input");
  });
});

describe("triageFailureBundle", () => {
  it("returns has_failure: false when trace has no errors", () => {
    const trace: ParsedTrace = {
      metadata: { title: "passing_test" },
      actions: [{ type: "page.goto", startTime: 100, endTime: 200 }],
      network: [],
      snapshots: [],
      events: [],
      console: [],
    };

    const bundle = triageFailureBundle(trace);
    expect(bundle.has_failure).toBe(false);
    expect(bundle.message).toContain("No failure found");
  });

  it("assembles composite failure bundle for failed trace", () => {
    const trace: ParsedTrace = {
      metadata: { title: "failing_test_example", testTitle: "failing_test_example" },
      actions: [
        {
          type: "Frame.click",
          startTime: 10000,
          endTime: 10500,
          locator: 'internal:role=button[name="Submit"i]',
          error: "Timeout 30000ms exceeded waiting for button",
          metadata: {
            before: {
              callId: "call@fail",
              params: { selector: 'internal:role=button[name="Submit"i]' },
            },
          },
        },
      ],
      network: [
        {
          url: "https://example.com/api/v1/status",
          method: "GET",
          status: 200,
          startTime: 8000,
          duration: 100,
          mimeType: "application/json",
          body_snippet: '{"status":"ok"}',
        },
        {
          url: "https://example.com/api/v1/old",
          method: "GET",
          status: 200,
          startTime: 2000,
          duration: 100,
          mimeType: "application/json",
        },
      ],
      snapshots: [
        {
          callId: "call@fail",
          phase: "after",
          snapshotName: "after@fail",
          frameUrl: "https://example.com",
          timestamp: 10500,
          html: [
            "DIV",
            {},
            ["BUTTON", { id: "sub-btn", disabled: "true", class: "btn" }, "Submit"],
          ],
        },
      ],
      events: [],
      console: [],
    };

    const bundle = triageFailureBundle(trace);
    expect(bundle.has_failure).toBe(true);
    expect(bundle.test_title).toBe("failing_test_example");
    expect(bundle.error_message).toContain("Timeout 30000ms exceeded");
    expect(bundle.failed_action?.type).toBe("Frame.click");
    expect(bundle.failed_action?.action_index).toBe(0);

    // Element state
    expect(bundle.element_state?.element_found).toBe(true);
    expect(bundle.element_state?.element?.id).toBe("sub-btn");
    expect(bundle.element_state?.element?.is_disabled).toBe(true);

    // Recent network requests within 5000ms (startTime >= 5000 and <= 10000)
    // /api/v1/status is at 8000 (included), /api/v1/old is at 2000 (excluded)
    expect(bundle.recent_network_requests).toHaveLength(1);
    expect(bundle.recent_network_requests![0].url).toContain("/api/v1/status");
  });
});
