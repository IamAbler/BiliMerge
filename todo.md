# BiliMerge — Cloudflare Worker 构建期合并 Bilibili 双模块 · 任务简报

> **读者**：接手的执行 agent。开工前必须通读全文，尤其是 §3（实证事实）、§8（任务清单）、§9（环境坑）。
> **侦察基准日**：2026-09-22。所有上游事实均为当日实测，动态拉取设计意味着执行时上游可能已更新——解析器必须对结构变化鲁棒。
> **状态标记**：`[ ]` 未开始 · `[x]` 已完成。当前阶段：**规划完毕，尚未写任何产品代码**。

---

## 0. 一句话目标

用 Cloudflare Worker 做**构建期合并**：每次请求动态拉取 Biliverse/ADBlock（A 块）与 Biliverse/Global（B 块）的 latest 发布产物，合并生成单一 c.js 返回给 Surge，并动态生成配套 .sgmodule；Surge 侧只看到一次脚本执行、一次 `$done()`。Worker 不做任何运行时代理逻辑。

## 1. 硬性约束（用户指定，不可更改）

1. Worker 只做构建期合并 + 静态资源托管，不参与运行时处理。
2. **每次请求都重新生成 c.js，不用 KV**（上游字节的短 TTL 缓存已获准，见 §4.5）。
3. 用 Wrangler CLI 部署。
4. Surge 只看到一次脚本执行、一次 `$done()`。
5. 合并语义：A（ADBlock）先处理 → 结果重新赋给**全局** `$response`/`$request` → B（Global）再处理 → 最外层唯一一次真 `$done()`。
6. 上游版本**不固定**：通过 latest 入口动态解析（见 §3.1）。

## 2. 用户已确认的决策表

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 上游 | `https://github.com/Biliverse/ADBlock/releases/latest/download/BiliBili.ADBlock.sgmodule` 与 `https://github.com/Biliverse/Global/releases/latest/download/BiliBili.Global.sgmodule` 动态拉取，从中解析 bundle 真实 URL（不写死版本号） |
| 2 | 合并版 sgmodule 形态 | pattern 并集，保留各行 flag（requires-body / binary-body-mode / max-size / engine / ability）；Map Local(BoxJS)、Body Rewrite、MITM 段一并合并 |
| 3 | c.js 执行策略 | **pattern 分诊**：构建期从上游 sgmodule 提取两套 pattern 表嵌入 c.js；只属于 A 的 URL 只跑 A，只属于 B 的只跑 B，重叠 URL 才 A→B 串联 |
| 4 | `$done` 处理 | **作用域遮蔽**捕获，上游代码一字不改（放弃文本替换 5 处 `$done` 的原方案） |
| 5 | 配置传递 | **前缀拆分**：sgmodule `#!arguments` 声明 `ADBlock.*` / `Global.*` 两套前缀键；c.js 运行时按嵌入键表为每块重建去前缀的 `$argument` 字符串；两套 LogLevel 独立；BoxJS Map Local 保留 |
| 6 | 缓存 | 允许 Cloudflare Cache API / `cf.cacheTtl` 对上游文件做短 TTL（约 600s）缓存；c.js 仍每次重新合并；**不用 KV** |
| 7 | 错误处理 | **fail-open 兜底脚本**：上游拉取失败或合并出错时返回一个极小的合法脚本（原样 `$done`，请求不受影响），响应头标注错误原因 |
| 8 | 部署 | 用户自置环境变量 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`（变量名以用户届时告知为准），由执行 agent 跑 `wrangler deploy` 并验证线上 URL |
| 9 | 域名 | workers.dev 默认子域，worker 名 `bilimerge` |
| 10 | 验证 | 本地 Node Surge 模拟测试台 + 合成 fixture，四路输出等价比对（详见 §6） |
| 11 | sgmodule 生成方式 | **Worker 动态生成** `/bili-adblock.sgmodule`（加入 run_worker_first），随上游 latest 同步，script-path 自动填当前请求域名（放弃静态快照） |
| 12 | `/` 首页 | 静态说明页（assets 目录，吃 CDN 缓存） |

## 3. 上游事实（2026-09-22 实证，样本存于 `.scratch/upstream/`）

### 3.1 入口与版本

- latest 入口（302 → `release-assets.githubusercontent.com`，内容可正常下载）：
  - A：`https://github.com/Biliverse/ADBlock/releases/latest/download/BiliBili.ADBlock.sgmodule`
  - B：`https://github.com/Biliverse/Global/releases/latest/download/BiliBili.Global.sgmodule`
