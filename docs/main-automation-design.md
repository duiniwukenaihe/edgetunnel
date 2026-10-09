# main 自动更新与授权发布

用户已确认 main 是自己的定制分支，要求自动同步、测试和推进 main，Cloudflare 发布须由本人授权。

上游 cmliu/edgetunnel/main → 获取原始 worker 与提交 SHA → 应用仓库内美国策略 → 验证生成一致性、认证/出口/订阅回归、语法 → 创建候选提交 → 无强推地原子更新 upstream-candidate 与 main → 构建固定提交发布包 → 等待 cloudflare-production 环境本人审核 → 发布到 naiops-us-github → 校验上线版本。

同步只更新原始 worker 快照、版本锁和生成 worker，不合并上游工作流、依赖或仓库设置。代码锚点不兼容、测试失败或 main 有并发改动均停止。普通 CI 没有 Cloudflare 密钥。发布从确定的 40 位 Git SHA 构建，批准的是该版本，不随等待期间 main 的后续提交改变。

旧项目 naiops-us 的 8000119 原因仍待平台说明；用户已授权在新项目 naiops-us-github 部署并迁移服务域名。后续 GitHub 发布开关保持关闭，保护环境 Token 尚待配置。环境审核人为 duiniwukenaihe，允许本人批准本人启动的运行，禁止管理员跳过审核，只允许 main；Cloudflare token 只放环境 Secrets。

本地测试与 GitHub Actions 实际运行分别记录；发布版本核对不能证明最终出口在美国或 ChatGPT 登录成功，这些需要获准上线后的真实客户端验收。
