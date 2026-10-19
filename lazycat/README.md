# Raft · 懒猫微服（LPK v2）

Raft 是人类与 AI 智能体协作的共享工作空间。本目录把 Web、API、PostgreSQL 与 RisingWave 组合成一个懒猫应用，正式包标识为 `cloud.lazycat.app.raft`。

## 前置条件

- lzc-cli v2.0.0+，已连接并授权目标设备。
- 设备运行 lzcos v1.5.0+。
- Docker 已安装并运行；构建机能够拉取基础镜像与安装 pnpm 依赖。
- 完整仓库源码，以及本目录的 `Dockerfile.server` 和 `scripts/` 服务运行时文件。

## 目录结构

| 文件 | 用途 |
| --- | --- |
| `package.yml` | 包身份、双语商店信息和联网权限 |
| `lzc-manifest.yml` | 应用入口、路由、服务及持久化挂载 |
| `lzc-build.yml` | 正式构建：两个内嵌镜像，输出到 `dist/` |
| `lzc-build.dev.yml` | 仅覆盖开发包标识为 `cloud.lazycat.app.raft.dev` |
| `Dockerfile.web` | Node 构建前端，nginx 提供静态资源 |
| `Dockerfile.server` | 服务端镜像（独立运行时任务维护） |
| `scripts/` | 服务启动、依赖等待及数据库初始化（独立运行时任务维护） |
| `icon.png` | 复用 `packages/web/public/brand/raft-logo.png`，非占位图 |
| `README.md` | 开发、发布与运维说明 |

## 开发流程

从仓库根使用包装器（LPK 内嵌部署域名，因此在构建时指定）：

```sh
RAFT_APP_URL=https://your-app-domain node scripts/deploy-target.mjs build --target lazycat --env dev --ref HEAD
node scripts/deploy-target.mjs deploy --target lazycat --env dev --artifact <artifact-manifest.json>
```

开发配置由包装器合并为完整文件；发布构建省略 `--env dev`，安装时明确 `--env release`。安装只使用摘要校验后的 LPK，不会重新构建。手动使用 project deploy 时必须明确 `lzc-cli project deploy --dev` 或 `lzc-cli project deploy --release`；它们可能重新构建，不用于安装已审核产物。不存在 build --dev。

默认拒绝脏工作树；审阅未提交修改时可加 `--allow-dirty`，产物会记录补丁摘要与未跟踪文件列表。必须先 checkout 到 --ref 所指提交。构建暂存排除 .pi、缓存、dist、依赖和常见密钥文件，暂存目录在成功或失败后清理。

CLI 的文件同步入口为：

```sh
lzc-cli project sync
# 持续同步时使用：
lzc-cli project sync --watch
```

本骨架未配置源码同步映射、开发服务器或热更新。同步本身不会重新编译已嵌入镜像的前端，也不会替代镜像重建；日常验证以重新 deploy 为准。配置了相应同步目标及开发运行入口后，才使用 sync 加速迭代。

## 构建与发布

```sh
lzc-cli project build
```

默认使用正式 `lzc-build.yml`，在 `dist/` 生成 `.lpk`。这是 image-only release：不配置 `contentdir`，也不配置 `buildscript`。两个 Dockerfile 从仓库根上下文复制各自所需源码与资源（服务端包含 manual、packages、infra），并在镜像内完成构建，无须另做宿主机资源暂存。

发布前，先把第三方镜像复制到官方 registry：

```sh
lzc-cli appstore copy-image postgres:16-alpine
lzc-cli appstore copy-image risingwavelabs/risingwave:v2.8.0
```

将命令返回的官方 registry 地址分别写入 `lzc-manifest.yml` 的两个服务 `image` 字段，再重新执行 `lzc-cli project build`。确认产物版本与功能后，发布该次生成的实际文件：

```sh
lzc-cli appstore publish ./dist/<本次构建生成的文件名>.lpk
```

