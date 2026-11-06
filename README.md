# 用户记忆（dsh-memory-v2）

给 DeepSeek Harness 用的长期记忆插件。每轮自动存档、自动召回。

> 作者：伊万莉瑞希 · MIT License

## 它做什么

- **每轮自动存档**：回合结束时把「你说的」和「我说的」写进 `情景/YYYY-MM-DD.md`，零模型调用
- **每轮召回**：只从有关键词关联或实体关联的记忆中选最多 4 条；无关联则不注入
- **攒够就提醒**：有未巩固的轮次就每轮提一句，提醒我调 `memory_consolidate`
- **巩固**：把情景原文交给我，我自己读、自己抽事实写进库
- **三处备份**：当前 / 旧版（压缩快照）/ 镜像（纯文本，能直接读）

## 记忆分四类

| 集合 | 放什么 |
|---|---|
| 语义 | 事实 |
| 结论 | 我的判断（带版本链，旧版进 `历史`） |
| 画像 | 长期偏好，常驻注入 |
| 临时 | 带有效期的状态 |

## 三个函数各管一件事（不许合并）

```
valid.js    isValid     能不能用（硬界限）
weight.js   getWeight   先想哪个（排序）
expiry.js   isExpired   要不要问他一句（软提醒）
```

**四组合测试**里最关键的一条：`isValid=true` + `weight=0` 必须判「有效」。权重低不等于失效。

## 工具

```
memory_write       写一条 / 改一条（supersede + opposite）
memory_recall      按问题找 4 条
memory_consolidate 从最早未读处继续取情景原文，自己巩固
memory_trace       按字面查原话
```

## 路由

```
GET /memory-v2/stats       条数、各类数量、候选数
GET /memory-v2/candidates  候选队列（也是审计日志）
```

## 会话范围

`~/.dsh/dsh-memory-v2-config.json`：

```json
{
  "会话白名单": ["session-xxx"],
  "排除会话": [],
  "启用全部会话": false
}
```

- 白名单非空 → 只对这些会话生效
- 排除会话 → 永远优先，列表里的会话一律不挂
- 都不配、配置不存在或损坏、拿不到会话 ID → 停用
- 只有明确设置 `"启用全部会话": true` 且白名单为空，才会对全部可识别会话生效（排除名单仍优先）
- 工具仅注册到获准会话；修改配置后工具调用即时复查，挂载每 500ms 刷新

这是**单人跨会话共享库**，不提供多人身份隔离。多人应使用不同的 `DSH_HOME` 和独立 DSH 实例；不要把不同人的会话加入同一白名单。首次安装后请先填写自己的会话 ID，再开始使用。

候选接口默认返回 403。需要审计时，在同一配置中填写至少 32 字符的随机 `候选接口令牌`，请求头使用 `Authorization: Bearer <令牌>`。不要把令牌写入 URL 或发布包。统计接口仅返回数量。公网部署还应使用宿主的身份认证和 HTTPS。

巩固按最早积压顺序读取，每次最多 8000 个 Unicode 字符。只推进实际返回部分；`rounds` 返回完整处理的轮数，长轮可能返回 0，继续调用会读取后半段。跨日不重置，原文不删除。旧状态自动兼容；旧版本已经错误清零的进度无法自动推断，原文仍可通过 `memory_trace` 查询。

同一分钟有多段原文而来源无法区分时，不自动附带原文，避免误引；可用 `memory_trace` 查询。新情景优先通过偏移索引分段，用户消息里的 Markdown 标题不会伪装成新轮次。

## 数据在哪

```
~/.dsh/storages/dsh-memory/
  当前/     四类 JSON
  情景/     按天的对话原文
  旧版/     压缩快照，永久保留
  镜像/     纯文本镜像，永久保留
  日志/     写入日志、情景索引、巩固状态
```

## 装

运行环境：Node.js 18 或更新版本，且需支持 `structuredClone`、ES Modules 和宿主插件 API。

- **手动（当前可用）**：把整个目录放进 profile 的 `node_modules/dsh-memory-v2`，再在 `package.json` 的 `dsh.profile.bundles` 里加一项。
- **插件市场 / npm**：尚未发布，发布后更新。

**插件包自己的 `package.json` 必须有 `dsh.bundle.patch` 字段**，配一个 `cordis.patch.yml`，否则 DSH 不认识它。

## 测

`npm test` 自动发现并执行全部 `test/test-*.js`，任何失败都会返回非零退出码。也可逐个执行：

```sh
node test/test-three.js        # 四组合
node test/test-store.js
node test/test-recall.js
node test/test-consolidate.js
node test/test-consolidate-hook.js
node test/test-scene-escape.js
node test/test-update.js
node test/test-supersede.js
node test/test-revision.js
node test/test-scope.js
node test/test-tool-schema.js
node test/test-apply.js
node test/test-tools.js
```

**每个测试都在临时目录里跑，不碰真库。**

## 隐私与发布

获准会话的可见对话会明文写入本地情景文件，写入的记忆会产生快照、Markdown/TXT 镜像与候选审计；这些文件没有自动过期清理。分享前请检查数据目录和诊断日志，删除当前记录不会自动删除历史副本。插件本身不进行网络上传，但注入的记忆会随 DSH 上下文发送给所选模型服务。

发布时只分享本插件源码目录，根目录建议命名为 `dsh-memory-v2`。不要打包 `DSH_HOME`、运行数据、私人配置或备份目录。源码包不包含任何已启用会话或真实令牌。

## 依赖 DSH 的这些行为

这台机器上实测过的，DSH 升级可能变：

- `agent/inbox/inserted` 的 `payload.message.source.kind === 'user'` 才是用户说的话
- `agent/turn-stopping` + `agent.session.snapshotEvents()` 拿本轮对话
- `systemPrompt.section()` / `.context()` **返回的是函数**（disposer），不是 `{ off }`
- 工具的 `parameters` 用扁平 spec；**DSH 的 schema DSL 不支持 `required`**
- 工具 output schema 是 `additionalProperties: false`，多返回字段要先声明

## 已知没做的

- 实体邻接：代码在，但要写记忆时自己带 `entities` 才有用
- 候选队列：现在是审计日志（自动转正），不是「等你点头」的闸