- 侦察当日 latest：ADBlock **v0.6.27**，Global **v0.8.25**（`github.com/<repo>/releases/latest` 的 redirect_url 可查证）。
- bundle 真实 URL 模式（**从 sgmodule 的 `script-path=` 解析，勿硬编码**）：
  `https://github.com/Biliverse/<Repo>/releases/download/v<ver>/{request,response}.bundle.js`
- 侦察当日字节数：A-request 115,468 B · A-response 202,974 B · B-request 776,609 B · B-response 368,703 B。合并后 request ≈ 890 KB、response ≈ 570 KB。
- 同 Release 还有 `BiliBili.<Module>.boxjs.json`（BoxJS 面板配置，Map Local 段引用）、`.plugin`、`.snippet`、`.stoverride`（本项目不需要，但证明 latest/download 路径下资产名稳定）。

### 3.2 bundle 结构与关键代码事实（决定合并方案的根基）

四个 bundle 共用同一套 iRingo 风格运行时（Biliverse 组织统一构建管线），实证结论：

1. **文件形态**：无 ESM `import`/`export`（grep 0 处）；单行/双行 minified；开头是
   `console.log("Date: ..."),console.log("Version: ..."),console.log("request.bundle.js"),console.log("📺 BiliBili: ...");const e=(()=>{...`
   即**顶层裸语句**（含顶层 `const e` 等，两块直接拼接必然冲突 → 必须各自独立函数作用域）。
2. **顶层 await**：存在（A-response 约 5 处、B-request 约 1 处迹象）。→ 包裹必须用 **AsyncFunction**（`Object.getPrototypeOf(async function(){}).constructor`）或 async IIFE，不能用普通 Function。
3. **环境分发与 `$done`**：文件尾部是按 `$environment['user-agent']` 的 switch，5 处 `$done(...)` 分属 Surge / Loon / Quantumult X / Stash / Egern+Shadowrocket 互斥分支；另有 `case"Worker"`（不调 `$done` 只打日志）和 `case"Node.js"`（`process.exit(1)`）。**Surge 环境下恰好执行 1 处、调用 1 次 `$done(r)`**，`r` 即该块的最终结果对象。
4. **`globalThis.$done` 显式引用：0 处**（四个文件均验证）→ 函数作用域内 `const $done = capture` 遮蔽即可捕获，所有裸引用都会绑定到遮蔽变量。
5. **⚠️ `globalThis.$argument` 被直接读写（每文件 8 处）**：运行时自己把 `$argument` 字符串解析成对象（`case"string": e.replace(/^\?/,"") ... split("&") ... Object.fromEntries`）并回写 `globalThis.$argument`；还会临时改写 `.Storage` 再 `finally` 恢复；Global 块另有
   `globalThis.$argument.Storage = <store>.getItem(\`@${org}.${module}.Settings\`,{}).Storage ?? <arg值>`
   → **参数遮蔽对 `$argument` 无效**。正确做法：每块执行前直接 `globalThis.$argument = "<该块的去前缀参数串>"`，让块内自带解析器原样工作。
6. **其余 Surge 全局均为只读裸引用**（无 `globalThis.` 前缀）：`$response`(1–3)、`$request`(1–6)、`$environment`(2)、`$persistentStore`(4)、`$httpClient`(0–1)、`$task`(1)、`$script`（用于 `startTime` 计时日志）、`$notification`(0)。→ 遮蔽或全局重设均可行；重设全局 `$response`/`$request` 符合用户指定语义。
7. **`$persistentStore` 键全部带命名空间**：`@Biliverse.ADBlock.Caches`、`@Biliverse.Index.Caches`、`@Biliverse.Global.Caches`、`@Biliverse.Global.Settings` 等 → 两块共享同一 store **零冲突**；BoxJS 面板写入同样的键 → 面板功能原样保留。
8. **Surge 分支的二进制体约定**（A、B 完全一致，同一套运行时代码）：
   - 出口：binary 模式下 `bodyBytes = body.buffer.slice(byteOffset, byteLength+byteOffset); body = undefined`，并删除 `Content-Length`/`content-length`/`Transfer-Encoding` 头，缺 status 时补 `"HTTP/1.1 200 OK"`，然后 `$done(r)`。
   - 入口（文件最末尾的 `(async function(r){...})($response)`）：对 string body / `bodyBytes` / undefined 三分支归一化；非法类型 `t.error("不合法的 $response 类型: ...")`。
   - request 侧还有 `case"undefined": a($request)`（无修改透传）与 `a({response: Jr})`（http-request 本地 mock 响应，ADBlock 隐私拦截用）。
   → **A→B 交接变换 = 对 Surge 在两个独立脚本间传递响应这一过程的精确逆/正变换**，见 §4.3。
