# 区域管理与无 Cloudflare 密钥发布

用户已选择管理面板维护区域，并要求继续按设计完成 GitHub 版本、保留现有 Cloudflare 项目。默认发布方式为 GitHub 手动测试打包，用户登录 Cloudflare 上传并确认发布；不创建项目，不配置发布 Token，不迁移域名。

## 区域配置

新增本服务托管的 `/admin/regions` 页面，登录后 `/admin` 引导到该页面；原管理页面保留在 `/admin/settings`。沿用现有 ADMIN Cookie 认证。新增 `/admin/regions.json` GET/POST，配置单独保存在已有 KV 的 `regions.json`，不改变 ADMIN、UUID、HOST 或旧 config.json。

数据为 `{version:1,defaultRegion:"US",regions:[{code:"US",name:"美国",exits:["3.132.174.45:443","192.3.208.192:443"]}]}`。未保存时使用此默认值；损坏的已保存数据返回 503，不能静默使用默认值。管理员可添加、编辑、删除区域、选择默认区域并调整出口顺序。最多 16 个区域，每个区域 1–8 个不同的 IPv4:port 或 [IPv6]:port。区域代码为唯一的两位大写字母，名称非空且唯一、最多 32 字符，端口为 1–65535，默认区域必须存在。无效提交返回 400，旧数据不变。写入需同源 Origin 和 JSON 类型；KV 读取和写入失败返回 503。

区域名称和代码为管理员标记，保存不证明 IP 的地理位置、可用性或 ChatGPT 登录能力。初始美国候选沿用已实测列表；不预置其他国家的假地址，不添加全网优选、自动下载公共出口或持续地理检测。

## 代理与订阅

代理请求以 `region=US` 选择已配置区域，未提供时选当前默认区域。未知、空或重复 region 参数返回 400；配置存储故障返回 503。无论 URL、旧面板、旧 config.json 或 PROXYIP 环境变量如何设置，只使用已选区域池，依次主备，全部 TCP 拨号失败断开，不直连、不跨区。区域配置和代理上下文为每个请求的局部值。

订阅未指定 region 时包含所有配置区域，默认区域排第一；指定时只输出对应区域。VLESS 和 SS 的 WebSocket path 明确包含 region，SS 同时保留 enc、WSS/TLS 和 mux=false。Mihomo 提供默认优先的地区选择组和每区 VLESS/SS fallback 组；健康检查沿用 HTTP 200 的 Cloudflare trace，每 300 秒检查，不包含 DIRECT。通用客户端的自动选择行为取决于客户端；服务器内的出口主备独立生效。HTTP 403 不触发服务器换 IP。

## 发布边界

`main` 仍自动同步上游并执行测试，不能自动上线。`deploy.yml` 改为仅 workflow_dispatch：指定 main 的固定提交，测试后生成 ZIP 与清单。普通打包不获取 Cloudflare 凭据。取消上游同步后自动触发发布工作流的动作。

默认 CLOUDFLARE_DEPLOY_ENABLED=false，发布包用于现有 naiops-us-github 项目的 Create a new deployment，用户的 Save and Deploy 为本次上线授权。可选 Token 自动上传及 cloudflare-production 所有者审核继续保留，未配置时不执行；Token 不放 KV。手工上传不会自动执行 Actions 的上线 SHA 检查，需发布后访问 /healthz 对照 release-manifest.json。

## 验收

先观察新增测试失败，再实现：默认美国、区域保存/读取、认证和同源限制、无效保存不覆盖、KV 故障、未知地区、并发请求不串线、不同区域主备/全部失败、VLESS/SS/Mihomo 路径一致。执行来源校验、全部回归、语法校验；独立审查后推送 PR，GitHub CI 成功后合并 main。区域页面通过真实浏览器的本地请求处理器检查加载、编辑、保存和订阅展示，不把该检查当成 Cloudflare 上线验收。

本轮 GitHub 交付完成不等于 Cloudflare 已发布；地区真实出口、真实客户端故障切换和 ChatGPT 账号登录仍需上线后验收。
