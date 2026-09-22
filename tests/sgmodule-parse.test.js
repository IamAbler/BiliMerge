import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseSgmodule } from "../src/sgmodule-parse.js";

const fixture = (name) =>
  readFile(new URL(`../.scratch/upstream/${name}`, import.meta.url), "utf8");

test("parses the real ADBlock module", async () => {
  const module = parseSgmodule(await fixture("ADBlock_v0.6.27.sgmodule"));
  assert.equal(module.name, "📺 BiliBili: 🛡️ ADBlock");
  assert.equal(module.version, "0.6.27");
  assert.equal(module.arguments.length, 31);
  assert.deepEqual(module.arguments.at(-1), {
    key: "LogLevel",
    default: "WARN",
    quoted: true,
    rawDefault: '"WARN"',
  });
  assert.equal(module.mapLocal.length, 9);
  assert.equal(module.bodyRewrite.length, 1);
  assert.equal(module.scripts.length, 16);
  assert.equal(module.scripts.filter(({ type }) => type === "http-request").length, 3);
  assert.equal(module.scripts.filter(({ type }) => type === "http-response").length, 13);
  assert.equal(module.mitm.hostnames.length, 13);
  const grpc = module.scripts.find(({ name }) => name.includes("view.response.grpc"));
  assert.deepEqual(grpc.flags, {
    "requires-body": "1",
    "binary-body-mode": "1",
    engine: "webview",
    "max-size": "262144",
  });
  assert.equal(grpc.argumentKeys.length, 31);
  assert.match(grpc.scriptPath, /v0\.6\.27\/response\.bundle\.js$/);
});

test("parses the real Global module and quoted comma defaults", async () => {
  const module = parseSgmodule(await fixture("Global_v0.8.25.sgmodule"));
  assert.equal(module.version, "0.8.25");
  assert.equal(module.arguments.length, 8);
  assert.deepEqual(module.arguments[1], {
    key: "Locales",
    default: "CHN,HKG,TWN",
    quoted: true,
    rawDefault: '"CHN,HKG,TWN"',
  });
  assert.equal(module.mapLocal.length, 1);
  assert.equal(module.bodyRewrite.length, 0);
  assert.equal(module.scripts.length, 18);
  assert.equal(module.scripts.filter(({ type }) => type === "http-request").length, 15);
  assert.equal(module.scripts.filter(({ type }) => type === "http-response").length, 3);
  assert.equal(module.mitm.h2, true);
});

test("accepts spacing, missing optional sections, and duplicate names", () => {
  const parsed = parseSgmodule(`#!name= Test\n#!version = v1.2.3\n#!arguments = A:"x,y", B:false\n\n[Script]\nsame=type=http-request, pattern=^https://a\\.test/, script-path=https://one\nsame = type=http-response,pattern=^https://a\\.test/,script-path=https://two\n`);
  assert.equal(parsed.version, "1.2.3");
  assert.equal(parsed.scripts.length, 2);
  assert.deepEqual(parsed.mapLocal, []);
  assert.deepEqual(parsed.mitm, { hostnames: [], h2: false });
});

test("accumulates repeated MITM hostname directives", () => {
  const parsed = parseSgmodule(`#!name=x\n#!version=1\n[Script]\na=type=http-request,pattern=^https://a,script-path=https://a\n[MITM]\nhostname = %APPEND% a.test, b.test\nhostname = c.test\nh2 = TRUE\n`);
  assert.deepEqual(parsed.mitm, { hostnames: ["a.test", "b.test", "c.test"], h2: true });
});

test("rejects missing required metadata or scripts", () => {
  assert.throws(() => parseSgmodule("#!name = x\n[Script]\n"), /version/);
  assert.throws(() => parseSgmodule("#!name=x\n#!version=1\n"), /no script/);
});