不要发布仍引用公共第三方镜像地址的旧产物。命令约定见官方 [CLI 文档](https://developer.lazycat.cloud/lzc-cli.html)、[构建规范](https://developer.lazycat.cloud/build.html) 和 [发布说明](https://developer.lazycat.cloud/publish-app.html)。

## 架构与认证

应用容器运行 `embed:web` 中的 nginx，单一 `raft` subdomain 提供 Web 入口。前端不传入 `VITE_API_URL`，以同源 `/api` 和 `/socket.io` 访问后端。

平台 `upstreams` 把这两条路径转发到 `http://server:3001`。`disable_trim_location: true` 保留路径前缀，因为 server 的 API 路由自带 `/api`，Socket.IO 也需要其原始路径；WebSocket 升级通过平台 upstream 转发，模板没有 fix_websocket_header 配置。Web 镜像继续使用仓库 nginx 配置，并对 `desktop-manifest.json` 固定内容 SHA-256 ETag。

PostgreSQL 采用应用内网 trust 认证：当前方案中 lzcapp 的 `setup_script` 与 `command` 冲突，无法通过该初始化方式生成密码文件，故按本部署设计使用无密码内部连接。此信任仅适用于应用内部网络，数据库端口不对外暴露；不要为数据库添加公网端口或不受信任的网络访问。PostgreSQL 开启逻辑复制供 RisingWave 使用。

## 数据持久化

| 应用数据路径 | 内容 |
| --- | --- |
| `/lzcapp/var/pgdata` | PostgreSQL 数据，挂到容器 `/var/lib/postgresql/data` |
| `/lzcapp/var/risingwave` | RisingWave 状态，挂到容器 `/risingwave/data` |
| `/lzcapp/var/uploads` | 用户上传文件 |
| `/lzcapp/var/secrets` | 服务端运行时密钥 |

更新或重建镜像不会主动清空这些目录。备份时停应用并保留全部四个目录，避免数据库、流处理状态与上传文件不一致。

## Troubleshooting

- 首次启动 RisingWave bootstrap 约需 1–2 分钟。server 容器启动时会等待依赖并迁移数据库；首次打开暂时不可用时，先等待并检查 `lzc-cli project log`，不要反复清理数据。
- API 404：确认 upstream 保留 `/api` 前缀，前端没有被外部构建环境注入 `VITE_API_URL`；实时连接失败时检查 `/socket.io` 路由与 WebSocket header 配置。
- 构建失败：确认从 `lazycat/` 执行命令、镜像上下文为 `..`，且完整仓库与服务端运行时文件齐全。
- 重置全部数据（不可恢复）：先备份，确认正在操作开发包还是正式包，然后在懒猫应用管理中停止目标应用。通过设备管理工具找到该应用对应的持久化数据目录，删除其中 `pgdata`、`risingwave`、`uploads`、`secrets` 四个目录，再启动应用，服务会重新初始化。不要在服务运行时删除，也不要直接删除其他应用的数据目录；容器里的 `/lzcapp/var` 是应用挂载路径，并非可直接套用的设备宿主机路径。重置 secrets 会使原有凭据失效。

## 密钥升级

scope attestation 密钥现在优先从 `/lzcapp/var/secrets/scope_attestation_secret` 读取。文件缺失时入口以 wx、0600 写入已有环境变量（旧实例兼容）或随机值，绝不输出密钥。

**升级现有实例前**，必须先在仍保留旧环境变量的实例运行兼容入口以落盘该值，或由设备管理员安全地将旧值保存到上述文件并设为 0600，然后再替换 manifest。直接删除旧 manifest 环境值后才首次运行新入口无法恢复旧密钥，会生成新值。备份 secrets 目录，勿将值写入日志或提交。

`node scripts/deploy-target.mjs check-deps` 检查标准与懒猫 Dockerfile 的依赖 COPY 闭包；`node --test scripts/deploy-target.test.mjs` 运行包装器单元测试。真实 Docker/LPK 构建与设备安装需单独验证。
