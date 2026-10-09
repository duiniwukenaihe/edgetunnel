# naiops 国家与子区域自动出口定制版

基于 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 的 Cloudflare Pages 分支，支持 VLESS、SS 和 Mihomo/Clash Meta。默认美国，支持自动发现候选、检测真实国家与过期更新；自动发现美国、日本、新加坡、香港、德国、英国候选；美国提供自动、东部、中部、西部入口，新加坡和香港等保持单一入口。用户只选择地区，无需维护 IP。代理只使用所选地区的有效检测结果，全部失败断开，不直连、不跨区。

**此前国家级版本的六地区预览已通过云端国家检测与 VLESS/SS 共 12 项真实代理验收；这不是新增美国子区域的云端验收。** 当前正式部署版本请以 `/healthz` 的 revision 为准。新增子区域的状态和验证步骤见[美国子区域验收](docs/美国子区域验收.md)。检测以本项目签名回执认证观测地理信息。

[![CI](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml)

- [与上游的差异](docs/上游差异.md)
- [同步、测试与手动发布](docs/自动同步与授权发布.md)
- [自动出口设计](docs/superpowers/specs/2026-10-09-auto-us-design.md)
- [区域设计](docs/superpowers/specs/2026-10-09-region-panel-design.md)
- [美国子区域设计](docs/superpowers/specs/2026-10-09-us-subregions-design.md)
- [上游版本锁](upstream/version.json)

## 管理地区与出口

新版本发布后打开 `/login`，使用 Cloudflare 中已有 ADMIN 密码登录；`/admin` 会进入我们的 `/admin/regions` 页面。原管理页面保留在 `/admin/settings`。

1. 首页显示地区入口的状态、有效出口数量、最近检测时间和订阅地址。美国分为“美国自动”“美国东部”“美国中部”“美国西部”，新加坡等保持一个自动入口。默认美国自动。
2. 复制适合客户端的订阅：Mihomo / Clash Meta 或 VLESS / v2rayA。可以订阅全部入口或单个入口。默认六国家共九个入口：VLESS 九条、SS 九条，Mihomo 九个地区组、十八条协议节点。
3. 地区未检测、已过期或缺少定位时，面板显示原因。选择地区刷新会更新它共享的国家候选池；不能保证每个美国子区域都有免费可用候选。
4. 地区配置和候选明细在高级详情中。保存配置后更新客户端订阅；修改名字不会改变候选的实测地理分类。
5. 强制刷新间隔至少 60 秒，每轮最多检测 4 个候选；国家内轮询并合并仍有效的备用，不需要手动输入 IP。有认证请求时每 15 分钟更新；无人访问时不会定时运行。
6. 在实际使用该代理的客户端打开 `https://www.cloudflare.com/cdn-cgi/trace`，检查 `loc=US` 和实际 IP。这个页面只显示国家，无法证明美东/美西；子区域应对照面板中的签名州代码与本项目分区规则，再验证目标网站与 ChatGPT 登录。

配置单独保存到已有 KV 的 `regions.json`，不改变 ADMIN、HOST、UUID 或旧 `config.json`。未保存时默认美国；损坏配置或存储不可用时拒绝代理，不静默回落。首次读取失败时可点击“从默认国家开始修复”，检查草稿后保存；普通重读失败保留已有编辑内容。修改地区配置不需要重新发布代码。

保存地区配置只增加候选，不能直接启用出口。认证后的代理新拨号、订阅请求和管理刷新可以触发检测：固定 DNS 来源与手动候选去重，每国家最多 32 个候选，每轮检测最多 4 个、并发 2。美国三个子区域共享同一个美国发现和检测池。通过候选访问当前项目的固定签名回执接口，实际国家必须匹配所选国家，子区域还需匹配签名回执中的州代码。州代码和城市纳入 HMAC 签名；缺少或未知州代码的美国出口只能进入美国自动。签名、每次随机 nonce、域名、发布 SHA 和时效均需正确；TLS 握手或未签名国家声明不能直接启用出口。首次按检测延迟优选，后续优先保留健康主出口，减少登录期间频繁换 IP；国家变化立即剔除。

有认证请求时每 15 分钟更新，证据 30 分钟过期；无请求时暂停。临时网络故障可保留仍有效的旧证据，但不延长检测时间或到期时间。每次重新拨号与重试都会重新检查有效期，已有 TCP 连接继续。缓存独立于配置，按版本、域名、Cloudflare 边缘、国家及候选配置隔离；子区域按每条出口的地理证据和有效期筛选共享国家池；同一实例合并并发刷新，KV 不提供分布式锁。本分支不做全网扫描，也不保证 ChatGPT 登录成功，HTTP 403 不会触发服务器换 IP。

## 客户端与自动切换

地区入口统一显示为 `Naiops-US · 美国自动`、`Naiops-US-EAST · 美国东部`、`Naiops-JP · 日本自动` 等，不导出底层候选 IP 编号列表。Mihomo 的“地区选择”只列地区组，各组保留 VLESS/SS 协议容错。v2rayA 只需导入 VLESS 订阅并选择地区入口，无需为本服务配置多 IP 分组。

面板提供含私密 token 的完整订阅地址，可选择全部地区或单一地区。不要公开地址、UUID 或密码。

| 客户端 | 参数 | 行为 |
| --- | --- | --- |
| Mihomo / Clash Meta | target=clash，可选 region=US | “地区选择”默认排在首位的是默认地区；每区 VLESS 优先、SS 备用 |
| v2rayA / VLESS 客户端 | target=mixed&protocol=vless，可选 region=US | 每个地区一个命名入口，区内候选优选与故障切换由服务端完成 |
| SS 客户端 | target=mixed&protocol=ss，可选 region=US | 需支持 v2ray-plugin WebSocket + TLS |

未指定订阅 region 时包含全部配置地区，默认地区排第一；指定后只包含该地区。节点路径包含固定 region，所以更改默认地区不会悄悄改变已有节点的地区。未指定 region 的旧代理连接使用当前默认地区；原有 `region=US` 继续表示美国自动；`region=US-EAST`、`US-CENTRAL`、`US-WEST` 分别锁定美国子区域。未知、空或重复参数返回 400。

服务器每个连接按该地区的出口顺序尝试，拨号全部失败则关闭连接。Mihomo 在每区 VLESS/SS 之间检查连通性：Cloudflare trace、HTTP 200、每 300 秒检查，没有 DIRECT。地区选择组不会自动跨区切换。通用订阅不替所有客户端配置自动协议切换。

本分支代理仅支持 TCP，UDP/DNS 隧道请求会被关闭，避免绕过地区出口。SS 默认 aes-128-gcm，端口 443，WSS/TLS 开启、mux 关闭，插件 path 同时包含 enc 和 region。旧版 Clash 不支持完整 VLESS 配置。仅原生提供 Clash/mixed，其余订阅格式返回 400，不发送节点凭据到外部转换器。

### 美国子区域规则

本项目以出口 IP 的地理信息分类，Cloudflare `colo` 是接入边缘机房，不用它推断出口位置。地理信息可能缺失或有误差，不代表物理机位置证明。规则如下：

| 子区域 | 美国州代码 |
| --- | --- |
| 西部 | AK AZ CA CO HI ID MT NM NV OR UT WA WY |
| 东部 | CT DE DC FL GA MA MD ME NC NH NJ NY PA RI SC VA VT WV |
| 中部 | AL AR IA IL IN KS KY LA MI MN MO MS ND NE OH OK SD TN TX WI |

州代码缺失或不在上表时，只计入美国自动；子区域没有有效出口时失败关闭，不回落到美国自动。其他大国只有补齐可靠地理分类与实际候选后才细分，本轮只实现美国。

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

本次美国子区域版本已通过来源与生成一致性、语法检查和 15 项 Python、109 项 Node 回归，包括认证拒绝、州信息签名、共享国家池、订阅数量、立即撤销、重试过期、缓存隔离、限流和页面交互。Socket 边界模拟不代表真实免费出口可用性。

`tests/native-tls-runtime.cjs` 使用独立 workerd 和本地 TLS 1.3 服务，运行真实上游 TLS 代码与生产回执校验：共 11 项：正确签名美国西部成功，非美国、伪造、过期、旧 nonce、错误域名/版本、州代码篡改和错误子区域拒绝；缺失或未知州代码只允许国家自动。测试仅映射 Socket 目标，不连接真实免费出口。回执以 现有 KV 中独立随机 32 字节 HMAC 密钥认证；不依赖探测传输的证书认证，探测只发送非秘密随机值。真实客户端的目标 TLS 校验保持原样。运行方式：

```sh
WORKERD_BINARY=/path/to/workerd node tests/native-tls-runtime.cjs /external/path/report.json
```

报告中的 `safetyTestsPassed` 与 `runtimeReady` 必须分别检查；前者为 true 不代表后者为 true。云端必须另外验证签名回执及真实 VLESS/SS 美国出口。原生域名参数问题参考 [Cloudflare issue](https://github.com/cloudflare/workerd/issues/6903)；签名回执设计见[检测修复设计](docs/superpowers/specs/2026-10-09-cloud-exit-proof-design.md)。

本轮复用现有 Chrome，使用明确标注的本地测试数据检查桌面与窄屏页面。新增美国子区域尚未发布到 Cloudflare；线上候选可用性、真实客户端导入/切换以及 ChatGPT 登录均为 NOT_RUN。此前国家级验收是历史证据，不能代替这版的云端验收。

## 来源与许可证

沿用 [LICENSE](LICENSE)。原作者和通用实现参考[固定上游 README](https://github.com/cmliu/edgetunnel/blob/a8ab11125ece9bc27983f609a6359be81b21050c/README.md)。原始 worker 快照和 SHA256 保存在 upstream/，用于可重复生成；原上游的其他协议实现仍保留，已交付的原生订阅与实测协议为 VLESS/SS。
