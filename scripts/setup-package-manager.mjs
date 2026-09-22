#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function packageManagerSpec(directory) {
  const root = resolve(directory);
  const manifestPath = join(root, "package.json");
  let declared = "";
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    declared = typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : "";
  }

  if (existsSync(join(root, "pnpm-lock.yaml"))) {
    return declared.startsWith("pnpm@") ? declared.split("+")[0] : "pnpm@9.15.9";
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return declared.startsWith("yarn@") ? declared.split("+")[0] : "yarn@1.22.22";
  }
  return null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed with exit code ${String(result.status)}`);
  }
}

function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error("repository directory is required");
  const spec = packageManagerSpec(directory);
  if (spec === null) return;
  const installSpec = npmInstallSpec(spec);
  const installRoot = join(process.env.RUNNER_TEMP || tmpdir(), "safe-upgrade-package-manager");
  mkdirSync(installRoot, { recursive: true });
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    installSpec,
  ]);
  const bin = join(installRoot, "node_modules", ".bin");
  const githubPath = process.env.GITHUB_PATH;
  if (!githubPath) throw new Error("GITHUB_PATH is required to expose the package manager");
  appendFileSync(githubPath, `${bin}\n`);
}

export function npmInstallSpec(spec) {
  if (!spec.startsWith("yarn@")) return spec;
  const version = spec.slice("yarn@".length);
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) && major >= 2 ? `@yarnpkg/cli-dist@${version}` : spec;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`safe-upgrade-action: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