9. **`$argument` 键集**（来自上游 sgmodule `#!arguments`）：
   - ADBlock（31 键）：`Splash, Feed.AD, Feed.Activity, Feed.Vertical, Feed.BlockUpLiveList, Feed.Story, Feed.StoryCommercial, Search.AD, Search.Tracking, Search.HotSearch, PGC.AD, Xlive.AD, Xlive.RemoveTrackingCallbacks, Xlive.RemovePreloadTracking, Dynamic.HotTopics, Dynamic.MostVisited, Dynamic.MostVisitedLiveOnly, Dynamic.AdCard, Dynamic.PersonalAdCard, View.AD, DM.Command, DM.Colorful, DM.Airborne, Reply.AD, Reply.CommercialLinks, Reply.SubjectDescriptionCommercial, Privacy.Tracking, Privacy.BlockBiliCommercial, Privacy.BlockThirdParty, Privacy.Strict, LogLevel`
   - Global（8 键）：`ForceHost, Locales, Proxies.CHN, Proxies.HKG, Proxies.MAC, Proxies.TWN, Storage, LogLevel`
   - **唯一撞名键：`LogLevel`**（这是前缀拆分方案的直接动因）。
   - 注意 `Storage` 仅 Global 有，默认 `"Argument"`（优先读 `$argument`）；ADBlock 无此键。

### 3.3 上游 sgmodule 结构（合并版生成器的输入规范）

两个 sgmodule 均含以下段（顺序：头部注释 → Map Local → Body Rewrite(仅 ADBlock) → Script → MITM）：

- **头部元数据**：`#!name` `#!desc` `#!openUrl` `#!author` `#!homepage` `#!icon` `#!category` `#!date` `#!version` `#!arguments`（键:默认值 逗号分隔，字符串值带 `"..."`）`#!arguments-desc`（`\n` 转义的多行说明）。
- **[Map Local]**：
  - 双方各有 1 行 BoxJS 面板 mock：`^https:\/\/(?:biliverse\.github\.io|app\.bilibili\.com)\/api\/(ADBlock|Global)(?:\?.*)?$ data-type=file data="<versioned boxjs.json URL>" status-code=200 header="Content-Type:application/json; charset=utf-8|Cache-Control:no-store|X-PreferencePanes-Version:<ver>"`
  - ADBlock 另有若干内容 mock 行（DefaultWords 最小 gRPC 空帧 base64、recommend_words `{}`、topic_svr `{}`、mix_uplist `{}`、manga Flash/ListFlash `{}`、get_shopping_info `{}`、pgc deliver/material HTML 广告 JSON），**逐字保留**。
- **[Body Rewrite]**（仅 ADBlock 1 行）：`http-response-jq ^https:\/\/api\.bilibili\.com\/pgc\/view\/v2\/app\/season\? 'del(.data.payment)'`，**逐字保留**（它与 Global 对同 URL 的 response 脚本属不同机制，Surge 内可共存，与同时安装两模块行为一致）。
- **[Script]**：ADBlock ~15 行、Global ~17 行。行格式：
  `<名称> = type=http-request|http-response, pattern=<regex>, [requires-body=1,] [binary-body-mode=1,] [engine=webview,] [ability=http-client-policy,] [max-size=65536|262144,] script-path=<bundle URL>, argument=<K="{{{K}}}"&... 全量键>`
  - ADBlock 全部行带 `engine=webview`；Global 的 gRPC 行带 `engine=webview`，HTML/JSON 行不带；Global 的 http-request 行多带 `ability=http-client-policy`（脚本可返回 `policy` 改变路由）。
  - 同名行可重复出现（如 `📺 BiliBili.ADBlock.response.json` 两行），Surge 容忍；合并版生成唯一名称即可。
  - argument 值是 BoxJS 模板 `{{{Key}}}`，键与 `#!arguments` 声明一一对应。
- **[MITM]**：`hostname = %APPEND% <逗号列表>`、`h2 = true`。两模块列表需取并集（均含 app.bilibili.com / app.biliapi.net / api.bilibili.com / api.biliapi.net / grpc.biliapi.net / biliverse.github.io；ADBlock 另有 manga.bilibili.com、api.live.bilibili.com、api.vc.bilibili.com、cm.bilibili.com、adtrack.qianwen.com、tkio-redirect.solar-engine.com、app.biliapi.com；Global 另有 www.bilibili.com、search.bilibili.com）。

### 3.4 pattern 重叠矩阵（分诊表的事实依据，2026-09-22 版）

