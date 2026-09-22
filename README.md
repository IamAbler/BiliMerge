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
https://bilimerge.<你的-workers.dev-子域>.workers.dev/bili-adblock.sgmodule
```

模块会指向同源的 `/merged-request.js`、`/merged-response.js`。它将 ADBlock 配置改为 `ADBlock.*` 前缀、Global 配置改为 `Global.*` 前缀，因此两套 `LogLevel` 可独立设置，BoxJS Map Local 条目仍被保留。

## 架构

- 每次脚本或模块请求都解析两个 `releases/latest/download/*.sgmodule`。
- 上游 sgmodule / bundle 字节用 Cloudflare Cache API 缓存 600 秒；合成的 c.js 永远 `no-store`，每次重新生成。
- c.js 仅内嵌上游源码，不发网络请求。它以 `AsyncFunction` 独立运行两个裸 bundle，利用作用域遮蔽捕获各自 `$done`，最外层仅调用一次真实 `$done`。
- 根据原始 A/B pattern 分诊。重叠 URL 顺序为 ADBlock → Global；二进制响应按 Surge 的 `bodyBytes`/`Uint8Array` 约定交接。
- sgmodule 的重叠触发规则会收敛成一条，避免 Surge 对同一 URL 启动合并脚本两次。
- 上游拉取、解析或生成失败时，脚本端返回合法 fail-open 脚本（HTTP 200）；sgmodule 更新失败返回 502，避免替换用户已有模块。

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

提供以下环境变量后执行：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=... # 可选；Wrangler 可在有权限时自行发现
npm run deploy
```

部署后验证 `/`、`/bili-adblock.sgmodule`、`/merged-request.js`、`/merged-response.js`。上游更新会在缓存期后自动跟随，无需重新部署。

## 已知差异

- 重叠 URL 上两个上游块共享一次 Surge 脚本超时预算；当前上游只有一个 response overlap。
- 两块日志会在同一次脚本执行中交织。
- Surge UI 显示的是合并规则名，而不是两个原模块名。
- 超时后的上游异步副作用无法完全取消；合并脚本会忽略迟到的 `$done` 并对每次块调用使用输入副本。
