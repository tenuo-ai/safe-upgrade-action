import test from "node:test";
import assert from "node:assert/strict";
import {
  annotationsFor,
  classifyEvent,
  parseDependabotPullRequest,
  parseRenovatePullRequest,
  renderSummary,
} from "../scripts/run.mjs";

test("parses a conventional Renovate dependency title", () => {
  assert.deepEqual(
    parseRenovatePullRequest("chore(deps): update dependency postcss to v8.4.35"),
    { packageName: "postcss", targetVersion: "8.4.35" },
  );
});

test("parses a scoped Renovate dependency", () => {
  assert.deepEqual(
    parseRenovatePullRequest("fix(deps): update dependency @scope/tool to 2.1.0"),
    { packageName: "@scope/tool", targetVersion: "2.1.0" },
  );
});

test("refuses ambiguous Renovate groups", () => {
  assert.equal(parseRenovatePullRequest("chore(deps): update all dependencies"), null);
});

test("parses a single-package Dependabot pull request", () => {
  assert.deepEqual(
    classifyEvent(
      {
        pull_request: {
          number: 42,
          title: "Bump postcss from 7.0.39 to 8.4.35",
          user: { login: "dependabot[bot]" },
        },
      },
      "",
      "",
    ),
    {
      kind: "dependabot",
      packageName: "postcss",
      targetVersion: "8.4.35",
      companions: [],
      workspace: "",
      pullNumber: 42,
    },
  );
});

test("parses a Dependabot workspace and grouped companions", () => {
  assert.deepEqual(
    parseDependabotPullRequest(
      "Bump postcss from 7.0.39 to 8.4.35 in /packages/app",
      "Updates `postcss` from 7.0.39 to 8.4.35\nUpdates `nanoid` from 3.3.7 to 5.0.0",
    ),
    {
      packageName: "postcss",
      targetVersion: "8.4.35",
      companions: [{ packageName: "nanoid", targetVersion: "5.0.0" }],
      workspace: "packages/app",
    },
  );
});

test("explicit inputs work for any pull request actor", () => {
  assert.deepEqual(
    classifyEvent(
      { pull_request: { number: 9, user: { login: "release-bot" } } },
      "postcss",
      "8.4.35",
    ),
    { kind: "explicit", packageName: "postcss", targetVersion: "8.4.35", pullNumber: 9 },
  );
});

test("requires package and version together", () => {
  assert.throws(() => classifyEvent({}, "postcss", ""), /provided together/);
});

test("escapes multiline report content in the job summary", () => {
  const report = fixtureReport();
  report.result.reasons = ["review this\n## injected heading"];
  const summary = renderSummary(report);
  assert.doesNotMatch(summary, /\n## injected heading/);
  assert.ok(summary.includes("review this \\#\\# injected heading"));
});

test("renders findings and verification into the job summary", () => {
  const report = fixtureReport();
  const summary = renderSummary(report, { authorizationMode: "development" });
  assert.match(summary, /safe-upgrade: blocked/);
  assert.match(summary, /postcss/);
  assert.match(summary, /src\/prefix\.js/);
  assert.match(summary, /self-authorized trial mode/);
  assert.match(summary, /\| final \| test \| failed \|/);
});

test("annotates affected files and marks unverified findings as warnings", () => {
  assert.deepEqual(annotationsFor(fixtureReport()), [
    {
      level: "warning",
      file: "src/prefix.js",
      message: "api-removed: prefix() was removed",
    },
  ]);
});

function fixtureReport() {
  return {
    request: { packageName: "postcss", targetVersion: "8.4.35" },
    facts: { currentVersion: "7.0.39" },
    result: { status: "blocked", reasons: ["a used export was removed"] },
    finalState: {
      verifiedFindingIds: [],
      findings: [
        {
          id: "api-removed",
          releaseClaim: "prefix() was removed",
          affectedFiles: ["src/prefix.js"],
        },
      ],
      baselineChecks: [],
      postChangeChecks: [
        { phase: "final", command: { purpose: "test" }, outcome: "failed" },
      ],
    },
  };
}