- **request 侧：A、B pattern 交集为空。**
  - A-request：`app.bili(bili.com|api.net)/x/v2/feed/index?`、隐私端点（`cm.bilibili.com/cm/api/(conversion/mobile/v2|fees/wise)`、`adtrack.qianwen.com/v3/ad/(show/)?bilibili`、`tkio-redirect.solar-engine.com/receive/turl/`）、`DmSegMobile`（gRPC，binary）。
  - B-request：`www.bilibili.com/bangumi/play/(ss|ep)\d+`、`viewunite.v1.View/View`（gRPC，binary）、`pgc/view/(v2/app|web|pc)/season?`、`playerunite.v1.Player/PlayViewUnite`、`pgc.gateway.player.v2.PlayURL/PlayView`、`pgc/player/(api|web)/playurl`、`pgc/player/web/v2/playurl?`、`search.bilibili.com/all?`、`polymer.app.search.v1.Search/(SearchAll|SearchByType)`、`x/v2/search(/type)?`、`x/web-interface/wbi/search/(all/v2|type)`、`x/web-interface/search/(all/v2|type)`、`x/v2/space?`、`x/space/wbi/acc/info?`、`x/space/acc/info?`。
- **response 侧唯一真重叠**：`bilibili.app.viewunite.v1.View/View`
  （A 的 view.response.grpc 行 pattern 为 `viewunite\.v1\.View\/(View|RelatesFeed|ViewProgress|PlayPause|ViewEndPage)`，其中只有 `View` 与 B 的 `viewunite.v1.View.grpc` response 行重叠；其余四个方法 A-only）。
- 跨类型同 URL（**不构成串联**，各归各的合并脚本）：`SearchAll`（A-response + B-request）、`pgc.gateway.player.v2.PlayURL/PlayView`（A-response + B-request）、`season?`（A-BodyRewrite + B-request + B-response）。
- **含义**：A→B 交接变换（§4.3）目前只需覆盖 response 侧 1 个 URL；request 侧的分诊永远是单块直跑 + 载荷原样透传。但实现必须通用（上游未来可能新增重叠），重叠判定在构建期由 pattern 相交计算，不写死。
- pattern 相交判定建议：构建期做「正则字符串精确匹配 → 同组；否则用样本 URL 生成 + 双向 test 做启发式相交」，无法判定是否相交时**保守归入 both**（宁可多跑一块也不漏行为）。当前数据下应得出：request both=∅，response both=[viewunite View]。

### 3.5 运行环境实测

- Node v24.21.0 可用；`wrangler` 未安装，registry.npmjs.org 可达（曾见一次瞬时 TLS 失败，重试即可）。
- **`~/.npm` 只读** → npm/pnpm 安装必须重定向缓存与 store 到工作区（见 §9）。
- GitHub API 匿名限额 60/h **已在侦察中耗尽** → 一切上游访问走 `raw.githubusercontent.com`、`releases/latest/download/`、releases HTML 页面，**不要用 api.github.com**。
- `releases/latest/download/<asset>` 302 → `release-assets.githubusercontent.com`（带签名的 Azure blob URL，约 1h 过期）→ **缓存上游字节时以原始 github.com URL 为缓存键**，勿缓存签名 URL。

---

## 4. 架构设计

### 4.1 Worker 请求流

```
GET /merged-request.js | /merged-response.js   (run_worker_first)
  1. 并行 fetch 两个 latest sgmodule（Cache API, TTL 600s, stale-if-error）
  2. 解析（§3.3 规范）→ 版本、bundle URL、script 行、arguments 键表、其余段
  3. 并行 fetch A/B 两个对应 type 的 bundle（同缓存策略）
  4. 生成 c.js（§4.2），任何一步失败 → fail-open 兜底（§4.4）
  5. 返回 200, Content-Type: application/javascript; charset=utf-8,
     Cache-Control: no-store（c.js 本身不缓存）,
     X-BiliMerge-ADBlock: <ver>, X-BiliMerge-Global: <ver>, X-BiliMerge-Type: request|response

GET /bili-adblock.sgmodule   (run_worker_first)
  同上 1–2 → 生成合并 sgmodule（§4.6），script-path 用请求 Host 拼当前域名
  返回 200, text/plain; charset=utf-8（Surge 可识别的模块 MIME）, Cache-Control: max-age=600

GET / 及其他静态路径 → assets（public/index.html 说明页），CDN 缓存
```

### 4.2 c.js 生成结构（伪代码，实现时的模板骨架）

