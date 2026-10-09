# naiops 自动区域出口定制版

基于 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 的 Cloudflare Pages 分支，支持 VLESS、SS 和 Mihomo/Clash Meta。默认美国，支持自动发现候选、检测真实国家与过期更新；管理员在我们的面板配置其他地区的手动候选。代理只使用所选地区的有效检测结果，全部失败断开，不直连、不跨区。

**自动出口版本目前待云端验收，请勿用于替换生产版本。** 本地运行时仅用泛化连接错误表示证书域名拒绝；新代码不会把普通断线当作证书证明，因此严格检测池暂无法启用。代码测试通过不表示可上线。详见[自动出口验收记录](docs/自动出口验收.md)。

[![CI](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml)

- [与上游的差异](docs/上游差异.md)
- [同步、测试与手动发布](docs/自动同步与授权发布.md)
- [自动出口设计](docs/superpowers/specs/2026-10-09-auto-us-design.md)
- [区域设计](docs/superpowers/specs/2026-10-09-region-panel-design.md)
- [上游版本锁](upstream/version.json)

## 管理地区与出口

新版本发布后打开 `/login`，使用 Cloudflare 中已有 ADMIN 密码登录；`/admin` 会进入我们的 `/admin/regions` 页面。原管理页面保留在 `/admin/settings`。

1. 未保存配置时初始只有 US 美国，并开启 `proxyip.us.cmliussss.net` 自动来源；两条旧 IP 作为手动候选。来源中的 US 字样不作为国家证明。已有版本 1 配置保留手动模式，不在读取时写回或悄悄开启自动发现。
2. 美国地区可开启自动发现，其他地区当前使用手动候选。填写唯一的两位大写代码、名称和公共 `IP:443`，IPv6 用 `[IPv6]:443`。每区最多 8 个手动候选，最多 16 个地区；未开启自动来源时至少填写一个。旧配置的非公共地址或非 443 端口需在面板修正后才能使用。
3. 可以修改默认地区、出口顺序或删除地区。默认地区必须存在，至少保留一个地区。
4. 保存后更新客户端订阅。KV 在不同机房的传播可能需要约一分钟；已有连接继续使用原出口。删除地区后，旧节点会被拒绝，不会自动改走其他地区。
5. 保存后在“出口检测”选择地区，读取当前边缘的状态或立即刷新，查看真实出口国家、IP、检测时间与失败原因。首次检测可能需要最多约 12 秒；强制刷新间隔至少 60 秒。
6. 在同一代理客户端打开 `https://www.cloudflare.com/cdn-cgi/trace`，检查 `loc` 和实际 IP，再验证需要的网站与 ChatGPT 登录。

配置单独保存到已有 KV 的 `regions.json`，不改变 ADMIN、HOST、UUID 或旧 `config.json`。未保存时默认美国；损坏配置或存储不可用时拒绝代理，不静默回落。页面提示读取错误时可以编辑并保存有效配置修复。修改地区配置不需要重新发布代码。

保存地区配置只增加候选，不能直接启用出口。认证后的代理新拨号、订阅请求和管理刷新可以触发检测：固定 DNS 来源与手动候选去重，最多 32 个候选，每轮检测最多 4 个、并发 2。通过原生 TLS 获取 Cloudflare trace，实际 loc 必须匹配所选地区；证书反向校验无明确证据时拒绝启用。健康主出口优先保留，国家变化立即剔除。

有认证请求时每 15 分钟更新，证据 30 分钟过期；无请求时暂停。临时网络故障可保留仍有效的旧证据，但不延长检测时间或到期时间。每次重新拨号与重试都会重新检查有效期，已有 TCP 连接继续。缓存独立于配置，按版本、域名、Cloudflare 边缘、地区及候选配置隔离；同一实例合并并发刷新，KV 不提供分布式锁。本分支不做全网扫描，也不保证 ChatGPT 登录成功，HTTP 403 不会触发服务器换 IP。

## 客户端与自动切换

面板提供含私密 token 的完整订阅地址，可选择全部地区或单一地区。不要公开地址、UUID 或密码。

| 客户端 | 参数 | 行为 |
| --- | --- | --- |
| Mihomo / Clash Meta | target=clash，可选 region=US | “地区选择”默认排在首位的是默认地区；每区 VLESS 优先、SS 备用 |
| v2rayA / VLESS 客户端 | target=mixed&protocol=vless，可选 region=US | 导入订阅并选择对应地区节点，开启客户端代理 |
| SS 客户端 | target=mixed&protocol=ss，可选 region=US | 需支持 v2ray-plugin WebSocket + TLS |

未指定订阅 region 时包含全部配置地区，默认地区排第一；指定后只包含该地区。节点路径包含固定 region，所以更改默认地区不会悄悄改变已有节点的地区。未指定 region 的旧代理连接使用当前默认地区；未知、空或重复参数返回 400。

服务器每个连接按该地区的出口顺序尝试，拨号全部失败则关闭连接。Mihomo 在每区 VLESS/SS 之间检查连通性：Cloudflare trace、HTTP 200、每 300 秒检查，没有 DIRECT。地区选择组不会自动跨区切换。通用订阅不替所有客户端配置自动协议切换。

本分支代理仅支持 TCP，UDP/DNS 隧道请求会被关闭，避免绕过地区出口。SS 默认 aes-128-gcm，端口 443，WSS/TLS 开启、mux 关闭，插件 path 同时包含 enc 和 region。旧版 Clash 不支持完整 VLESS 配置。仅原生提供 Clash/mixed，其余订阅格式返回 400，不发送节点凭据到外部转换器。

## 当前项目与发布

保留现有 Pages 项目 **naiops-us-github**、域名 **us.naiops.ccwu.cc** 和已有 KV，不新建 Cloudflare 项目。此项目采用直接上传，名字带 GitHub 不表示原生仓库绑定。直接上传项目无法追加原生 Git 连接，见 [Cloudflare 限制](https://developers.cloudflare.com/pages/get-started/direct-upload/)。

| 配置 | 位置与用途 |
| --- | --- |
| ADMIN | Cloudflare 机密环境变量，管理员登录；缺失返回 503 |
| HOST | Cloudflare 文本变量，当前 us.naiops.ccwu.cc |
| KV | Cloudflare KV 绑定，变量名 KV；保存项目与区域配置 |
| fail_open | 当前部署配置 false |

ADMIN 不是 SS 节点密码。UUID/KEY 可用于节点身份派生，但不能替代 ADMIN。旧管理页的用量查询 API 凭据不等于 GitHub 发布授权；默认手动发布无需创建或配置任何 Cloudflare API Token。

默认流程：**GitHub Actions 手动测试打包 → 下载部署 ZIP → 登录 Cloudflare 当前项目上传 → 你点击 Save and Deploy**。

打开 [Prepare release (manual)](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/deploy.yml)，点 Run workflow，选择 main，revision 可留空。运行成功后下载 `naiops-release-提交编号` 附件；解开下载的外层附件 ZIP，再上传其中的 **naiops-us-pages.zip**。附带 `release-manifest.json` 记录准确版本和 worker SHA256。不要上传 GitHub 源码 ZIP 或整个外层附件。

在当前 Cloudflare 项目选择 Create a new deployment → Production → 上传部署 ZIP → Save and Deploy。发布后 `/healthz` 的 revision 应与清单一致。完整步骤见[发布说明](docs/自动同步与授权发布.md)。

可选 GitHub 自动上传仍默认关闭。只有主动配置保护环境 Token 并开启 CLOUDFLARE_DEPLOY_ENABLED，才会进入要求所有者批准的 deploy job；本轮不配置 Token、不启用此开关。测试和下载包不会读取 Cloudflare 凭据。

## 同步、修改与测试

`main` 是我们的定制版本。每天北京时间约 08:20 自动获取锁定来源的上游更新、应用本地策略并测试，通过后原子更新 upstream-candidate 和 main；不强制推送，不触发发布。计划任务可能延后。不要使用 Sync fork 将整份上游覆盖到定制 main。

区域策略在 [policy/regions.js](policy/regions.js)，发现与验证逻辑在 [policy/auto-exits.js](policy/auto-exits.js)，页面在 [policy/regions.html](policy/regions.html)，生成入口保留原名 [scripts/apply-us-policy.py](scripts/apply-us-policy.py)。修改这些来源文件后：

```sh
python3 scripts/apply-us-policy.py upstream/_worker.js _worker.js
bash scripts/verify.sh
```

只改生成的 `_worker.js` 会被一致性校验拒绝。同步只更新原始 worker、版本锁和生成 worker，保留我们的策略、页面、文档和工作流。锚点变化、许可证变化、测试失败或并发更新时停止。

## 验证范围

自动出口版本已通过来源与生成一致性、语法检查和 15 项 Python、65 项 Node 回归，包括真实协议解析器的认证拒绝、国家变化、重试过期、缓存隔离、限流和关闭行为。Socket 边界模拟不代表真实免费出口可用性。

`tests/native-tls-runtime.cjs` 使用独立 workerd 和本地 CA 夹具调用生产检测函数：正确证书返回 US trace，错误域名与不可信证书均拒绝；完整出口验证因错误信息不明确而正确失败关闭。测试仅更换 Socket 目标为受控本地服务器，不连接真实免费出口。运行方式：

```sh
WORKERD_BINARY=/path/to/workerd node tests/native-tls-runtime.cjs /external/path/report.json
```

报告中的 `safetyTestsPassed` 与 `runtimeReady` 必须分别检查；前者为 true 不代表后者为 true。云端必须另外验证正确/错误域名行为及真实 VLESS/SS 美国出口。Cloudflare 存在尚未关闭的 [expectedServerHostname 问题](https://github.com/cloudflare/workerd/issues/6903)，不通过时不得关闭证书验证或发布。

上次线上核对记录为固定美国版本 `9efa77852427d5fed7e3aba2cef9b089337dc956`，此次自动版本未上线；当前授权续期失败，浏览器会话检查超时，未重新读取线上状态。本次页面浏览器验收、真实客户端切换及 ChatGPT 账号登录均未完成。

## 来源与许可证

沿用 [LICENSE](LICENSE)。原作者和通用实现参考[固定上游 README](https://github.com/cmliu/edgetunnel/blob/a8ab11125ece9bc27983f609a6359be81b21050c/README.md)。原始 worker 快照和 SHA256 保存在 upstream/，用于可重复生成；原上游的其他协议实现仍保留，已交付的原生订阅与实测协议为 VLESS/SS。
