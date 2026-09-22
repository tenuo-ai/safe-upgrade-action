#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
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
    return declared.startsWith("pnpm@") ? declared : "pnpm@9.15.9";
  }
  if (existsSync(join(root, "yarn.lock"))) {
    return declared.startsWith("yarn@") ? declared : "yarn@1.22.22";
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
  run("corepack", ["prepare", spec, "--activate"]);
  run("corepack", ["enable"]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`safe-upgrade-action: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
