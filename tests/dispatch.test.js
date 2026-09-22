import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDispatch, mergeFlags, mergeScriptEntries } from "../src/dispatch.js";
import { parseSgmodule } from "../src/sgmodule-parse.js";

async function upstream() {
  const [a, b] = await Promise.all([
    readFile(new URL("../.scratch/upstream/ADBlock_v0.6.27.sgmodule", import.meta.url), "utf8"),
    readFile(new URL("../.scratch/upstream/Global_v0.8.25.sgmodule", import.meta.url), "utf8"),
  ]);
  return [parseSgmodule(a), parseSgmodule(b)];
}

test("finds the current upstream overlap matrix", async () => {
  const [a, b] = await upstream();
  const dispatch = buildDispatch(a.scripts, b.scripts);
  assert.deepEqual(dispatch["http-request"].both, []);
  assert.equal(dispatch["http-request"].uncertain.length, 0);
  assert.deepEqual(dispatch["http-response"].both, [
    "^https?:\\/\\/(grpc|app)\\.bili(bili\\.com|api\\.net)\\/bilibili\\.app\\.viewunite\\.v1\\.View\\/View$",
  ]);
  assert.equal(dispatch["http-response"].uncertain.length, 0);
});

test("conservatively marks unsupported regex relationships as both", () => {
  const scriptsA = [{ type: "http-response", pattern: "^https://a\\.test/(?=x)x", flags: {} }];
  const scriptsB = [{ type: "http-response", pattern: "^https://a\\.test/x", flags: {} }];
  const dispatch = buildDispatch(scriptsA, scriptsB)["http-response"];
  assert.equal(dispatch.uncertain.length, 1);
  assert.ok(dispatch.both.includes(scriptsA[0].pattern));
  assert.ok(dispatch.both.includes(scriptsB[0].pattern));
});

test("merges exact script entries and takes the largest max-size", () => {
  const base = {
    name: "a",
    type: "http-response",
    pattern: "^https://a.test",
    scriptPath: "https://a",
    argumentKeys: [],
  };
  const merged = mergeScriptEntries(
    [{ ...base, flags: { "requires-body": "1", "max-size": "65536" } }],
    [{ ...base, name: "b", flags: { engine: "webview", "max-size": "262144" } }],
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ["A", "B"]);
  assert.deepEqual(merged[0].flags, {
    "requires-body": "1",
    "max-size": "262144",
    engine: "webview",
  });
  assert.deepEqual(mergeFlags({ ability: "http-client-policy" }, { "binary-body-mode": "1" }), {
    ability: "http-client-policy",
    "binary-body-mode": "1",
  });
});
