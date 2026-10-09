# 云端签名出口检测实施计划

> 使用 executing-plans 在本会话逐项实现；完成关键阶段请求只读代码审查。

**Goal:** 修复云端候选检测，在预览验证美国真实代理，然后增加自动多地区来源。

**Architecture:** 独立 exit-proof.js 认证 Cloudflare 观测元数据；auto-exits.js 负责有界传输、发现和缓存；生成脚本通过现有上游锚点接入固定回执路由。

**Tech Stack:** 原有 WebCrypto、Cloudflare sockets、上游 TlsClient、Node 内置测试与已缓存 workerd，无新增依赖。

## 约束

默认美国，只在所选地区自动切换；无有效池则断开。保持现有项目、KV、域名和密码。不新增 GitHub Cloudflare 密钥。磁盘约 12 GiB，仅定向测试。正式发布必须通过真实云端和 VLESS/SS。

### 1. 回执认证

- [x] tests/exit-proof.test.cjs 先证实接口缺失失败。
- [x] policy/exit-proof.js 实现处理出口回执(request, env) 与验证出口回执(receipt, env, request, nonce, code)。
- [x] scripts/apply-us-policy.py 接入固定路由并重新生成 _worker.js。
- [x] 错误密钥、签名、国家、nonce、域名、SHA、时效、边缘元数据与方法负例通过。

### 2. 有界候选传输与真实运行时

- [x] 测试 HTTP JSON/分块解析、取消与关闭、真实上游 TLS 正确 SNI。
- [x] 在 auto-exits.js 新检测传入 env/request，只发送随机 nonce，收到响应立即校验签名。
- [x] 将缓存验证属性切换至 proofVerified，拒绝旧验证格式；保留国家变化撤销与失败期限。
- [x] 受控 native workerd 真实 TLS 回执通过，伪造/过期/非美国拒绝。
- [ ] 独立审查、全部轻量回归、生成与语法检查后提交，并部署同项目预览。
- [ ] 当前预览实际美国检测、VLESS/SS 出口通过，保留证据；失败则继续定位，不发布。

### 3. 多地区自动来源与验收

- [ ] 从维护者源码和实际 DNS 核实候选来源目录，每区自动发现，用户只选择地区。
- [ ] 默认美国并提供常用地区目录；空池、来源错误、检测失败分别显示，不声称所有国家都有免费资源。
- [ ] 先写来源解析、地区隔离、失效与无手工候选测试，再实现目录与面板。
- [ ] 多地区云端检测与真实客户端验收；通过后按已有发布授权更新现有生产项目，并回读 SHA/域名/绑定。
