import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageManagerSpec } from "../scripts/setup-package-manager.mjs";

test("uses the pnpm version declared by the repository", () => {
  const root = fixture({ packageManager: "pnpm@9.15.9" }, "pnpm-lock.yaml");
  assert.equal(packageManagerSpec(root), "pnpm@9.15.9");
});

test("uses a compatible pnpm default when the repository omits packageManager", () => {
  const root = fixture({}, "pnpm-lock.yaml");
  assert.equal(packageManagerSpec(root), "pnpm@9.15.9");
});

test("leaves npm repositories to setup-node", () => {
  const root = fixture({}, "package-lock.json");
  assert.equal(packageManagerSpec(root), null);
});

function fixture(manifest, lockfile) {
  const root = mkdtempSync(join(tmpdir(), "safe-upgrade-package-manager-"));
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, lockfile), "");
  return root;
}
