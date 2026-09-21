const assert = require("node:assert/strict");
const test = require("node:test");
const colors = require("picocolors");

test("exposes the color helpers used by this project", () => {
  assert.equal(typeof colors.red, "function");
  assert.equal(typeof colors.bold, "function");
});
