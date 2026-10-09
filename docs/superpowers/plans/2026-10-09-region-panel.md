# Region Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 完成可维护的区域面板、区域内代理与订阅，以及无需 Cloudflare 密钥的手动打包流程。

**Architecture:** 生成脚本将区域策略和自托管 HTML 合入上游 worker。认证后的管理接口写独立 KV 配置；每个代理请求读取并选择局部区域池。发布保留现有项目且默认只生成审核包。

**Tech Stack:** Cloudflare Pages/KV/Sockets、原生 JavaScript、Python unittest、Node test、GitHub Actions；不新增依赖。

## Global Constraints

- 默认 US；无已保存配置时沿用两个实测候选；损坏配置返回 503。
- 最多 16 个区域，每个区域 1–8 个不同的 IP:port；不允许任意 URL 反代覆盖。
- 主备按顺序，全部失败断开，不直连、不跨区；每请求使用局部上下文。
- ADMIN Cookie 认证；JSON 写入要求同源 Origin；失败保存不覆盖旧值。
- 当前项目 naiops-us-github、域名和 KV 保留；不发布 Cloudflare、不录入 Token。
- 回归和语法检查串行执行，不安装依赖；临时产物在系统临时目录。

## Task 1: 区域存储和代理选择

Files: `policy/regions.js`、`scripts/apply-us-policy.py`、`tests/helpers/worker.cjs`、`tests/regions.test.cjs`、生成 `_worker.js`。

Interfaces: `读取区域配置(env)` 返回验证后的配置；`选择区域(config, url)` 返回单一区域；`反代参数获取(url, uuid, defaultIP, fallback, env)` 返回现有上游代理上下文。

- [x] 提取已有 VM 测试装载器，不改变其 Socket 模拟；新增默认、未知地区、无效 KV 和并发测试。
  ```js
  const context = await s.反代参数获取(new URL('https://us.naiops.ccwu.cc/?region=JP'), UUID, '', true, env);
  assert.equal(context.反代IP, '198.51.100.1:443,198.51.100.2:443');
  assert.equal(context.反代兜底, false);
  ```
- [x] 运行 `node --test tests/regions.test.cjs`，确认 JP 选择、存储或错误响应因缺少功能而失败。
- [x] 在 policy 实现配置验证和局部选择；生成器将两个代理入口的 env 传入，捕获带状态码错误返回 JSON。
- [x] 生成并重跑定向测试，再运行旧代理主备回归，确认不改变关闭行为。

## Task 2: 区域订阅与管理页

Files: `policy/regions.js`、`policy/regions.html`、生成脚本、`tests/regions.test.cjs`、`tests/us-only.test.cjs`、`tests/test_pipeline.py`。

Interfaces: `处理区域管理(request, env, url, host, uuid)` 返回 HTML/JSON；`生成区域Clash订阅(config, regions, selected)` 与 `生成区域通用订阅(config, protocol, regions, selected)` 返回本地订阅。

- [x] 新增真实 worker Cookie 登录后 GET/POST 测试，验证未登录拒绝、跨源拒绝、无效提交不写 KV、有效提交回读；新增订阅 region 路径测试。
  ```js
  const response = await request('/admin/regions.json', {method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(config)});
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(store.get('regions.json')).defaultRegion, 'JP');
  ```
- [x] 观察新增测试失败，再实现同源管理接口和 HTML 表单：区域列表、增删、默认地区、出口逐行输入、保存状态、复制订阅地址。
- [x] 管理 handler 插入既有 Cookie 校验后；/admin 引导到面板，/admin/settings 保留旧页。订阅数据使用局部变量，不共享区域状态。
- [x] 生成 worker；运行 `bash scripts/verify.sh`；使用已有浏览器检查真实 HTML 编辑/保存与错误提示。

## Task 3: 手动发布与文档

Files: `.github/workflows/deploy.yml`、`sync.yml`、`README.md`、`docs/自动同步与授权发布.md`、`docs/上游差异.md`、本计划和验收记录。

- [x] 增加工作流行为测试，确认发布仅 workflow_dispatch，上游同步不主动 dispatch 发布。
- [x] 改为 `on: {workflow_dispatch: {inputs: {revision: {required: false, type: string}}}}` 的现有等价缩进结构；保留准确 SHA 打包、可选关闭的 Token deploy 和所有者审核。
- [x] 文档写清 Run workflow → 下载 ZIP → 当前 Pages 项目 Create a new deployment → production → Save and Deploy → /healthz 对照 SHA。源代码 ZIP 不可代替发布包。
- [ ] `bash scripts/verify.sh`、差异检查和独立审查通过后，提交 scoped 文件、建立 PR、等待远程 CI，再合并 main；不触发 Cloudflare 部署。