```js
// 生成头注释：两模块名+版本+生成时间+分诊表摘要
(() => {
  const REAL_DONE = $done;                       // 唯一真 $done，最外层调用
  const SRC_A = "<JSON.stringify(A bundle 原文)>"; // 惰性求值：分诊命中才 parse
  const SRC_B = "<JSON.stringify(B bundle 原文)>";
  const ARGS_A = "<A 的 31 键名列表 JSON>";        // 从上游 #!arguments 提取
  const ARGS_B = "<B 的 8 键名列表 JSON>";
  const DISPATCH = { a: [<regex 字符串>...], b: [...], both: [...] }; // 按 §3.4 构建期计算
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

  function buildArg(prefixed, keys, prefix) {
    // 输入：Surge 传入的全量前缀 argument 串（ADBlock.Splash="..."&Global.ForceHost="..."&...）
    // 输出：该块的去前缀串（Splash=...&...），仅含 keys 中声明的键，保留原引号/转义
  }
  function triage(url) { /* 依次 test both → a → b，返回 "a"|"b"|"ab" */ }
  async function runBlock(src, argStr, input) {
    // input: {kind:"response"|"request", value: 当前 $response/$request 对象}
    globalThis.$argument = argStr;                // ⚠️ 必须重设全局（§3.2 事实5）
    let captured, capturedFlag = false;
    const shadowDone = (r) => { if (!capturedFlag) { capturedFlag = true; captured = r; } };
    // $done 遮蔽：作为 AsyncFunction 形参注入（裸引用全部绑定到它）
    // $response/$request：直接重设 globalThis 上对应键（Surge 全局对象可写）
    const fn = new AsyncFunction("$done", src);   // 顶层 await 合法
    await fn(shadowDone);                          // 块内 dispatch 走 Surge 分支 → 捕获
    return { ok: capturedFlag, value: captured };
  }
  function toNextResponse(payload, orig) { /* §4.3 A→B 交接变换 */ }

  (async () => {
    const route = triage($request.url);
    let cur = { kind: IS_RESPONSE ? "response" : "request",
                value: IS_RESPONSE ? $response : $request };
    if (route === "a" || route === "ab") {
      const ra = await runBlock(SRC_A, buildArg(...A...), cur) 包 try/catch;
      if (ra.ok) cur = { kind: cur.kind, value: (route==="ab") ? toNextResponse(ra.value, cur.value) : ra.value, donePayload: ra.value };
      // 块抛错/未捕获 → 保持 cur 不变（等价于该块独立安装时崩溃的 fail-open）
    }
    if (route === "b" || route === "ab") { /* 同上跑 B */ }
    REAL_DONE(最终载荷);   // 恰好一次；单块路由时载荷 = 该块捕获值原样透传
  })();
})();
```

实现注意：
- `IS_RESPONSE` / 分诊表 / 键表 / 源码字符串全部构建期注入，c.js 内不做网络请求。
- request 型 c.js 的 `cur.value` 是 `$request`；透传语义与上游一致（含 `{response:...}` mock 形态、`policy` 键——**不得增删改块产出的载荷键**，单块路由时字节级原样传给真 `$done`）。
- A→B 串联只发生在 response（当前数据），但代码路径对 request 也要实现（`toNextRequest`：method 保留原值，url/headers/body 以 A 载荷覆盖），防上游演化。
- 每块加超时保护（如 `Promise.race` 10s）：超时视为块失败，链条继续（见 §4.4 语义）。

### 4.3 A→B 交接变换（唯一重叠 URL 的正确性核心）

Surge 原生行为：脚本1 `$done(payload)` → Surge 用 payload 更新响应 → 脚本2 拿到的 `$response` 是更新后的原生形态。合并版必须精确复刻这一 hand-off：

- A 的 Surge 分支载荷（binary 模式）：`{ status?: "HTTP/1.1 200 OK"字符串, headers, body: undefined, bodyBytes: ArrayBuffer }`；非 binary：`{ ..., body: string, bodyBytes: undefined }`。
- 变换为 B 的入口 `$response`：
  - binary：`body = new Uint8Array(payload.bodyBytes)`（B 入口归一化会再转回 bodyBytes——与其独立安装时收到 Surge 原生 Uint8Array 完全同构）；
  - string：`body = payload.body`；
  - `status`/`headers` 原样带上；缺省字段回落原 `$response` 的对应值；
  - gRPC 5 字节帧前缀（1B 压缩标志 + 4B 长度）不需要特殊处理——Surge 交给脚本的 body 本身含帧前缀，A 的运行时已按帧解包/回包（入口/出口代码可证），变换只做容器形态转换，不动字节。
- **验证义务**：§6 的四路等价比对必须覆盖此路径（fixture 用真实 proto 字段构造，见 §6.2）。

### 4.4 错误处理（fail-open）

- **Worker 层**（上游 fetch 失败 / 解析失败 / 合并抛错）：返回 200 + 兜底脚本：
  ```js
  // BiliMerge fail-open: <简短原因，注意转义>
  try {
    if (typeof $response !== "undefined") { $done($response); }
    else if (typeof $request !== "undefined") { $done($request); }
    else { $done({}); }
  } catch (e) { $done({}); }
  ```
  响应头：`X-BiliMerge-Error: <原因>`、`X-BiliMerge-Upstream: <失败的URL>`。HTTP 状态仍为 200（保证 Surge 拿到可执行脚本而非报错跳过）。
