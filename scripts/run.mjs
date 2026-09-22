#!/usr/bin/env node

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BUMP_TITLE =
  /(?:^|\b)bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+?)(?:\s+in\s+(\S+))?$/i;
const GROUPED_UPDATE = /^updates\s+`([^`]+)`\s+from\s+(\S+)\s+to\s+(\S+)/gim;

export function parseRenovatePullRequest(title) {
  const normalized = title.trim();
  const patterns = [
    /(?:^|:\s*)update dependency\s+(`?)(@?[a-z0-9][a-z0-9._/-]*)\1\s+to\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/i,
    /(?:^|:\s*)update\s+(`?)(@?[a-z0-9][a-z0-9._/-]*)\1\s+to\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const packageName = match?.[2] ?? "";
    const targetVersion = match?.[3] ?? "";
    if (PACKAGE_NAME.test(packageName) && EXACT_VERSION.test(targetVersion)) {
      return { packageName, targetVersion };
    }
  }
  return null;
}

export function parseDependabotPullRequest(title, body = "") {
  const match = BUMP_TITLE.exec(title.trim());
  const grouped = [];
  const seen = new Set();
  for (const update of body.matchAll(GROUPED_UPDATE)) {
    const packageName = update[1] ?? "";
    const targetVersion = update[3] ?? "";
    if (
      PACKAGE_NAME.test(packageName) &&
      EXACT_VERSION.test(targetVersion) &&
      !seen.has(packageName)
    ) {
      grouped.push({ packageName, targetVersion });
      seen.add(packageName);
    }
  }
  if (match !== null) {
    const packageName = match[1] ?? "";
    const targetVersion = match[3] ?? "";
    if (!PACKAGE_NAME.test(packageName) || !EXACT_VERSION.test(targetVersion)) return null;
    return {
      packageName,
      targetVersion,
      companions: grouped.filter((entry) => entry.packageName !== packageName).slice(0, 8),
      workspace: normalizeWorkspace(match[4] ?? ""),
    };
  }
  const [primary, ...companions] = grouped;
  if (primary === undefined) return null;
  return {
    ...primary,
    companions: companions.slice(0, 8),
    workspace: normalizeWorkspace(/(?:\s+in\s+)(\S+)\s*$/i.exec(title)?.[1] ?? ""),
  };
}

export function classifyEvent(event, explicitPackage, explicitVersion) {
  const pull = asRecord(event.pull_request);
  const pullNumber = Number.isInteger(pull.number) ? pull.number : null;
  const actor = String(asRecord(pull.user).login ?? asRecord(event.sender).login ?? "");
  const title = String(pull.title ?? "");
  const body = String(pull.body ?? "");

  if ((explicitPackage === "") !== (explicitVersion === "")) {
    throw new Error("package and version must be provided together");
  }
  if (explicitPackage !== "") {
    if (!PACKAGE_NAME.test(explicitPackage) || !EXACT_VERSION.test(explicitVersion)) {
      throw new Error("package and version must name a package and an exact semantic version");
    }
    return { kind: "explicit", packageName: explicitPackage, targetVersion: explicitVersion, pullNumber };
  }
  if (actor === "dependabot[bot]" || actor === "dependabot-preview[bot]") {
    const parsed = parseDependabotPullRequest(title, body);
    if (parsed === null) {
      throw new Error(
        "this Dependabot pull request does not identify an exact upgrade; set the package and version inputs",
      );
    }
    return { kind: "dependabot", ...parsed, pullNumber };
  }
  if (actor === "renovate[bot]" || actor === "renovate-bot") {
    const parsed = parseRenovatePullRequest(title);
    if (parsed === null) {
      throw new Error(
        "this Renovate title does not name one package and an exact target version; set the package and version inputs",
      );
    }
    return { kind: "renovate", ...parsed, pullNumber };
  }
  throw new Error(
    "safe-upgrade could not infer an upgrade from this event; set the package and version inputs",
  );
}

export function renderSummary(report, options = {}) {
  const status = String(report?.result?.status ?? "indeterminate");
  const request = asRecord(report?.request);
  const facts = asRecord(report?.facts);
  const result = asRecord(report?.result);
  const finalState = asRecord(report?.finalState);
  const reasons = stringArray(result.reasons);
  const findings = array(finalState.findings);
  const verified = new Set(stringArray(finalState.verifiedFindingIds));
  const checks = [...array(finalState.baselineChecks), ...array(finalState.postChangeChecks)];
  const changes = array(finalState.fileChanges);
  const grantedApprovalIds = new Set(array(report?.approvals).map((approval) => String(asRecord(approval).id ?? "")));
  const approvals = array(finalState.elevationRequests).filter(
    (approval) => !grantedApprovalIds.has(String(asRecord(approval).id ?? "")),
  );
  const unverified = stringArray(result.unverifiedClaims);
  const packageName = String(request.packageName ?? options.packageName ?? "dependency");
  const currentVersion = String(facts.currentVersion ?? "unknown");
  const targetVersion = String(request.targetVersion ?? options.targetVersion ?? "unknown");
  const lines = [
    `## safe-upgrade: ${status}`,
    "",
    `\`${packageName}\` ${currentVersion} → ${targetVersion}`,
    "",
    maintainerDecision(status),
    "",
  ];

  if (options.authorizationMode === "development") {
    lines.push(
      "> This run used safe-upgrade's self-authorized trial mode. Production OIDC warrant exchange is not enabled in this release.",
      "",
    );
  }
  if (reasons.length > 0) {
    lines.push("### Decision evidence", "", ...reasons.map((reason) => `- ${escapeMarkdown(reason)}`), "");
  }
  if (findings.length > 0) {
    lines.push("### Repository impact", "");
    for (const rawFinding of findings) {
      const finding = asRecord(rawFinding);
      const id = String(finding.id ?? "finding");
      const claim = String(finding.releaseClaim ?? "Finding recorded");
      const marker = verified.has(id) ? "verified" : "unverified";
      lines.push(`- **${escapeMarkdown(claim)}** (${marker})`);
      const files = stringArray(finding.affectedFiles);
      if (files.length > 0) {
        lines.push(`  - Affected code: ${files.map((file) => `\`${escapeCode(file)}\``).join(", ")}`);
      } else {
        lines.push("  - Affected code: no repository call site identified");
      }
      const requiredChange = String(finding.requiredChange ?? "");
      if (requiredChange) lines.push(`  - Required work: ${escapeMarkdown(requiredChange)}`);
    }
    lines.push("");
  }
  if (checks.length > 0) {
    lines.push("### Verification", "", "| Phase | Check | Result |", "| --- | --- | --- |");
    for (const rawCheck of checks) {
      const check = asRecord(rawCheck);
      const command = asRecord(check.command);
      lines.push(
        `| ${escapeTable(String(check.phase ?? "unknown"))} | ${escapeTable(String(command.purpose ?? "check"))} | ${escapeTable(String(check.outcome ?? "unknown"))} |`,
      );
    }
    lines.push("");
  }
  if (changes.length > 0) {
    lines.push("### Candidate changes", "");
    for (const rawChange of changes) {
      const change = asRecord(rawChange);
      lines.push(
        `- \`${escapeCode(String(change.path ?? "unknown"))}\` by ${escapeMarkdown(String(change.owner ?? "worker"))}: ${escapeMarkdown(String(change.reason ?? "change recorded"))}`,
      );
    }
    lines.push("");
  }
  const authority = delegatedAuthority(report);
  if (authority.length > 0) {
    lines.push("### Delegated authority exercised", "", ...authority.map((item) => `- ${escapeMarkdown(item)}`), "");
  }
  if (status === "human_required" && approvals.length > 0) {
    lines.push("### Maintainer action", "");
    for (const rawApproval of approvals) {
      const approval = asRecord(rawApproval);
      const id = String(approval.id ?? "");
      lines.push(
        `- ${escapeMarkdown(String(approval.worker ?? "worker"))} requests \`${escapeCode(String(approval.capability ?? "capability"))}\`: ${escapeMarkdown(String(approval.reason ?? "approval required"))}`,
        `  - Approval id: \`${escapeCode(id)}\``,
        `  - Re-run with \`--approve ${escapeCode(id)} --approved-by <who>\``,
      );
    }
    lines.push("");
  } else if (unverified.length > 0) {
    lines.push("### Still unverified", "", ...unverified.map((claim) => `- ${escapeMarkdown(claim)}`), "");
  }
  lines.push("The complete evidence record is attached to this workflow run.", "");
  return lines.join("\n");
}

