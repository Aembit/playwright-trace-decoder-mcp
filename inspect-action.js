import AdmZip from "adm-zip";

const zipPath = "/Users/albertdev/Projects/ideas/sample-playwright-project/test-results/google-pom-Google-Search-P-c990e-entionally-for-MCP-analysis-chromium/trace.zip";
const zip = new AdmZip(zipPath);

function getEventsFromEntry(entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return [];
  const lines = entry.getData().toString("utf8").split("\n");
  const events = [];
  for (const line of lines) {
    if (line.trim()) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {}
    }
  }
  return events;
}

const testTraceEvents = getEventsFromEntry("test.trace");
const clickEvent = testTraceEvents.find(e => e.params && e.params.selector === "#super-toad-not-found");

console.log("=== Click Event in test.trace ===");
console.log(JSON.stringify(clickEvent, null, 2));

const traceEvents = getEventsFromEntry("0-trace.trace");
const browserClickEvent = traceEvents.find(e => e.type === "before" && e.params && e.params.selector === "#super-toad-not-found");

console.log("\n=== Click Event in 0-trace.trace ===");
console.log(JSON.stringify(browserClickEvent, null, 2));
