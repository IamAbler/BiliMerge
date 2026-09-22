import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import worker, { fetchUpstreamText, UPSTREAM } from "../src/worker.js";
import { parseSgmodule } from "../src/sgmodule-parse.js";

async function upstreamFixtures() {
  const [aText, bText] = await Promise.all([
    readFile(new URL("../.scratch/upstream/ADBlock_v0.6.27.sgmodule", import.meta.url), "utf8"),
    readFile(new URL("../.scratch/upstream/Global_v0.8.25.sgmodule", import.meta.url), "utf8"),
  ]);
  return { aText, bText, a: parseSgmodule(aText), b: parseSgmodule(bText) };
}

function mockFetch(fixtures, fail = false) {
  return async (input) => {
    const url = String(input);
    if (fail) return new Response("down", { status: 503 });
    if (url === UPSTREAM.adblock) return new Response(fixtures.aText);
    if (url === UPSTREAM.global) return new Response(fixtures.bText);
    if (url.endsWith("request.bundle.js")) return new Response('$done({ url: $request.url, headers: { merged: "1" } });');
    if (url.endsWith("response.bundle.js")) return new Response('$done({ ...$response, headers: { merged: "1" } });');
    return new Response("missing", { status: 404 });
  };
}

test("serves dynamic merged scripts and modules", async () => {
  const fixtures = await upstreamFixtures();
  const env = { UPSTREAM_FETCH: mockFetch(fixtures) };
  const scriptResponse = await worker.fetch(new Request("https://bilimerge.test/merged-response.js"), env);
  assert.equal(scriptResponse.status, 200);
  assert.equal(scriptResponse.headers.get("X-BiliMerge-ADBlock"), "0.6.27");
  assert.equal(scriptResponse.headers.get("X-BiliMerge-Global"), "0.8.25");
  assert.equal(scriptResponse.headers.get("X-BiliMerge-Type"), "response");
  assert.equal(scriptResponse.headers.get("Cache-Control"), "no-store");
  const scriptText = await scriptResponse.text();
  assert.doesNotThrow(() => new vm.Script(scriptText));

  const moduleResponse = await worker.fetch(new Request("https://bilimerge.test/bilimerge.sgmodule"), env);
  assert.equal(moduleResponse.status, 200);
  const parsed = parseSgmodule(await moduleResponse.text());
  const legacyModuleResponse = await worker.fetch(new Request("https://bilimerge.test/bili-adblock.sgmodule"), env);
  assert.equal(legacyModuleResponse.status, 200);
  assert.equal(parsed.scripts.length, 33);
  assert.ok(parsed.scripts.every(({ scriptPath }) => scriptPath.startsWith("https://bilimerge.test/")));
});

test("fails open when an upstream source bypasses lexical $done", async () => {
  const fixtures = await upstreamFixtures();
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url === UPSTREAM.adblock) return new Response(fixtures.aText);
    if (url === UPSTREAM.global) return new Response(fixtures.bText);
    if (url.endsWith("request.bundle.js")) return new Response("globalThis.$done({});");
    if (url.endsWith("response.bundle.js")) return new Response("$done({});");
    return new Response("missing", { status: 404 });
  };
  const response = await worker.fetch(new Request("https://bilimerge.test/merged-request.js"), { UPSTREAM_FETCH: fetchImpl });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("X-BiliMerge-Error"), /global \$done/);
  const scriptText = await response.text();
  assert.doesNotThrow(() => new vm.Script(scriptText));
});

test("returns executable fail-open script when upstream fails", async () => {
  const fixtures = await upstreamFixtures();
  const env = { UPSTREAM_FETCH: mockFetch(fixtures, true) };
  const response = await worker.fetch(new Request("https://bilimerge.test/merged-request.js"), env);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("X-BiliMerge-Error"));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const scriptText = await response.text();
  assert.doesNotThrow(() => new vm.Script(scriptText));

  const moduleResponse = await worker.fetch(new Request("https://bilimerge.test/bili-adblock.sgmodule"), env);
  assert.equal(moduleResponse.status, 502);
});

test("uses fresh cache and stale data after refresh failure", async () => {
  const store = new Map();
  const cache = {
    async match(request) { return store.get(request.url)?.clone(); },
    async put(request, response) { store.set(request.url, response.clone()); },
  };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("payload"); };
  const first = await fetchUpstreamText("https://example.test/file", { cache, fetchImpl, now: 0 });
  assert.equal(first.cache, "miss");
  const second = await fetchUpstreamText("https://example.test/file", { cache, fetchImpl, now: 100_000 });
  assert.equal(second.cache, "hit");
  assert.equal(calls, 1);
  const stale = await fetchUpstreamText("https://example.test/file", {
    cache,
    fetchImpl: async () => { throw new Error("offline"); },
    now: 700_000,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.text, "payload");
});
