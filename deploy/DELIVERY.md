# Deployment targets 交付记录（task #8）

实施：Cindy（主会话 + codex-luna/spark 子代理）；方案：AstraHigh（task #7）。
分支：`feat/channel-workspaces-orchestra`。验收日期：2026-10-19。

## 提交

| commit | 内容 |
| --- | --- |
| 9623b6a | baseline：1.0.50 readonly-network 通信修复（4 文件） |
| beee651 | 显式 RAFT_DEPLOYMENT_TARGET（standard/lazycat）：启动/预检解析、懒猫认证路由按 target 挂载、`/api/auth/providers` 能力字段、Web LoginPage 运行时条件化 |
| 94842c8 | `scripts/deploy-target.mjs` 双目标构建/部署包装、`deploy/standard/` compose 与 nginx 示例、lzc-cli 版本门控（≥2.0.9）、懒猫清单去定值（__RAFT_APP_URL__、签名密钥出清单改文件持久化）、文档修正 |
| f916bc9 | 测试补齐：standard 无配置 HTTP、缺配置启动报错仅变量名、LoginPage 渲染断言 |
| （两笔 gitignore） | 忽略 .pi/、lazycat/.lzc-cli-cache/、deploy-artifacts/ |

## 构建产物与 digest（同一源码 commit `3b5e4dfa9ce2c49da45b3ce5656fc309bd7fa956`）

### standard（production compose smoke 实测）
- 产物摘要：`deploy-artifacts/standard-local-3b5e4dfa9ce2-1792381009097/artifact-manifest.json`
- server：`raft-standard-server:3b5e4dfa9ce2c49da45b3ce5656fc309bd7fa956-1792381009097`
  digest `sha256:05357e0ae85ccec1070dd5c511427936f042c4dc593dbe309d57838219f5ac6f`
- web：`raft-standard-web:3b5e4dfa9ce2c49da45b3ce5656fc309bd7fa956-1792381061890`
  digest `sha256:f17b6a0b44dd40fe35ce6454cccc3ff72fd8de31768f2256f9b3e2815150847b`
- RisingWave：`ghcr.io/risingwavelabs/risingwave:v2.8.0`
  arm64 manifest digest `sha256:b2833942edc6acf8c6cc8d0c6741dc4ee4346b6d604397259a6183e7aa749d03`（与 Docker Hub 同 tag 的 arm64 manifest 逐字节一致，层 digest 逐一对应）
  repo digest `sha256:5ade214846fd6def9bdd71c31a130092699da392ba1a73362aa292843d37f33e`
  **来源说明**：Docker Hub 大层在本网络持续 download EOF；lazy mirror（docker.1ms.run）CDN 不支持 Range 续传。ghcr 为官方发布、digest 已核对。本次 smoke 仅为本地临时 tag 成 `risingwavelabs/risingwave:v2.8.0`，**标准配置的镜像默认引用未改动**，系统镜像源未改。

### lazycat dev LPK（安装实测）
- 产物摘要：`deploy-artifacts/lazycat-dev-3b5e4dfa9ce2-1792379171529/artifact-manifest.json`
- LPK：同目录 `raft.lpk`，sha256 `fe14f6dbb36f933e68f79abad099eb2a766a6384cce263cb28311761691ece37`，版本 0.4.0，app id `cloud.lazycat.app.raft.dev`（dev 与 release 身份独立，不互相覆盖）
- 构建用 lzc-cli：`/opt/homebrew/bin/lzc-cli` 2.0.9（wrapper 强制版本门控，2.0.5 会被拒绝——2.0.5 多源 COPY 收集失败）
- 内容核实：APP_URL 注入部署参数（raft.rx79.heiyu.space），旧固定源 SHA 与签名密钥均不在产物中

## 部署/升级操作步骤

### standard（production compose）
```sh
# 构建（ref 解析为完整 commit；dirty 需 --allow-dirty 并记录 patch 摘要）
node scripts/deploy-target.mjs build --target standard --ref <tag-or-commit>
# 启动（target/env/产物不匹配在调用 docker 前被拒）
node scripts/deploy-target.mjs deploy --target standard \
  --artifact deploy-artifacts/standard-local-<…>/artifact-manifest.json --env local
```
**数据库迁移是显式前置**（标准镜像 entrypoint 不自动迁移）：
```sh
docker exec -e PGOPTIONS="-c statement_timeout=30000" \
  -e SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS=30000 \
  <server-container> sh -c 'cd /app/packages/server \
    && node --import @oxc-node/core/register scripts/migration-preflight.ts \
    && node --import @oxc-node/core/register scripts/migrate-deploy.ts'
```

### lazycat（从旧清单升级，保留已有签名密钥）
旧实例的 SCOPE_ATTESTATION_SECRET 只烘在旧 manifest 环境里。**替换清单前先就地持久化一次**（值不输出到日志/聊天）：
```sh
# 在 lazycat/ 目录运行
lzc-cli project exec --dev -s server --tty=false -- sh -c \
  'test -f /lzcapp/var/secrets/scope_attestation_secret && echo EXISTS \
   || { printf "%s" "$SCOPE_ATTESTATION_SECRET" > /lzcapp/var/secrets/scope_attestation_secret \
       && chmod 600 /lzcapp/var/secrets/scope_attestation_secret && echo PERSISTED; }'
# 构建并安装（新入口从文件优先读取，与旧值逐字节一致，不轮换）
RAFT_APP_URL=https://<dev-domain> node scripts/deploy-target.mjs build --target lazycat --env dev --ref <commit>
node scripts/deploy-target.mjs deploy --target lazycat --artifact <manifest> --env dev
```

## 验收结果
- standard production compose（postgres+risingwave+server+web 四容器）：`/api/auth/providers` 正常（`lazycat.enabled=false`）、`/api/auth/lazycat/start` 404、`/api/channels` 401（鉴权生效）、socket.io 200、迁移应用后无 DB 错误；server release_sha=3b5e4dfa
- standard dev-mode 补充诊断：残留 LAZYCAT_* 变量下仍为 standard、懒猫路由 404
- lazycat dev：OIDC `/api/auth/lazycat/start` 302、providers `lazycat.enabled=true`；服务器进程密钥与持久化文件逐字节匹配（scope 与 JWT 均未轮换）；5 容器 healthy
- target/env/产物不匹配：两个方向均在 docker/lzc 调用前被拒（实测 exit=1）
- 测试：server 60 项（配置/HTTP/API）+ web 10 项（hook + 渲染）+ wrapper 8 项单元；server/web typecheck 通过

## 已知限制
- 标准部署需显式执行迁移（见上）
- 懒猫实例升级需先持久化旧签名密钥（否则 entrypoint 生成随机值——在途 attestation 会失效）
- 本机 Docker Hub 大层不可靠：RisingWave 本地 tag 来自 ghcr（digest 已核对）
- 单测与 smoke 不含负载/多实例容灾验证
