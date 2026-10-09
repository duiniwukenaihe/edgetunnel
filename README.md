# naiops 美国主备定制版

基于 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel) 的 Cloudflare Pages 分支，面向 VLESS、SS 和 Mihomo/Clash Meta 客户端。`main` 保存本项目的定制策略：固定美国出口候选、主备按顺序尝试、全部失败时断开；上游更新经生成和测试后进入 main，Cloudflare 发布另行等待仓库所有者审批。

[![CI](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml/badge.svg)](https://github.com/duiniwukenaihe/edgetunnel/actions/workflows/ci.yml)

- [与上游的具体差异](docs/上游差异.md)
- [自动同步、测试与授权发布](docs/自动同步与授权发布.md)
- [上游版本锁](upstream/version.json)

## 与上游相比

| 项目 | 导入的上游版本 | 本分支 |
| --- | --- | --- |
| 出口设置 | ProxyIP、SOCKS5/HTTP 等多种配置和路径参数 | 固定美国主备候选，面板、KV、环境变量和 URL 反代设置不能覆盖该策略 |
| 出口顺序 | 按目标散列排序，支持配置并发拨号 | 固定主候选优先，反代拨号并发锁定为 1 |
| 全部失败 | 含可配置兜底路径 | 断开连接，不转为目标直连或其他出口 |
| 管理凭据 | 可用多个变量别名或 KEY/UUID 代替 ADMIN | 必须设置 ADMIN；KEY/UUID 不能代替管理员密码 |
| TCP 连接 | 依赖 request.fetcher.connect | 使用 cloudflare:sockets 的 connect |
| 原生订阅 | 多客户端格式，含外部订阅转换 | 本服务直接生成 Clash 和 VLESS/SS 通用订阅，不调用外部转换器 |
| 客户端自动切换 | 通用订阅行为 | Mihomo fallback：VLESS 优先、SS 备用，每 300 秒检查 |
| 健康与版本 | 无本分支版本接口 | /healthz 检查 ADMIN、KV 和发布提交编号 |
| 上游同步 | 原仓库同步工作流 | 获取明确上游提交、重应用定制策略、测试后原子更新 main |
| 发布 | 可通过 Pages 原生 Git 构建或上传 | GitHub Actions 打包固定提交，生产发布经过所有者审批 |

当前源码基于上游提交 [`a8ab11125ece`](https://github.com/cmliu/edgetunnel/commit/a8ab11125ece9bc27983f609a6359be81b21050c)。版本锁随同步更新；比较口径和对应源码见[差异文档](docs/上游差异.md)。

## 当前部署与验证

2026-10-09 的验收记录：

| 项目 | 结果 |
| --- | --- |
| Pages 项目 | naiops-us-github |
| 服务域名 | us.naiops.ccwu.cc，域名和证书 active |
| 已发布源码提交 | 9efa77852427d5fed7e3aba2cef9b089337dc956 |
| 真实 VLESS / SS 链路 | 均 HTTP 200、TLS 校验通过、出口 3.132.174.45、国家 US |
| 自动化测试 | 11 项 Python + 17 项 Node，共 28 项通过 |
| 故障切换 | 顺序、主失败和全失败已通过模拟回归；真实客户端故障切换未验收 |
| ChatGPT 登录 | 程序无登录探测返回 403；未进行账号登录验收 |
| 后续 GitHub 发布 | 准备流程已安装；发布开关关闭，保护环境 Token 尚待配置 |

这里的美国候选是固定列表，不是持续地理位置检测或自动全网优选。免费共享出口的国家、可用性和 IP 信誉可能变化；检测通过不能保证 ChatGPT 登录成功。

## 登录与客户端使用

打开 [管理登录页](https://us.naiops.ccwu.cc/login)，使用 Cloudflare 中的 ADMIN 密码。面板 UUID 是节点凭据；ADMIN 不是 SS 节点密码。密码、UUID 和完整订阅 token 不写入本仓库。

使用完整私密订阅地址，保留其 token，再选择以下参数：

| 客户端 | 订阅参数 | 使用方法 |
| --- | --- | --- |
| Mihomo / Clash Meta | target=clash | 添加 URL 订阅，启用配置，选择“美国故障切换”，打开系统代理或 TUN |
| v2rayA / VLESS 客户端 | target=mixed&protocol=vless | 导入订阅、更新、选择 US-VLESS，然后开启客户端代理 |
| SS 客户端 | target=mixed&protocol=ss | 导入订阅或单条 ss:// 链接，客户端必须支持 v2ray-plugin WebSocket + TLS |

旧版 Clash 不支持这份完整 VLESS 配置。SS 默认 aes-128-gcm、端口 443，插件 path 为 `/?enc=aes-128-gcm`，TLS 开启、mux 关闭。通用订阅只提供节点，不会自动为所有客户端开启代理或协议切换。

本分支不原生输出 Sing-box、Surge 等格式；请求这些格式返回 400。上游其他协议实现仍留在源码中，但未作为本分支原生订阅的交付或实测支持。管理页面沿用上游页面，部分反代和订阅选项不会覆盖这里的定制策略。

## 自动切换的两层行为

服务端固定先拨号 `3.132.174.45:443`，失败后尝试 `192.3.208.192:443`；全部失败则断开。ChatGPT 及登录相关域名使用同一候选顺序。切换由 TCP 拨号失败触发，不会根据 HTTP 403 自动更换出口。

Mihomo 配置另有“美国故障切换”组，先选 VLESS，失效时选择 SS；两种协议共用一个 Pages 项目。健康检测为 `https://www.cloudflare.com/cdn-cgi/trace`，要求 HTTP 200，每 300 秒检查，没有 DIRECT 兜底。

连接客户端后，在同一代理浏览器打开检测地址确认 `loc=US`，再验证 ChatGPT 页面和账号登录。真实故障切换和账号登录仍需另行验收。

## Cloudflare 配置与发布

当前发布目标是 Pages 项目 **naiops-us-github**。必需配置如下，值在 Cloudflare 设置中维护：

| 配置 | 类型 | 要求 |
| --- | --- | --- |
| ADMIN | 机密环境变量 | 强管理员密码；缺失时服务返回 503 |
| HOST | 文本环境变量 | us.naiops.ccwu.cc |
| KV | KV 绑定 | 绑定配置存储命名空间，变量名为 KV |
| fail_open | 部署配置 | false |

生产和预览应分别核对这些配置；修改变量后需要重新部署才能用于运行环境。可选 UUID/KEY 仍用于节点身份派生，不能替代 ADMIN；变更相关凭据后需重新确认节点和订阅地址。

后续发布入口：GitHub Actions → **Release after owner approval**。prepare 按明确的 40 位 main 提交生成部署 ZIP、来源记录和 SHA256；启用发布后，deploy 在 cloudflare-production 环境等待所有者审核。main 在等待期间更新，不会改变已经待审批的包。

一次性启用需要在保护环境配置 `CLOUDFLARE_API_TOKEN`，再把仓库变量 `CLOUDFLARE_DEPLOY_ENABLED` 设为 true。每次真实发布仍须审核；[详细操作](docs/自动同步与授权发布.md)说明了权限、附件下载和批准步骤。

应上传工作流生成的部署 ZIP，而非整个 GitHub 源码压缩包或上游 main.zip。Pages 原生自动构建不会执行这套人工审批流程；当前采用 GitHub Actions → Wrangler → Pages。

旧项目 naiops-us 保留，其 8000119 限制原因尚未由平台说明，原生 Git 自动构建已暂停；当前服务域名已迁移到新项目。

## 同步、修改与测试

每日北京时间约 08:20，同步工作流获取 cmliu/edgetunnel/main。只更新上游 worker 快照、版本锁和生成 worker，保留本项目 README、工作流与策略。上游没有更新时不会生成新提交。

新增版本经验证后，一次原子推送更新 upstream-candidate 与 main，不强制推送；随后触发发布准备。代码锚点变化、许可证变化、测试失败或 main 并发更新时停止。GitHub 定时任务可能延后。不要用 Sync fork 将完整上游覆盖到本项目 main。

定制策略主要位于 [policy/us-only.js](policy/us-only.js)，出口常量和生成规则位于 [scripts/apply-us-policy.py](scripts/apply-us-policy.py)。修改后重新生成并运行验证：

```sh
python3 scripts/apply-us-policy.py upstream/_worker.js _worker.js
bash scripts/verify.sh
```

只修改生成的 _worker.js 会被一致性检查拒绝。普通 CI 不读取 Cloudflare 密钥；测试检查策略、认证、订阅、生成一致性、审批规则和准确版本号，不能代替真实出口或账号登录验收。

| 路径 | 用途 |
| --- | --- |
| upstream/_worker.js、upstream/version.json | 原始源码快照、导入提交和 SHA256 |
| policy/us-only.js、scripts/apply-us-policy.py | 本项目定制策略及生成入口 |
| _worker.js | 生成后的部署源码 |
| tests/、scripts/verify.sh | 回归和验证入口 |
| .github/workflows/ci.yml、sync.yml、deploy.yml | 测试、同步、审批发布 |
| scripts/build-release.py、check-live-release.py | 固定版本打包、上线版本核对 |

## 来源与许可证

本项目沿用仓库 [LICENSE](LICENSE)，基于 cmliu/edgetunnel 的相关实现。原作者、上游引用项目及通用功能说明见[固定上游版本的 README](https://github.com/cmliu/edgetunnel/blob/a8ab11125ece9bc27983f609a6359be81b21050c/README.md)。使用本分支时，以这里的定制行为和验证范围为准。
