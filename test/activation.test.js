import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/index.js";

// Regression: the default row (empty prompts) must pass the Config schema, or
// Cordis refuses to activate the plugin ("decisionPrompt expected length >= 1").
test("Config accepts the default (empty) row", () => {
	const cfg = Config({});
	assert.equal(cfg.decisionPrompt, "");
	assert.equal(cfg.continuePrompt, "");
});