function maintainerDecision(status) {
  const decisions = {
    verified: "The upgrade is supported by repository evidence and its required checks passed. Review the dependency diff normally.",
    partial: "Hold the merge until the remaining gaps below are resolved.",
    human_required: "A scoped operation needs maintainer approval before the assessment can finish.",
    blocked: "Hold the merge. The assessment reached a condition it could not resolve safely.",
    indeterminate: "Hold the merge. The available evidence was insufficient to classify this upgrade.",
  };
  return decisions[status] ?? decisions.indeterminate;
}

function delegatedAuthority(report) {
  const byWorker = new Map();
  for (const rawEvent of array(report?.events)) {
    const event = asRecord(rawEvent);
    if (event.type !== "session_delegated") continue;
    const worker = String(event.worker ?? "worker");
    const held = byWorker.get(worker) ?? new Set();
    for (const capability of stringArray(asRecord(event.payload).capabilities)) held.add(capability);
    byWorker.set(worker, held);
  }
  return [...byWorker.entries()].map(([worker, capabilities]) =>
    `${worker}: ${capabilities.size > 0 ? [...capabilities].join(", ") : "no protected tools"}`,
  );
}

export function annotationsFor(report) {
  const finalState = asRecord(report?.finalState);
  const verified = new Set(stringArray(finalState.verifiedFindingIds));
  const annotations = [];
  for (const rawFinding of array(finalState.findings)) {
    const finding = asRecord(rawFinding);
    const id = String(finding.id ?? "finding");
    const claim = String(finding.releaseClaim ?? "Finding recorded");
    const level = verified.has(id) ? "notice" : "warning";
    for (const file of stringArray(finding.affectedFiles).slice(0, 10)) {
      annotations.push({ level, file, message: `${id}: ${claim}` });
    }
  }
  return annotations;
}