- **c.js 运行时层**（块抛错/超时/未捕获 `$done`）：该块视为不存在，链条带着上一状态继续，最终仍恰好一次真 `$done`——精确对应「独立安装时该模块脚本崩溃、另一模块照常工作」的语义。
- **sgmodule 生成失败**：返回 502 + 纯文本说明（sgmodule 拉取失败无 fail-open 概念，Surge 会提示模块更新失败，不影响已装配置）。

### 4.5 缓存策略（已获用户批准，非 KV）

- 用 `caches.default`（Cache API）缓存 6 个上游 URL（2 sgmodule + 4 bundle；实际每次请求只需 2+2）：
  - 命中且未过期（TTL 600s，按 `Date` 头或存入时自定义头计龄）→ 直接用；
  - 未命中 → `fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } })`（对 github.com 302 会跟随到签名 URL，缓存键仍是原 URL）→ 成功后 `cache.put`；
  - fetch 失败但缓存有**过期**条目 → 用过期条目（stale-if-error），响应头加 `X-BiliMerge-Stale: 1`。
- c.js / sgmodule 输出本身：`Cache-Control: no-store`（满足"每次重新生成"）。
- 不引入 KV、不引入 D1、不做 isolate 内存缓存（Cache API 已够，且 isolate 内存不可靠）。

### 4.6 合并版 sgmodule 生成规则

- **头部**：`#!name = 📺 BiliBili: Merged (ADBlock + Global)`（可调）；`#!version = <A ver>+<B ver>`；`#!desc`/`#!author`/`#!homepage` 汇总两模块并附本项目说明；`#!arguments` = 两模块键的并集、全部加前缀：`ADBlock.Splash:true,...,ADBlock.LogLevel:"WARN",Global.ForceHost:"1",...,Global.LogLevel:"WARN"`（默认值逐字取自上游 `#!arguments`）；`#!arguments-desc` = 两段 desc 拼接、键名同步加前缀。
- **[Map Local]**：两模块的行逐字保留（含各自 versioned boxjs.json URL 与 `X-PreferencePanes-Version` 头——来自当次拉取的 latest sgmodule，天然同步）。
- **[Body Rewrite]**：ADBlock 的行逐字保留。
- **[Script]**：按 (type, pattern) 分组求并集：
  - 仅 A 的行 → 保留 A 的全部 flag；仅 B 的行 → 保留 B 的全部 flag；
  - 同 type 且 pattern 字符串相同的行 → 合并为一行：flag 取并集（`max-size` 取数值较大者；`requires-body`/`binary-body-mode`/`engine=webview`/`ability=http-client-policy` 任一存在即保留）；
  - 所有行 `script-path = https://<当前请求Host>/merged-<type>.js`；
  - 所有行 `argument = ADBlock.<K>="{{{ADBlock.<K>}}}"&...&Global.<K>="{{{Global.<K>}}}"&...`（全量前缀键，值引号规则沿用上游：含逗号/空格的字符串值带双引号）；
  - 行名：`📺 BiliMerge.<type>.<序号或语义名>`，全文件唯一；重叠行名后追加 `(A+B)` 便于识别。
- **[MITM]**：`hostname = %APPEND% <两列表并集，保持上游顺序 A 先 B 后去重>`；`h2 = true`。
- Host 获取：`new URL(request.url).host`（workers.dev 下即 `bilimerge.<subdomain>.workers.dev`；未来接自定义域自动正确）。

## 5. 已披露的不可消除差异（用户知情）

1. **超时预算共享**：重叠 URL 上 A+B 共用 Surge 的一个脚本超时（原各自独立）。当前仅 1 个 URL 受影响，两块均为本地 protobuf/JSON 处理，毫秒级。
2. **日志交织**：两块 `console.log`（含各自 Date/Version 头）出现在同一次执行中。纯外观，利于排查。
3. **脚本名变化**：Surge UI 显示合并模块名。纯外观。
4. **解析成本缓解**：块源码以字符串内嵌、分诊命中才 AsyncFunction 惰性求值——A-only URL 不付出解析 B（777KB）的成本。
5. **共存冲突**：用户必须**卸载原两个模块再装合并模块**，否则同 URL 双重处理。说明页与 README 必须显著提示。

## 6. 验证方案（等价性证明义务）

### 6.1 Surge 模拟测试台（tests/harness/）

