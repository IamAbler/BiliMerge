import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSgmodule } from "../src/sgmodule-parse.js";
import { generateSgmodule } from "../src/sgmodule-gen.js";

async function modules() {
  const [a, b] = await Promise.all([
    readFile(new URL("../.scratch/upstream/ADBlock_v0.6.27.sgmodule", import.meta.url), "utf8"),
    readFile(new URL("../.scratch/upstream/Global_v0.8.25.sgmodule", import.meta.url), "utf8"),
  ]);
  return { adblock: parseSgmodule(a), global: parseSgmodule(b) };
}

test("generates a complete overlap-safe merged module", async () => {
  const source = await modules();
  const text = generateSgmodule({ ...source, host: "bilimerge.example.workers.dev" });
  const parsed = parseSgmodule(text);
  assert.equal(parsed.version, "0.6.27+0.8.25");
  assert.equal(parsed.arguments.length, 39);
  assert.equal(parsed.arguments[0].key, "ADBlock.Splash");
  assert.equal(parsed.arguments[31].key, "Global.ForceHost");
  assert.equal(parsed.arguments[32].default, "CHN,HKG,TWN");
  assert.equal(parsed.mapLocal.length, 10);
  assert.equal(parsed.bodyRewrite.length, 1);
  assert.equal(parsed.scripts.length, 33);
  assert.equal(new Set(parsed.scripts.map(({ name }) => name)).size, 33);
  assert.ok(parsed.scripts.every(({ argumentKeys }) => argumentKeys.length === 39));
  assert.ok(parsed.scripts.every(({ scriptPath, type }) =>
    scriptPath === `https://bilimerge.example.workers.dev/merged-${type === "http-request" ? "request" : "response"}.js`));
  assert.equal(parsed.mitm.hostnames.length, 15);

  const overlapUrl = "https://grpc.biliapi.net/bilibili.app.viewunite.v1.View/View";
  const matchingResponseRows = parsed.scripts.filter(
    ({ type, pattern }) => type === "http-response" && new RegExp(pattern).test(overlapUrl),
  );
  assert.equal(matchingResponseRows.length, 1, "overlap URL must invoke merged script once");
  assert.match(matchingResponseRows[0].name, /^📺 BiliBili\.ADBlock\.view\.response\.grpc \(ADBlock \+ Global\)$/);
  assert.ok(parsed.scripts.some(({ name }) => name === "📺 BiliBili.Global.ep.list.json"));
  assert.ok(parsed.scripts.some(({ name }) => name === "📺 BiliBili.ADBlock.response.json [2]"));
  assert.match(parsed.argumentsDesc, /ADBlock\.Feed\.AD:/);
  assert.match(parsed.argumentsDesc, /Global\.Proxies\.CHN:/);
  assert.match(parsed.argumentsDesc, /\$argument/);
});

test("rejects malformed hosts", async () => {
  const source = await modules();
  assert.throws(() => generateSgmodule({ ...source, host: "https://bad.test/path" }), /Invalid/);
});
