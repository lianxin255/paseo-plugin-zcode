import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Offline regression tests for the GLM usage parser in server/usage.ts:
// no credentials, no network. ZCODE_HOME points at a throwaway fake config
// and global fetch is stubbed, so the full discover → fetch → report path
// runs end-to-end against synthetic quota payloads.

let failures = 0;
function check(name, got, expected) {
  try {
    assert.deepStrictEqual(got, expected);
  } catch (error) {
    console.error(`FAIL: ${name}\n${error.message}`);
    failures++;
  }
}

// The host may export a real ZCODE_PROVIDER pin and ZCODE_HOME; tests must
// see the fake environment unfiltered. Saved and restored around the run.
const savedProviderPin = process.env.ZCODE_PROVIDER;
const savedHome = process.env.ZCODE_HOME;
delete process.env.ZCODE_PROVIDER;

// Fake ZCODE_HOME with one enabled official-host provider; must be set
// before importing the module, which reads config lazily per call.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-usage-test-"));
fs.mkdirSync(path.join(fakeHome, "v2"), { recursive: true });
fs.writeFileSync(
  path.join(fakeHome, "v2", "config.json"),
  JSON.stringify({
    provider: {
      glm: { enabled: true, options: { apiKey: "fake-key", baseURL: "https://api.z.ai/api/coding/paas/v4" } },
      gateway: { enabled: true, options: { apiKey: "gw-key", baseURL: "http://localhost:9000/v1" } },
    },
  }),
);
process.env.ZCODE_HOME = fakeHome;

const compiled = new URL("../dist-plugin/server/usage.js", import.meta.url);
const usageMod = await import(compiled);

// --- describeLimit: current, legacy, MCP, and unknown shapes -------------
const describe = usageMod.describeLimit;
const expectations = [
  // Real current payloads: CREDIT_LIMIT with numeric unit (3 = hour, 6 = week).
  [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 27, nextResetTime: 1792863679566 },
    { id: "token_5h", label: "5-hour", shortLabel: "5h", summary: true },
  ],
  [
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 27, nextResetTime: 1793248996981 },
    { id: "token_week", label: "Weekly", shortLabel: "wk", summary: true },
  ],
  // String-encoded numbers from JSON must parse the same.
  [{ type: "CREDIT_LIMIT", unit: "3", number: "5" }, { id: "token_5h", label: "5-hour", shortLabel: "5h", summary: true }],
  [{ type: "TOKENS_LIMIT", number: "7" }, { id: "token_week", label: "Weekly", shortLabel: "wk", summary: true }],
  // Legacy TOKENS_LIMIT naming stays pinned: known, other, and missing numbers.
  [{ type: "TOKENS_LIMIT", number: 5 }, { id: "token_5h", label: "5-hour", shortLabel: "5h", summary: true }],
  [{ type: "TOKENS_LIMIT", number: 7 }, { id: "token_week", label: "Weekly", shortLabel: "wk", summary: true }],
  [{ type: "TOKENS_LIMIT", number: 8 }, { id: "token_8", label: "Token 8h", shortLabel: "8h", summary: false }],
  [{ type: "TOKENS_LIMIT" }, { id: "token", label: "Token", shortLabel: "", summary: false }],
  [{ type: "MCP_LIMIT" }, { id: "mcp", label: "MCP", shortLabel: "mcp", summary: false }],
  [{ type: "TIME_LIMIT" }, { id: "mcp", label: "MCP", shortLabel: "mcp", summary: false }],
  // Unseen shapes: deterministic type+unit+number ids, verbatim label.
  [
    { type: "CREDIT_LIMIT", unit: 4, number: 2 },
    { id: "credit_limit_u4_n2", label: "CREDIT_LIMIT", shortLabel: "", summary: false },
  ],
  [
    { type: "CREDIT_LIMIT", unit: 3, number: 8 },
    { id: "credit_limit_u3_n8", label: "CREDIT_LIMIT", shortLabel: "", summary: false },
  ],
  [
    { type: "SOMETHING_NEW", unit: 9, number: 4 },
    { id: "something_new_u9_n4", label: "SOMETHING_NEW", shortLabel: "", summary: false },
  ],
  // Partial fallback: only one of unit/number present still disambiguates.
  [{ type: "CREDIT_LIMIT", unit: 4 }, { id: "credit_limit_u4", label: "CREDIT_LIMIT", shortLabel: "", summary: false }],
  [{ type: "CREDIT_LIMIT", number: 2 }, { id: "credit_limit_n2", label: "CREDIT_LIMIT", shortLabel: "", summary: false }],
  // A type with no unit/number keeps the legacy type-only id.
  [{ type: "OTHER_LIMIT" }, { id: "other_limit", label: "OTHER_LIMIT", shortLabel: "", summary: false }],
];
for (const [limit, expected] of expectations) check(`describe(${JSON.stringify(limit)})`, describe(limit), expected);

