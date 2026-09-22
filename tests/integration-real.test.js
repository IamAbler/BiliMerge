import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDispatch } from "../src/dispatch.js";
import { generateMergedScript } from "../src/merge.js";
import { parseSgmodule } from "../src/sgmodule-parse.js";
import {
  nativeRequestFromPayload,
  nativeResponseFromPayload,
  normalize,
  runSurgeScript,
} from "./harness/surge.js";

const fixturePath = (name) => new URL(`../.scratch/upstream/${name}`, import.meta.url);

function argumentString(module) {
  return module.arguments
    .map(({ key, rawDefault, default: value, quoted }) => `${key}=${rawDefault ?? (quoted ? JSON.stringify(value) : value)}`)
    .join("&");
}

function prefixedArgumentString(a, b) {
  return [
    ...a.arguments.map(({ key, rawDefault, default: value, quoted }) => `ADBlock.${key}=${rawDefault ?? (quoted ? JSON.stringify(value) : value)}`),
    ...b.arguments.map(({ key, rawDefault, default: value, quoted }) => `Global.${key}=${rawDefault ?? (quoted ? JSON.stringify(value) : value)}`),
  ].join("&");
}

async function upstream() {
  const [aModuleText, bModuleText, aRequest, aResponse, bRequest, bResponse] = await Promise.all([
    readFile(fixturePath("ADBlock_v0.6.27.sgmodule"), "utf8"),
    readFile(fixturePath("Global_v0.8.25.sgmodule"), "utf8"),
    readFile(fixturePath("ADBlock_v0.6.27_request.bundle.js"), "utf8"),
    readFile(fixturePath("ADBlock_v0.6.27_response.bundle.js"), "utf8"),
    readFile(fixturePath("Global_v0.8.25_request.bundle.js"), "utf8"),
    readFile(fixturePath("Global_v0.8.25_response.bundle.js"), "utf8"),
  ]);
  return {
    a: parseSgmodule(aModuleText), b: parseSgmodule(bModuleText),
    aRequest, aResponse, bRequest, bResponse,
  };
}

test("real upstream fixtures preserve A-only and B-only output equivalence", async () => {
  const { a, b, aResponse, bRequest } = await upstream();
  const dispatch = buildDispatch(a.scripts, b.scripts);
  const aOnlyRequest = { url: "https://app.bilibili.com/x/v2/feed/index?idx=1", headers: {} };
  const aOnlyResponse = {
    status: "HTTP/1.1 200 OK",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: 0, data: { items: [{ card_type: "cm_v2", card_goto: "ad_web_s" }, { card_type: "video" }] } }),
  };
  const standaloneA = await runSurgeScript(aResponse, {
    request: aOnlyRequest, response: aOnlyResponse, argument: argumentString(a),
  });
  const mergedA = await runSurgeScript(generateMergedScript({
    type: "response", sourceA: aResponse, sourceB: "", moduleA: a, moduleB: b, dispatch,
  }), {
    request: aOnlyRequest, response: aOnlyResponse, argument: prefixedArgumentString(a, b),
  });
  assert.equal(standaloneA.calls, 1);
  assert.equal(mergedA.calls, 1);
  assert.deepEqual(normalize(mergedA.payload), normalize(standaloneA.payload));
  assert.equal(JSON.parse(standaloneA.payload.body).data.items.length, 1, "A fixture must actually be modified");

  const bOnlyRequest = { url: "https://search.bilibili.com/all?keyword=test", method: "GET", headers: {} };
  const standaloneB = await runSurgeScript(bRequest, { request: bOnlyRequest, argument: argumentString(b) });
  const mergedB = await runSurgeScript(generateMergedScript({
    type: "request", sourceA: "", sourceB: bRequest, moduleA: a, moduleB: b, dispatch,
  }), { request: bOnlyRequest, argument: prefixedArgumentString(a, b) });
  assert.equal(standaloneB.calls, 1);
  assert.equal(mergedB.calls, 1);
  assert.deepEqual(normalize(mergedB.payload), normalize(standaloneB.payload));
});

test("real gRPC overlap runs A then B once and matches manual chaining", async () => {
  const { a, b, aResponse, bResponse } = await upstream();
  const dispatch = buildDispatch(a.scripts, b.scripts);
  const request = {
    url: "https://grpc.biliapi.net/bilibili.app.viewunite.v1.View/View",
    headers: {},
  };
  // gRPC frame: an empty ViewReply payload with field 7 (cm) present as an empty message.
  // ADBlock removes cm, producing the valid five-byte empty frame below.
  const response = {
    status: "HTTP/1.1 200 OK",
    headers: { "Content-Type": "application/grpc" },
    body: new Uint8Array([0, 0, 0, 0, 2, 0x3a, 0]),
  };
  const aResult = await runSurgeScript(aResponse, { request, response, argument: argumentString(a) });
  assert.equal(aResult.calls, 1);
  const aBytes = new Uint8Array(aResult.payload.body);
  assert.deepEqual([...aBytes], [0, 0, 0, 0, 0], "A must materially modify gRPC fixture");
  const bResult = await runSurgeScript(bResponse, {
    request,
    response: nativeResponseFromPayload(aResult.payload, response),
    argument: argumentString(b),
  });
  const merged = await runSurgeScript(generateMergedScript({
    type: "response", sourceA: aResponse, sourceB: bResponse, moduleA: a, moduleB: b, dispatch,
  }), { request, response, argument: prefixedArgumentString(a, b) });
  assert.equal(bResult.calls, 1);
  assert.equal(merged.calls, 1);
  assert.deepEqual(normalize(merged.payload), normalize(bResult.payload));
});

test("request native handoff retains A mock responses as terminal payloads", () => {
  const original = { url: "https://x.test", method: "GET", headers: { A: "1" } };
  assert.deepEqual(nativeRequestFromPayload({ response: { status: 200 } }, original), original);
});
