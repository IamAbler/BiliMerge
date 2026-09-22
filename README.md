# BiliMerge

Cloudflare Worker：动态拉取 Biliverse 的 ADBlock 与 Global latest 发布物，在 Worker 内构建为一个 Surge 模块。它不代理任何 Bilibili 流量。

> **先卸载原始 ADBlock 和 Global 模块，再安装合并模块。** 与原模块共存会造成重复处理。

## 使用场景

在 Surge 中，同一个请求端点通常只能执行一条匹配的脚本规则。Biliverse 的 **ADBlock**（去广告、隐私拦截）与 **Global**（地区线路、搜索及番剧解锁）会在部分 Bilibili 端点同时命中；直接同时安装两个原模块时，其中一条规则会覆盖或抢占另一条，造成另一个模块的部分功能失效。

BiliMerge 将重叠规则收敛为一个入口脚本：该脚本在内部严格按 **ADBlock → Global** 顺序运行两个上游 bundle，并且只向 Surge 调用一次 `$done()`。因此同一端点上两模块应生效的功能可以同时保留，而不会发生 Surge 脚本规则冲突。

它适合希望：

- 只订阅一条 Surge 模块链接，同时保留两模块的功能与 BoxJS 配置；
- 分别调整 `ADBlock.*` 与 `Global.*` 参数，例如独立设置两套 `LogLevel`；
- 消除重叠端点的脚本抢占，让两块逻辑按确定顺序共同生效；
- 不想手动追踪 Biliverse 上游版本。Worker 会在缓存期后自动拉取 latest 发布物重新构建。

它只在获取模块/脚本时构建内容，**不会作为 Bilibili 请求代理**。上游暂时不可用时，脚本会 fail-open，避免阻断原始请求或响应。

## 安装

部署后在 Surge 添加：

```text
https://bilimerge.<你的-workers.dev-子域>.workers.dev/bilimerge.sgmodule
```

模块会指向同源的 `/merged-request.js`、`/merged-response.js`。它将 ADBlock 配置改为 `ADBlock.*` 前缀、Global 配置改为 `Global.*` 前缀，因此两套 `LogLevel` 可独立设置，BoxJS Map Local 条目仍被保留。

## 处理流程

### 1. 安装模块时

访问 `/bilimerge.sgmodule` 时，Worker 会并行拉取 Biliverse ADBlock 与 Global 的 `releases/latest/download/*.sgmodule`：

1. 解析上游模块中的 `#!arguments`、Map Local、Body Rewrite、Script 与 MITM 段；版本号和 bundle URL 均来自本次 latest 内容，不写死版本。
2. 将 ADBlock 参数改为 `ADBlock.*`、Global 参数改为 `Global.*`，避免两模块同名的 `LogLevel` 冲突。
3. 保留两边的 BoxJS Map Local、ADBlock Body Rewrite 与 MITM hostname 并集。
4. 将所有脚本规则指向当前 Worker 的 `/merged-request.js` 或 `/merged-response.js`。
5. 对两个模块重叠的 pattern 只生成一条 Surge 规则，避免同一端点被 Surge 启动两次。

返回的模块中仍包含全部 39 个前缀参数；Surge 展开参数后，会在每次匹配脚本请求时传给合并脚本。

### 2. Surge 执行合并脚本时