// Distinct windows in one payload never share an id, and re-parsing the same
// shapes yields the same ids (determinism).
const shapes = [
  { type: "CREDIT_LIMIT", unit: 3, number: 5 },
  { type: "CREDIT_LIMIT", unit: 6, number: 1 },
  { type: "CREDIT_LIMIT", unit: 4, number: 2 },
  { type: "CREDIT_LIMIT", unit: 3, number: 8 },
];
const ids = shapes.map((s) => describe(s).id);
if (new Set(ids).size !== ids.length) {
  console.error("FAIL: window ids collide:", ids.join(", "));
  failures++;
}
check("determinism", shapes.map((s) => describe(s).id), ids);

// --- End-to-end: discover → fetch against a stubbed quota endpoint -------
const realFetch = globalThis.fetch;
try {
  const payload = {
    success: true,
    data: {
      level: "Pro",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1000, remaining: 730, nextResetTime: 1792863679566 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, currentValue: 27, percentage: 27, nextResetTime: 1793248996981 },
        { type: "MCP_LIMIT", usage: 100, remaining: 50, nextResetTime: 1792863679566 },
      ],
    },
  };
  let requested;
  globalThis.fetch = async (url, init) => {
    requested = { url, auth: init?.headers?.Authorization };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };

  const reg = usageMod.zcodeUsageRegistration();
  check("registration id/label", [reg.id, reg.label], ["zcode", "ZCode"]);

  const accounts = await reg.discover({ kind: "global" });
  // With an official-host provider present, it is selected over the
  // official-host-less fallback candidate.
  check("discover", accounts.map((a) => a.label), ["glm"]);

  const report = await reg.fetch(accounts[0].input);
  check("report status", report.status, "available");
  check("plan label", report.planLabel, "Pro");
  check(
    "windows",
    report.windows.map((w) => [w.id, w.label, w.summary, w.usedPct, w.resetsAt]),
    [
      ["token_5h", "5-hour", true, 27, new Date(1792863679566).toISOString()],
      ["token_week", "Weekly", true, 27, new Date(1793248996981).toISOString()],
      // windowFromUsedPct omits falsy optional fields, so the MCP window's
      // summary:false is absent (undefined) on the produced window.
      ["mcp", "MCP", undefined, 50, new Date(1792863679566).toISOString()],
    ],
  );
  check("request url", requested.url, "https://api.z.ai/api/monitor/usage/quota/limit");
  check("auth header", requested.auth, "Bearer fake-key");

  // Two CREDIT_LIMIT windows with different unit/number must both appear —
  // the regression this fix exists for.
  const windowIds = report.windows.map((w) => w.id);
  if (new Set(windowIds).size !== windowIds.length) {
    console.error("FAIL: report windows collide:", windowIds.join(", "));
    failures++;
  }
} finally {
  globalThis.fetch = realFetch;
  if (savedProviderPin === undefined) delete process.env.ZCODE_PROVIDER;
  else process.env.ZCODE_PROVIDER = savedProviderPin;
  if (savedHome === undefined) delete process.env.ZCODE_HOME;
  else process.env.ZCODE_HOME = savedHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`usage tests: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log(`usage tests: ok (${expectations.length} parser shapes, ids ${ids.join(", ")}, end-to-end report)`);
}