Node 内构造全局：`$environment = { 'user-agent': 'Surge iOS/2786', ... }`（**先用真实分支代码确认触发 "Surge" case 的 UA 判定条件**，从 bundle 头部环境探测逻辑反推）、`$script = { startTime: Date.now() }`、`$argument = <字符串>`、`$persistentStore = { get/set } 内存实现`、`$httpClient = 可编程 stub`、`$task = stub`、`$notification = stub`、`$done = 捕获器（计数 + 载荷）`、按 fixture 设定 `$request`/`$response`（binary 模式下 body 为 Uint8Array）。

### 6.2 fixture

- **gRPC（重叠 URL 主战场）**：`bilibili.app.viewunite.v1.View/View` 响应，5 字节帧前缀 + ViewReply protobuf。构造途径（按优先级）：a) 从 bundle 内提取 proto 描述/生成的 fromBinary 元数据反推字段号；b) 用社区 proto（bilibili-API-collect 等）+ `@bufbuild/protobuf` 序列化；内容需**包含 A 会实际修改的字段**（如广告/tab 模块），否则等价比对退化为双透传、证明力不足——生成后先跑 A 单独，确认载荷确有变化，再进入比对。
- **JSON**：`pgc/view/v2/app/season?` 响应（B 会改写 host/area 相关字段；含 `data.payment` 以对照 Body Rewrite 语义说明）、`x/v2/feed/index?` 响应（A-only）、`x/v2/search?` 请求（B-only）、隐私端点请求（A-only mock `{response:...}` 路径）。
- 每条 fixture 覆盖一个分诊类别：A-only / B-only / A→B，request 与 response 都要有。

### 6.3 四路等价比对（核心断言）

对每条 fixture：
1. **A 单独**：模拟台 + 原始 A bundle + A 的原生 argument 串 → 记录 `$done` 载荷 P_A；
2. **B 单独**：同上 → P_B；
3. **手工串联**：A 单独跑完，把 P_A 经 §4.3 变换喂给 B 再跑 → P_chain；
4. **合并 c.js**：模拟台加载 Worker 生成的 c.js（带前缀 argument 串）→ P_merged。
断言：分诊=A 的 fixture 上 `P_merged ≡ P_A`；分诊=B 上 `P_merged ≡ P_B`；分诊=AB 上 `P_merged ≡ P_chain`；所有情形 `$done` 恰好 1 次；深度比较需归一化 Uint8Array/ArrayBuffer 与键序。
另加：块内抛错注入 → 断言链条继续且仍一次 `$done`；fail-open 兜底脚本 → `node --check` + 模拟台执行断言。

### 6.4 其他测试

- sgmodule 解析器：对 `.scratch/upstream/` 的两份真实文件做快照测试（版本号、行数、flag、键表全量断言）。
- 分诊表构建：断言当前上游数据得出 request both=∅、response both=[viewunite View]。
- 生成的 c.js / sgmodule：语法检查 + 结构断言（前缀键完整、script-path 域名正确、MITM 并集）。
- `wrangler dev` 本地冒烟：三个动态路径 + `/` 均 200，`node --check` 拉回的 c.js。

## 7. 部署

1. 前置：用户已在环境自置 `CLOUDFLARE_API_TOKEN`（需 Workers Scripts 部署权限；若含 Account Settings 读权限可自动发现 account id 与 workers.dev 子域）与（可选）`CLOUDFLARE_ACCOUNT_ID`。**执行前用 `env | grep CLOUDFLARE` 确认存在，缺失则停下来向用户要。**
2. `npm_config_cache=$PWD/.npm-cache npm install`（wrangler 为 devDependency；见 §9 只读坑）。
3. `wrangler.jsonc`：
   ```jsonc
   {
     "name": "bilimerge",
     "main": "src/worker.js",
     "compatibility_date": "<部署日>",
     "assets": {
       "directory": "./public",
       "run_worker_first": ["/merged-request.js", "/merged-response.js", "/bili-adblock.sgmodule"]
     }
   }
   ```
4. `CLOUDFLARE_API_TOKEN=... npx wrangler deploy`（若账号未开 workers.dev 子域，wrangler 会报错 → 让用户先在 dash 开通或改用自定义域）。
5. 线上验证：curl 四个路径；`node --check` 两个 c.js；核对 `X-BiliMerge-*` 头版本与当日 latest 一致；连续两次请求验证缓存命中（第二次显著更快）；构造坏 URL（如临时改 worker 内上游域名）验证 fail-open 可省略——用单测覆盖即可。
6. 交付说明：Surge 安装 `https://bilimerge.<subdomain>.workers.dev/bili-adblock.sgmodule`，**先卸载原两模块**；http-response 行的 requires-body/max-size 已由模块携带，无需用户配置。

## 8. 任务清单（顺序执行，含验收标准）

