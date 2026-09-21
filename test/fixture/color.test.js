const assert = require("node:assert/strict");
const test = require("node:test");
const color = require("./src/color.js");

test("formats errors through the dependency", () => {
  assert.equal(color.error("failed"), "failed");
});
