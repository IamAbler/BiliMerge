import { buildDispatch } from "./dispatch.js";
import { generateFailOpenScript, generateMergedScript } from "./merge.js";
import { generateSgmodule } from "./sgmodule-gen.js";
import { parseSgmodule } from "./sgmodule-parse.js";

export const UPSTREAM = {
  adblock: "https://github.com/Biliverse/ADBlock/releases/latest/download/BiliBili.ADBlock.sgmodule",
  global: "https://github.com/Biliverse/Global/releases/latest/download/BiliBili.Global.sgmodule",
};

const FRESH_TTL_SECONDS = 600;
const STALE_TTL_SECONDS = 86_400;

class UpstreamError extends Error {
  constructor(message, url, cause) {
    super(message, { cause });
    this.name = "UpstreamError";
    this.url = url;
  }
}

function safeHeader(value) {
  return String(value).replace(/[^\x20-\x7e]/g, "?").slice(0, 512);
}

export async function fetchUpstreamText(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = options.cache ?? globalThis.caches?.default;
  const now = options.now ?? Date.now();
  const key = new Request(url, { method: "GET" });
  let cached;

  if (cache) {
    try { cached = await cache.match(key); }
    catch (error) { console.log("[BiliMerge] cache match failed", error); }
  }

  if (cached) {
    const fetchedAt = Number(cached.headers.get("X-BiliMerge-Fetched-At"));
    if (Number.isFinite(fetchedAt) && now - fetchedAt <= FRESH_TTL_SECONDS * 1_000) {
      return { text: await cached.text(), stale: false, cache: "hit" };
    }
  }

  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      cf: { cacheTtl: FRESH_TTL_SECONDS, cacheEverything: true },
      headers: { "User-Agent": "BiliMerge-Worker/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text) throw new Error("empty response");

    if (cache) {
      const cacheResponse = new Response(text, {
        status: 200,
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "text/plain; charset=utf-8",
          "Cache-Control": `public, max-age=${STALE_TTL_SECONDS}`,
          "X-BiliMerge-Fetched-At": String(now),
        },
      });
      try { await cache.put(key, cacheResponse); }
      catch (error) { console.log("[BiliMerge] cache put failed", error); }
    }
    return { text, stale: false, cache: cached ? "refresh" : "miss" };
  } catch (error) {
    if (cached) return { text: await cached.text(), stale: true, cache: "stale" };
    throw new UpstreamError(`Failed to fetch upstream: ${error.message}`, url, error);
  }
}

function bundleUrl(module, type) {
  const expectedType = `http-${type}`;
  const urls = [...new Set(module.scripts
    .filter((script) => script.type === expectedType)
    .map((script) => script.scriptPath))];
  if (urls.length !== 1) {
    throw new UpstreamError(
      `Expected one ${type} bundle URL, found ${urls.length}`,
      urls.join(",") || "unknown",
    );
  }
  return urls[0];
}

async function loadModules(options) {
  const [a, b] = await Promise.all([
    fetchUpstreamText(UPSTREAM.adblock, options),
    fetchUpstreamText(UPSTREAM.global, options),
  ]);
  try {
    return {
      adblock: parseSgmodule(a.text),
      global: parseSgmodule(b.text),
      stale: a.stale || b.stale,
    };
  } catch (error) {
    throw new UpstreamError(`Failed to parse upstream module: ${error.message}`, "sgmodule", error);
  }
}

function versionHeaders(modules, type, stale = false) {
  const headers = {
    "X-BiliMerge-ADBlock": modules.adblock.version,
    "X-BiliMerge-Global": modules.global.version,
  };
  if (type) headers["X-BiliMerge-Type"] = type;
  if (stale) headers["X-BiliMerge-Stale"] = "1";
  return headers;
}

async function serveMergedScript(type, options) {
  let modules;
  try {
    modules = await loadModules(options);
    const [a, b] = await Promise.all([
      fetchUpstreamText(bundleUrl(modules.adblock, type), options),
      fetchUpstreamText(bundleUrl(modules.global, type), options),
    ]);
    const dispatch = buildDispatch(modules.adblock.scripts, modules.global.scripts);
    const body = generateMergedScript({
      type,
      sourceA: a.text,
      sourceB: b.text,
      moduleA: modules.adblock,
      moduleB: modules.global,
      dispatch,
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        ...versionHeaders(modules, type, modules.stale || a.stale || b.stale),
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new Response(generateFailOpenScript(reason), {
      status: 200,
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-BiliMerge-Error": safeHeader(reason),
        "X-BiliMerge-Upstream": safeHeader(error?.url || "unknown"),
        ...(modules ? versionHeaders(modules, type) : {}),
      },
    });
  }
}

async function serveSgmodule(request, options) {
  try {
    const modules = await loadModules(options);
    const body = generateSgmodule({
      adblock: modules.adblock,
      global: modules.global,
      host: new URL(request.url).host,
    });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ...versionHeaders(modules, null, modules.stale),
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return new Response(`BiliMerge module update failed: ${reason}\n`, {
      status: 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-BiliMerge-Error": safeHeader(reason),
        "X-BiliMerge-Upstream": safeHeader(error?.url || "unknown"),
      },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const options = {
      fetchImpl: env?.UPSTREAM_FETCH || fetch,
      cache: globalThis.caches?.default,
    };
    if (url.pathname === "/merged-request.js") return serveMergedScript("request", options);
    if (url.pathname === "/merged-response.js") return serveMergedScript("response", options);
    if (url.pathname === "/bili-adblock.sgmodule") return serveSgmodule(request, options);
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("BiliMerge\n", { status: url.pathname === "/" ? 200 : 404 });
  },
};