1. Surge 仅启动一份合并脚本。脚本读取当前 `$request.url`，使用从上游模块解析出的原始 ADBlock / Global pattern 分别判定是否命中。
2. 仅命中 ADBlock 时只运行 A；仅命中 Global 时只运行 B；两者同时命中时依次运行 **A → B**。
3. 运行每个上游 bundle 前，合并脚本从完整前缀参数中筛出该模块的键，去掉前缀后写入该块的 `globalThis.$argument`。这让上游 bundle 原有的参数解析和 BoxJS PersistentStore 逻辑保持可用。
4. 每个 bundle 都在独立 `AsyncFunction` 作用域中执行，避免 minified bundle 的顶层变量冲突；通过作用域遮蔽捕获其内部 `$done()`，不会提前结束 Surge 脚本。
5. 重叠的 response 场景中，A 的 `$done` 结果被还原为 Surge 会传递给下一条脚本的原生 `$response` 形态：字符串 body 原样传递，`bodyBytes` 转为 `Uint8Array`，并保留 `status` 与 `headers`。随后 B 处理该结果。
6. 最外层只调用一次真实 `$done()`：单模块路由原样返回该模块的结果；重叠路由返回 B 的结果，若 B 失败则回退到 A 的结果。

### 3. 缓存与故障处理

- 上游 sgmodule 与 request/response bundle 字节由 Cloudflare Cache API 缓存 600 秒；上游更新通常会在缓存期后自动生效。
- 合成的 c.js 使用 `Cache-Control: no-store`，即使上游字节命中缓存也会为每次请求重新生成。
- 刷新上游失败时，如果存在旧缓存则使用 stale 缓存；完全无法获得上游内容时，脚本端返回 fail-open 脚本，原请求/响应继续通过。
- 模块生成失败则返回 502，避免 Surge 用错误内容替换已安装的模块。

BiliMerge 只在获取模块和脚本时完成构建，**不会作为 Bilibili 请求代理**。

## 决策

| 项目 | 行为 |
|---|---|
| 上游版本 | GitHub latest 入口动态解析，不固定版本 |
| 存储 | 无 KV / D1；只使用短 TTL Cache API |
| 配置 | `ADBlock.*`、`Global.*` 前缀拆分 |
| 合并顺序 | ADBlock 先，Global 后 |
| 静态页 | `/` 由 Worker Assets 托管 |
| 部署 | Wrangler，Worker 名 `bilimerge` |

## 本地开发

Node 24+：

```bash
npm_config_cache=$PWD/.npm-cache npm install
npm test
npm run dev
```

`npm test` 包含真实上游快照的解析、分诊、sgmodule 结构、Worker 缓存/fail-open，以及 Surge VM 模拟等价测试。gRPC 重叠 fixture 会先断言 ADBlock 实际删掉广告字段，再对比手工 A→B 串联与合并脚本。

## 部署

### Cloudflare Dashboard 直接绑定 GitHub（推荐）

无需 GitHub Actions 或在仓库保存 Cloudflare Token：

1. 打开 Cloudflare Dashboard → **Workers & Pages** → `bilimerge` → **Settings** → **Builds**。
2. 连接 GitHub，授权 Cloudflare 访问仓库后选择 `IamAbler/BiliMerge`。
3. 生产分支选择 `main`；根目录保持 `/`。
4. 构建命令填写 `npm ci && npm test`，保存并触发首次构建。

之后每次推送到 `main`，Workers Builds 会从仓库读取 `wrangler.jsonc` 并自动构建、部署 Worker。可在该 Worker 的 **Builds** 页面查看构建日志及回滚版本。

### Wrangler CLI（可选）

本地部署时，先通过 `npx wrangler login` 授权，或提供 API Token：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=... # 可选；Wrangler 可在有权限时自行发现
npm run deploy
```

部署后验证 `/`、`/bilimerge.sgmodule`、`/merged-request.js`、`/merged-response.js`。旧的 `/bili-adblock.sgmodule` 暂保留为兼容入口。上游更新会在缓存期后自动跟随，无需重新部署。

## 已知差异

- 重叠 URL 上两个上游块共享一次 Surge 脚本超时预算；当前上游只有一个 response overlap。
- 两块日志会在同一次脚本执行中交织。
- Surge UI 显示的是合并规则名，而不是两个原模块名。
- 超时后的上游异步副作用无法完全取消；合并脚本会忽略迟到的 `$done` 并对每次块调用使用输入副本。
