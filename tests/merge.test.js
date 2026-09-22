import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildDispatch } from "../src/dispatch.js";
import { generateFailOpenScript, generateMergedScript } from "../src/merge.js";

function moduleWith(type, pattern, key, version) {
  return {
    version,
    arguments: [{ key, default: "", quoted: true }],
    scripts: [{ type, pattern, flags: {}, scriptPath: "https://example/bundle.js", argumentKeys: [key] }],
  };
}

async function execute(script, globals) {
  let calls = 0;
  let payload;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const context = {
    ...globals,
    console: { log() {}, error() {} },
    setTimeout,
    clearTimeout,
    Uint8Array,
    ArrayBuffer,
    $environment: { "user-agent": "Surge iOS/3000" },
    $script: { startTime: Date.now() },
    $persistentStore: { read() { return null; }, write() { return true; } },
    $httpClient: {},
    $task: {},
    $notification: {},
    trace: [],
    $done(value) {
      calls += 1;
      payload = value;
      resolveDone();
    },
  };
  vm.runInNewContext(script, context, { timeout: 1_000 });
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("$done timeout")), 1_000))]);
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, payload, context };
}

test("routes A-only and rebuilds prefixed arguments", async () => {
  const a = moduleWith("http-response", "^https://a\\.test/", "X", "1");
  const b = moduleWith("http-response", "^https://b\\.test/", "Y", "2");
  const script = generateMergedScript({
    type: "response",
    sourceA: '(async () => { await Promise.resolve(); trace.push(globalThis.$argument); $done({ body: "A" }); })();',
    sourceB: 'trace.push("B"); $done({ body: "B" });',
    moduleA: a,
    moduleB: b,
    dispatch: buildDispatch(a.scripts, b.scripts),
  });
  assert.doesNotThrow(() => new vm.Script(script));
  const result = await execute(script, {
    $argument: 'ADBlock.X="a&b"&Global.Y="g"',
    $request: { url: "https://a.test/path" },
    $response: { body: "original" },
  });
  assert.equal(result.calls, 1);
  assert.equal(result.payload.body, "A");
  assert.deepEqual(result.context.trace, ['X="a&b"']);
});

test("chains A to B with Surge-compatible binary response handoff", async () => {
  const patternA = "^https://x\\.test/(View|Other)$";
  const patternB = "^https://x\\.test/View$";
  const a = moduleWith("http-response", patternA, "X", "1");
  const b = moduleWith("http-response", patternB, "Y", "2");
  const script = generateMergedScript({
    type: "response",
    sourceA: '$done({ status: "HTTP/1.1 200 OK", headers: { A: "1" }, body: undefined, bodyBytes: new Uint8Array([1,2,3]).buffer });',
    sourceB: 'trace.push($response.body instanceof Uint8Array, Array.from($response.body), globalThis.$argument); $done({ status: $response.status, headers: { ...$response.headers, B: "1" }, bodyBytes: new Uint8Array([...$response.body,4]).buffer });',
    moduleA: a,
    moduleB: b,
    dispatch: buildDispatch(a.scripts, b.scripts),
  });
  const result = await execute(script, {
    $argument: 'ADBlock.X="ax"&Global.Y="by"',
    $request: { url: "https://x.test/View" },
    $response: { status: "HTTP/1.1 200 OK", headers: {}, body: new Uint8Array([0]) },
  });
  assert.equal(result.calls, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.context.trace)), [true, [1, 2, 3], 'Y="by"']);
  assert.deepEqual(Array.from(new Uint8Array(result.payload.bodyBytes)), [1, 2, 3, 4]);
  assert.deepEqual({ ...result.payload.headers }, { A: "1", B: "1" });
});

test("continues the chain when one block throws", async () => {
  const pattern = "^https://x\\.test/";
  const a = moduleWith("http-request", pattern, "X", "1");
  const b = moduleWith("http-request", pattern, "Y", "2");
  const script = generateMergedScript({
    type: "request",
    sourceA: 'throw new Error("boom");',
    sourceB: '$done({ url: $request.url, headers: { ok: "1" } });',
    moduleA: a,
    moduleB: b,
    dispatch: buildDispatch(a.scripts, b.scripts),
    timeoutMs: 50,
  });
  const result = await execute(script, {
    $argument: "ADBlock.X=1&Global.Y=2",
    $request: { url: "https://x.test/path", method: "GET", headers: {} },
  });
  assert.equal(result.calls, 1);
  assert.deepEqual({ ...result.payload.headers }, { ok: "1" });
});

test("preserves an unchanged binary body during A-to-B handoff", async () => {
  const pattern = "^https://x\\.test/";
  const a = moduleWith("http-response", pattern, "X", "1");
  const b = moduleWith("http-response", pattern, "Y", "2");
  const script = generateMergedScript({
    type: "response",
    sourceA: '$done({ headers: { A: "1" } });',
    sourceB: '$done({ body: Array.from($response.body).join(","), headers: $response.headers });',
    moduleA: a,
    moduleB: b,
    dispatch: buildDispatch(a.scripts, b.scripts),
  });
  const result = await execute(script, {
    $argument: "ADBlock.X=1&Global.Y=2",
    $request: { url: "https://x.test/path" },
    $response: { headers: { Original: "1" }, bodyBytes: new Uint8Array([1, 2]).buffer },
  });
  assert.equal(result.calls, 1);
  assert.equal(result.payload.body, "1,2");
  assert.deepEqual({ ...result.payload.headers }, { A: "1" });
});

test("rejects upstream bundles that bypass lexical $done capture", () => {
  const a = moduleWith("http-request", "^https://x\\\\.test/", "X", "1");
  const b = moduleWith("http-request", "^https://y\\\\.test/", "Y", "2");
  for (const sourceA of ["globalThis.$done({});", "globalThis?.$done({});", "globalThis['$done']({});", "self?.['$done']({});"]) {
    assert.throws(() => generateMergedScript({
      type: "request",
      sourceA,
      sourceB: "",
      moduleA: a,
      moduleB: b,
      dispatch: buildDispatch(a.scripts, b.scripts),
    }), /global \$done/);
  }
});

test("fail-open script returns the native input exactly once", async () => {
  const response = { body: "untouched" };
  const script = generateFailOpenScript("bad\nupstream */ marker");
  assert.doesNotThrow(() => new vm.Script(script));
  const result = await execute(script, { $response: response, $request: { url: "https://x.test" } });
  assert.equal(result.calls, 1);
  assert.equal(result.payload, response);
});
