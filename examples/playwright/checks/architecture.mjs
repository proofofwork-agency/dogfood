import assert from "node:assert/strict";

assert.equal(typeof globalThis.fetch, "function", "Node runtime must expose fetch");
console.log("neutral architecture check passed");
