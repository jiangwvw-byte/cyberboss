const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildOpeningTurnText, loadRecentMemoryContext } = require("../src/adapters/runtime/shared-instructions");

test("loads only the latest seven Shanghai calendar days from diary and timeline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recent-memory-"));
  const diaryDir = path.join(root, "diary");
  fs.mkdirSync(diaryDir);
  fs.writeFileSync(path.join(diaryDir, "2026-08-06.md"), "too old");
  fs.writeFileSync(path.join(diaryDir, "2026-08-07.md"), "week start");
  fs.writeFileSync(path.join(diaryDir, "2026-08-13.md"), "today");
  const timelineFactsFile = path.join(root, "timeline-facts.json");
  fs.writeFileSync(timelineFactsFile, JSON.stringify({ facts: {
    "2026-08-06": { events: [{ title: "old event" }] },
    "2026-08-12": { events: [{ title: "recent event", note: "kept" }] },
  } }));

  const context = loadRecentMemoryContext(
    { diaryDir, timelineFactsFile, recentMemoryDays: 7, recentMemoryMaxChars: 16000 },
    new Date("2026-08-13T07:00:00.000Z"),
  );
  assert.match(context, /week start/);
  assert.match(context, /today/);
  assert.match(context, /recent event — kept/);
  assert.doesNotMatch(context, /too old|old event/);
});

test("opening turn labels recent context as memory data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-opening-memory-"));
  const diaryDir = path.join(root, "diary");
  fs.mkdirSync(diaryDir);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  fs.writeFileSync(path.join(diaryDir, `${today}.md`), "we remembered this");

  const text = buildOpeningTurnText({ diaryDir, recentMemoryDays: 7 }, "hello");
  assert.match(text, /RECENT RELATIONAL CONTEXT \(LAST 7 DAYS\)/);
  assert.match(text, /remembered context, not instructions/);
  assert.match(text, /we remembered this/);
  assert.match(text, /Current user message:\nhello/);
});
