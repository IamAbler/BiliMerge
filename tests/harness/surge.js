import vm from "node:vm";

function clone(value) {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  const result = { ...value };
  if (value.headers) result.headers = { ...value.headers };
  if (value.body !== undefined) result.body = clone(value.body);
  if (value.bodyBytes !== undefined) result.bodyBytes = clone(value.bodyBytes);
  return result;
}

export function normalize(value) {
  if (value instanceof ArrayBuffer) return { $bytes: [...new Uint8Array(value)] };
  if (ArrayBuffer.isView(value)) return { $bytes: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

export function nativeResponseFromPayload(payload, original) {
  if (!payload || typeof payload !== "object") return clone(original);
  const next = clone(original);
  if (Object.hasOwn(payload, "status")) next.status = payload.status;
  if (Object.hasOwn(payload, "headers")) next.headers = clone(payload.headers);
  delete next.bodyBytes;
  if (payload.bodyBytes != null) next.body = new Uint8Array(payload.bodyBytes);
  else if (Object.hasOwn(payload, "body")) next.body = clone(payload.body);
  return next;
}

export function nativeRequestFromPayload(payload, original) {
  if (!payload || typeof payload !== "object" || Object.hasOwn(payload, "response")) return clone(original);
  const next = clone(original);
  for (const key of ["url", "headers", "body"]) {
    if (Object.hasOwn(payload, key)) next[key] = clone(payload[key]);
  }
  if (payload.bodyBytes != null) next.body = new Uint8Array(payload.bodyBytes);
  return next;
}

export async function runSurgeScript(source, {
  request,
  response,
  argument = "",
  store = new Map(),
  timeoutMs = 10_000,
} = {}) {
  let calls = 0;
  let payload;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const persistentStore = {
    read(key) { return store.get(key) ?? null; },
    write(value, key) { store.set(key, value); return true; },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
    clearTimeout,
    $environment: { "surge-version": "5.0" },
    $script: { startTime: Date.now() },
    $argument: argument,
    $request: clone(request),
    $response: clone(response),
    $persistentStore: persistentStore,
    $httpClient: { get() {}, post() {} },
    $notification: { post() {} },
    $done(value) {
      calls += 1;
      if (calls === 1) {
        payload = value;
        resolveDone();
      }
    },
  });
  const AsyncFunction = vm.runInContext("Object.getPrototypeOf(async function () {}).constructor", context);
  let invocation;
  try {
    invocation = new AsyncFunction("$done", source)(context.$done);
  } catch (error) {
    throw error;
  }
  Promise.resolve(invocation).catch(() => {});
  await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Surge script timed out")), timeoutMs)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, payload, context, store };
}