async function main() {
  const input = (name, fallback = "") => process.env[name]?.trim() || fallback;
  const workingDirectory = resolve(input("SAFE_UPGRADE_INPUT_WORKING_DIRECTORY", process.cwd()));
  const cliVersion = input("SAFE_UPGRADE_INPUT_CLI_VERSION", "0.1.2");
  if (!EXACT_VERSION.test(cliVersion)) {
    return failBeforeRun("safe-upgrade-version must be an exact semantic version");
  }
  const authorizationMode = input("SAFE_UPGRADE_INPUT_AUTHORIZATION_MODE", "development");
  if (authorizationMode !== "development" && authorizationMode !== "production") {
    return failBeforeRun("authorization-mode must be development or production");
  }

  let event = {};
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    try {
      event = JSON.parse(readFileSync(eventPath, "utf8"));
    } catch (error) {
      return failBeforeRun(`could not read the GitHub event: ${messageOf(error)}`);
    }
  }

  let target;
  try {
    target = classifyEvent(
      event,
      input("SAFE_UPGRADE_INPUT_PACKAGE"),
      input("SAFE_UPGRADE_INPUT_VERSION"),
    );
  } catch (error) {
    return failBeforeRun(messageOf(error));
  }

  const artifactRoot = join(
    process.env.RUNNER_TEMP || tmpdir(),
    "safe-upgrade",
    `${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`,
  );
  mkdirSync(artifactRoot, { recursive: true });

  let repositoryCopy;
  try {
    repositoryCopy = await copyCommittedRepository(workingDirectory);
  } catch (error) {
    return failBeforeRun(`could not prepare the repository: ${messageOf(error)}`);
  }

  const args = [
    "exec",
    "--yes",
    `--package=@tenuo/safe-upgrade@${cliVersion}`,
    "--",
    "safe-upgrade",
  ];
  args.push(`${target.packageName}@${target.targetVersion}`);
  for (const companion of target.companions ?? []) {
    args.push("--companion", `${companion.packageName}@${companion.targetVersion}`);
  }
  if (target.pullNumber !== null && truthy(input("SAFE_UPGRADE_INPUT_COMMENT", "true"))) {
    args.push("--comment-pr", String(target.pullNumber));
  }
  args.push("--repository", repositoryCopy.path, "--artifacts", artifactRoot, "--format", "json", "--quiet");

  const workspace = input("SAFE_UPGRADE_INPUT_WORKSPACE") || target.workspace || "";
  const engine = input("SAFE_UPGRADE_INPUT_ENGINE", "deterministic");
  const patchModel = input("SAFE_UPGRADE_INPUT_PATCH_MODEL");
  const confidence = input("SAFE_UPGRADE_INPUT_CONFIDENCE");
  if (workspace) args.push("--workspace", workspace);
  args.push("--engine", engine);
  if (patchModel) args.push("--patch-model", patchModel);
  if (confidence) args.push("--confidence", confidence);
  if (truthy(input("SAFE_UPGRADE_INPUT_ALLOW_TRANSITIVE", "false"))) args.push("--allow-transitive");
  if (truthy(input("SAFE_UPGRADE_INPUT_PARTIAL_ALLOWED", "false"))) args.push("--partial-allowed");

  const env = { ...process.env };
  if (authorizationMode === "development") env.NODE_ENV = "development";
  else delete env.NODE_ENV;

  let run;
  try {
    run = await execute("npm", args, { cwd: repositoryCopy.path, env });
  } finally {
    repositoryCopy.release();
  }
  if (run.stderr) process.stderr.write(run.stderr);
  const stdoutPath = join(artifactRoot, "action-stdout.json");
  writeFileSync(stdoutPath, run.stdout, "utf8");

  let report = null;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    const reportPath = join(artifactRoot, "report.json");
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      report = null;
    }
  }

  if (report === null) {
    writeSummary(
      `## safe-upgrade could not complete\n\nThe CLI exited with code ${run.code}. Open the uploaded evidence record and workflow log for details.\n`,
    );
    annotate("error", "safe-upgrade did not produce a structured report");
    setOutputs({ status: "", exitCode: run.code, reportPath: "", artifactPath: artifactRoot });
    return;
  }

  const status = String(report.result?.status ?? "");
  const reportPath = join(artifactRoot, "report.json");
  writeSummary(renderSummary(report, { authorizationMode }));
  for (const annotation of annotationsFor(report)) {
    annotate(annotation.level, annotation.message, annotation.file);
  }
  setOutputs({ status, exitCode: run.code, reportPath, artifactPath: artifactRoot });
}