- [ ] **T1 项目脚手架**：`package.json`（type:module, scripts: test/dev/deploy）、`wrangler.jsonc`、`.gitignore`（node_modules/.npm-cache/.scratch/.dev.vars）、目录 `src/ public/ tests/`。验收：`npm install`（重定向缓存后）成功，`npx wrangler --version` 可执行。
- [ ] **T2 sgmodule 解析器** `src/sgmodule-parse.js`：输入 sgmodule 文本 → `{version, name, arguments:[{key,default,quoted}], argumentsDesc, mapLocal:[], bodyRewrite:[], scripts:[{name,type,pattern,flags{},scriptPath,argumentKeys[]}], mitm:{hostnames[],h2}}`。验收：对两份真实样本全字段快照测试通过；对缺段/多空格/重复行名鲁棒。
- [ ] **T3 分诊与 flag 合并** `src/dispatch.js`：由两模块 scripts 计算按 type 的 `{aOnly,bOnly,both}` pattern 分组与合并行 flag。验收：当前数据断言（§6.4）；无法判定相交时保守入 both 的单测。
- [ ] **T4 合并生成器** `src/merge.js`：产出 c.js 文本（§4.2 模板 + §4.3 变换 + 前缀 argument 重建 + 惰性 AsyncFunction + 每块 try/catch/超时）。验收：`node --check` 通过；模拟台上 §6.3 全部断言通过。
- [ ] **T5 sgmodule 生成器** `src/sgmodule-gen.js`：§4.6 规则。验收：结构断言测试 + 人读 diff 合理。
- [ ] **T6 Surge 模拟测试台与 fixture** `tests/`：§6.1–6.3。验收：`npm test` 全绿；**先证明 A 单独运行确实修改了 gRPC fixture**（防止等价比对空转）。
- [ ] **T7 Worker 入口** `src/worker.js`：路由、Cache API（§4.5）、fail-open（§4.4）、`X-BiliMerge-*` 头。验收：`wrangler dev` 冒烟（§6.4）；断网/坏 URL 注入时返回兜底脚本。
- [ ] **T8 说明页** `public/index.html`：项目说明、安装链接（相对路径自动适配域名）、"先卸载原模块"警告、fail-open 行为说明、上游版本实时显示（可由 worker 注入或静态说明）。
- [ ] **T9 部署与线上验证**：§7 全流程。前置：用户环境变量就绪。验收：线上四路径 200 + c.js 语法有效 + 版本头正确 + 二次请求缓存加速可测。
- [ ] **T10 README.md**：架构、决策记录（§2 表）、本地开发/测试/部署命令、更新上游=无需任何操作（latest 自动跟随）、已知差异（§5）。

依赖关系：T1 → T2 → T3 → {T4,T5}；T6 依赖 T4 的产物接口但可与 T4 交叉推进；T7 依赖 T4/T5；T9 依赖全部 + 用户 token。

## 9. 环境坑（执行 agent 必读）

1. **`/tmp` 跨 bash 调用不持久**（每次调用独立沙箱临时区）→ 一切中间文件放 `工作区/.scratch/`。
2. **`~/.npm` 只读文件系统** → 所有 npm/npx 命令前缀 `npm_config_cache=$PWD/.npm-cache`（或 pnpm `--store-dir`）；全局安装不可行，一律项目内 devDependency。
3. **GitHub API 匿名限额已耗尽** → 只用 `raw.githubusercontent.com` / `releases/latest/download/` / releases HTML（`expanded_assets/<tag>` 可列资产）；不要调 `api.github.com`。
4. 文件沙箱为 workspace-write：只有 `/home/abler/workspace/bilimerge` 可写；被拒的操作按 harness 规则处理，勿绕过。
5. `registry.npmjs.org` 偶发 TLS 失败（`unexpected eof`）→ 重试即可，勿改镜像源（除非持续失败，届时先问用户）。
6. 上游 bundle 为超长单行 minified 文本：**任何 grep 都要限制输出宽度**（`-oE '.{0,N}...'`），严禁整文件 cat 进上下文。

## 10. 当前文件清单

```
bilimerge/
├── todo.md                     ← 本文件
└── .scratch/upstream/          ← 侦察样本（2026-09-22 latest，不入库、不部署）
    ├── ADBlock_v0.6.27_request.bundle.js    (115,468 B)
    ├── ADBlock_v0.6.27_response.bundle.js   (202,974 B)
    ├── Global_v0.8.25_request.bundle.js     (776,609 B)
    ├── Global_v0.8.25_response.bundle.js    (368,703 B)
    ├── ADBlock_v0.6.27.sgmodule             (33,077 B)
    └── Global_v0.8.25.sgmodule              (12,182 B)
```

**下一步**：等用户确认后从 T1 开始。部署（T9）前需用户自置 Cloudflare 环境变量并告知变量名。
