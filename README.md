# 瑞希的记忆（dsh-memory-v2）

一个面向 DeepSeek Harness（DSH）的本地长期记忆插件，名为「瑞希的记忆」。它把结构化记忆、原文情景、溯源索引和巩固状态保存在用户自己的 DSH 数据目录中。

> 隐私提醒：本插件会在本地明文保存对话原文和提取后的记忆。请先阅读 [PRIVACY.md](PRIVACY.md)。

## 特性

- 四类记忆集合：语义、结论、画像、临时。
- 无关查询不召回；冲突记忆只随直接命中项成对返回。
- 两阶段巩固：读取原文后不立即清理；调用方应在持久化所需记忆后回传 `ackToken`，也可显式放弃本次租约。
- 超长内容按 8000 字无损分块，支持跨日、重启恢复和重复 ACK。
- ACK/放弃终态日志最多保留最近 1000 项，避免长期运行时无限增长。
- 每个情景段使用唯一 `segmentId`，避免 Markdown 标题和同分钟多轮导致的溯源歧义。
- 跨进程写锁、陈旧锁恢复和多文件事务恢复。
- 可选按会话分库，不内置任何账号、人名或聊天平台绑定。
- 候选工作集保留最新 50 条，同时按日追加完整审计日志。

## 安装

需要 Node.js 20 或更高版本。

1. 安装依赖：

   ```bash
   npm install --omit=optional
   ```

2. 将本目录放入 DSH profile 的 `node_modules/dsh-memory-v2` 目录，或使用 DSH 支持的本地插件安装方式。
3. 把 `cordis.patch.yml` 加入对应 profile 的 bundle 配置。
4. 重启 DSH。

`@xenova/transformers` 是可选依赖。只有在开启语义召回时才需要它，并且需要在插件的 `models/bge-small-zh/` 中准备本地模型。代码不会自动从远程下载模型。

## 插件配置

`cordis.patch.yml` 默认采用隐私优先设置：

```yaml
语义召回: false
诊断日志: false
启用敏感调试路由: false
启用全局主库工具: false
```

- `诊断日志`：默认关闭。开启后也不记录消息正文、会话 ID 或 RPC 标识。
- `启用敏感调试路由`：默认关闭。开启后 `/memory-v2/candidates` 会返回候选记忆正文，只应用于受信本地环境。
- `启用全局主库工具`：默认关闭。只有明确的单用户部署才应开启；多用户分库使用会话专属工具，避免注册失败时回落主库。

## 会话范围与分库

可在 `~/.dsh/dsh-memory-v2-config.json` 中配置：

```json
{
  "会话白名单": [],
  "排除会话": [],
  "会话归属": {
    "session-example-a": "alice",
    "session-example-b": "bob"
  },
  "排除归属": [],
  "未映射会话写入待认领": true
}
```

- 没有分库配置时，默认所有具备有效会话 ID 的会话读写主库；缺少会话 ID 时失败关闭，不读写任何记忆库。
- `会话归属` 把会话 ID 映射到隔离分库。只要配置了映射，未映射会话默认写入 `pending`，除非明确把 `未映射会话写入待认领` 设为 `false`。
- 开启 `未映射会话写入待认领` 后，未映射会话读主库、写 `pending` 库。
- 分库目录名由规范化短标识和 SHA-256 摘要共同生成，避免不同原始标识清洗后碰撞；原始归属值不会写入诊断日志。
- 配置损坏时首次加载失败关闭；运行中损坏或暂时消失时保留最近一次有效配置，不会悄悄回落到主库。

仓库提供 [config.example.json](config.example.json)。不要提交你自己的真实会话 ID。

### 从 0.3.0 升级

0.3.0 的 `dsh-memory-<归属>` 目录名由非单射清洗规则生成，无法仅凭目录名可靠证明原始归属。0.3.1 检测到这类旧分库时会失败关闭，不会自动改名；请先备份并人工核对归属，再迁移到当前带摘要的目录，避免历史归属变化后误领数据。

## 工具

- `memory_write`：写入、替代或标记冲突记忆。
- `memory_recall`：默认返回最多 2 条，复杂问题最多 4 条。
- `memory_trace`：按字面从情景库溯源。
- `memory_consolidate`：两阶段读取、ACK 巩固与显式放弃租约；插件校验令牌，但是否已完成所需写入由调用方负责。

## 本地数据

默认存储位于 `~/.dsh/storages/dsh-memory/`：

```text
当前/     结构化 JSON
情景/     按日保存的对话原文
旧版/     压缩快照
镜像/     人类可读备份
日志/     索引、巩固租约、写入日志和候选审计
```

这些目录可能包含敏感信息，不应进入 Git 仓库。
存储根目录还会出现 `.memory-v2.lock`、`.memory-v2-transaction.json` 和 `.memory-v2-tx/` 等锁与事务恢复文件；插件运行或故障恢复期间不要手动删除它们。

## 测试与隐私检查

```bash
npm test
npm run privacy:check
npm run privacy:check:artifact
```

全部 29 个测试文件使用临时目录和合成数据，不读取真实 DSH 记忆库。`privacy:check` 用于源码仓库，`privacy:check:artifact` 用于不应包含 `.git` 或 `node_modules` 的发布物；预打包阶段使用只跳过第三方依赖的 installed 模式。

持续集成覆盖 Windows 与 Linux 上的 Node.js 20、22，并执行测试、隐私扫描和 npm 打包清单检查。

## 贡献与安全

- 贡献说明：[CONTRIBUTING.md](CONTRIBUTING.md)
- 隐私说明：[PRIVACY.md](PRIVACY.md)
- 安全报告：[SECURITY.md](SECURITY.md)

## 作者

伊万莉瑞希

## License

[MIT](LICENSE)