function failBeforeRun(message) {
  writeSummary(`## safe-upgrade could not start\n\n${escapeMarkdown(message)}\n`);
  annotate("error", message);
  setOutputs({ status: "", exitCode: 64, reportPath: "", artifactPath: "" });
}

function setOutputs({ status, exitCode, reportPath, artifactPath }) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    `status=${status}\nexit-code=${String(exitCode)}\nreport-path=${reportPath}\nartifact-path=${artifactPath}\n`,
  );
}

function writeSummary(markdown) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${markdown.trimEnd()}\n`);
  else process.stdout.write(`${markdown.trimEnd()}\n`);
}

function annotate(level, message, file = "") {
  const metadata = file ? ` file=${escapeCommandProperty(file)}` : "";
  process.stdout.write(`::${level}${metadata}::${escapeCommandData(message)}\n`);
}

function escapeCommandData(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeCommandProperty(value) {
  return escapeCommandData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function execute(command, args, options) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      stderr += `${messageOf(error)}\n`;
      resolvePromise({ code: 70, stdout, stderr });
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 70, stdout, stderr }));
  });
}

async function copyCommittedRepository(source) {
  const parent = mkdtempSync(join(tmpdir(), "safe-upgrade-action-source-"));
  const destination = join(parent, "repository");
  const sourceHead = await execute("git", ["rev-parse", "HEAD"], { cwd: source, env: process.env });
  if (sourceHead.code !== 0 || !/^[0-9a-f]{40}\n?$/.test(sourceHead.stdout)) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error("the working directory must be a Git repository with a commit");
  }
  const cloned = await execute(
    "git",
    ["clone", "--quiet", "--no-local", "--no-hardlinks", "--no-checkout", source, destination],
    { cwd: tmpdir(), env: process.env },
  );
  if (cloned.code !== 0) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(cloned.stderr.trim() || "git clone failed");
  }
  const checkedOut = await execute("git", ["checkout", "--quiet", "--detach", sourceHead.stdout.trim()], {
    cwd: destination,
    env: process.env,
  });
  if (checkedOut.code !== 0) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(checkedOut.stderr.trim() || "git checkout failed");
  }
  return {
    path: destination,
    release() {
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

function truthy(value) {
  return value.toLowerCase() === "true";
}

function normalizeWorkspace(value) {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutDot = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  const withoutSlash = withoutDot.startsWith("/") ? withoutDot.slice(1) : withoutDot;
  if (
    withoutSlash === "" ||
    withoutSlash.split("/").includes("..") ||
    !/^[A-Za-z0-9._@-][A-Za-z0-9._/@-]*$/.test(withoutSlash)
  ) {
    return "";
  }
  return withoutSlash.replace(/\/+$/, "");
}

function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function stringArray(value) {
  return array(value).filter((item) => typeof item === "string");
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}#+.!|])/g, "\\$1");
}

function escapeCode(value) {
  return String(value).replace(/[\r\n]+/g, " ").replaceAll("`", "\\`");
}

function escapeTable(value) {
  return escapeMarkdown(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
