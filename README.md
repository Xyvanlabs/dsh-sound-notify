# dsh-sound-notify

会话**中断**或**正常结束**时播放提示音。两种场景可分别配音效、可单独关闭或静音，另有全局开关与音量。

> 想先知道「为什么非得拆成宿主 + 浏览器两半边、判定逻辑为什么在宿主」，看 [设计说明](docs/DESIGN.md)。本文只讲装、用、排查。

---

## 一、宿主环境与插件形式（假设）

| 项目 | 假设值 | 依据 |
| --- | --- | --- |
| 宿主 | DeepSeek Harness 桌面端 / `dsh web`，profile 名 `desktop` | 本机 `C:\Users\Lenovo\.dsh\profiles\desktop` |
| 界面 | Web GUI `http://127.0.0.1:<端口>`（每次启动随机，以窗口地址栏为准；本机实测 5694 / 8846 / 9033） | 声音只能在浏览器侧发出 |
| 插件形式 | **bundle**（宿主半边 + 客户端半边） | 与 `dsh-restart-button` 同构 |
| 宿主协议 | `dsh >=0.1.1-rc.2 <0.3.0` | `package.json` 的 `dsh.engines.dsh` |

**为什么必须两半边**：`turn/end` 事件的 `reason.kind` 只存在于宿主事件载荷里；浏览器侧拿不到结束原因，无法区分「被打断」和「跑完了」。所以宿主判定、浏览器发声。

```
宿主 lib/index.js                      浏览器 lib/client.js
  ctx.on('session/event')               每 600ms 轮询
        │                                     │
   turn/end? ── 分类 ── 环形缓冲 ──► GET /sound-notify/events?since=N
        │                                     │
   (aborted/interrupted/error/           按 scene 选音效
    blocked/max-tokens → 中断)           Web Audio 合成 / <audio>
   (completed → 正常结束)
```

---

## 二、安装

已装好时可跳过本节。重装步骤：

```powershell
# 1) 从工作区目录安装（link 方式，改代码即生效，不用重装）
dsh plugin --profile desktop add link:"D:\DeepSeek space\ChaJian\dsh-sound-notify"

# 2) 确认进了 profile 清单
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" | Select-String sound-notify
```

`dsh plugin add` 会把包写进 profile 的 `dependencies` 与 `dsh.profile.bundles`，软链到 `profiles/desktop/node_modules/`，并把 bundle 自带 `cordis.patch.yml` 里的 `sound-notify` 行插入插件名录。

**装完必须重启 DSH**——宿主只在启动时读一次名录。

---

## 三、配置

三个场景各有独立开关与音效：**正常结束**（`completed`）、**中断/报错/超限**（`interrupted`）、**模型提问等你回答**（`ask`）。`ask` 走 `user-questions/request` 与 `tools/pre-execute` 两条钩子，不依赖轮次结束——因为提问不会结束本轮回合。

默认开箱即用（三种音效都开、音量 0.7）。要改，在 **profile 的补丁层**加一段：

`C:\Users\Lenovo\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

```yaml
- id: sound-notify
  name: dsh-sound-notify
  config:
    enabled: true          # 全局开关
    muted: false           # 全局静音（仍计数，方便确认链路活着）
    volume: 0.7            # 全局音量 0..1，与场景音量相乘
    interrupted:           # 中断场景
      enabled: true
      sound: interrupted   # 内置名 / URL / "none"
      volume: 1
    completed:             # 正常结束场景
      enabled: true
      sound: completed
      volume: 1
    ask:                   # 模型向你提问、等待输入时
      enabled: true
      sound: interrupted
      volume: 1
```

### 字段表

| 字段 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 总开关，`false` 时宿主直接不产生事件 |
| `muted` | bool | `false` | 静音：仍计数、仍推事件，只是不发声 |
| `volume` | 0..1 | `0.7` | 全局音量，乘到各场景音量上 |
| `minIntervalMs` | 0..10000 | `500` | 两条音的最小间隔，防多会话齐响 |
| `includeSubagents` | bool | `false` | 子代理轮次是否也响 |
| `interrupted.enabled` | bool | `true` | 单独关掉中断音 |
| `interrupted.sound` | string | `interrupted` | 音效：内置名 / URL / `none` |
| `interrupted.volume` | 0..1 | `1` | 中断音场景音量 |
| `completed.*` | 同上 | — | 正常结束场景，字段同中断 |
| `ask.enabled` | bool | `true` | 模型提问时是否响 |
| `ask.sound` | string | `interrupted` | 提问音效；默认借用中断音 |
| `ask.volume` | 0..1 | `1` | 提问场景音量 |
| `interruptedKinds` | string[] | `aborted, interrupted, error, blocked, max-tokens` | 归为中断的结束原因 |
| `completedKinds` | string[] | `completed` | 归为正常结束的结束原因 |
| `quietKinds` | string[] | `forked` | 完全不发声的结束原因 |

### 音效可选项

| 值 | 效果 |
| --- | --- |
| `completed` | C6→E6 上行两音，sine，明亮收束 |
| `interrupted` | A4→E4 下行两音，square，明显更「沉」 |
| `beep` | 单声 880Hz，自检用 |
| `none` | 不出声 |
| `https://…/ding.mp3` | 任意音频 URL，走 `<audio>` 播放 |
| `/assets/ding.mp3` | 站内路径也行 |
| `data:audio/wav;base64,…` | data URI 也行 |

---

## 四、验证

> DSH 每次重启端口都会变（本机见过 5694 / 8846 / 9033 / 4161）。下面统一用 `$Base`，先用第 0 步的脚本探测出来。

### 一键跑完第 0～1 步

```powershell
pwsh -File "D:\DeepSeek space\ChaJian\dsh-sound-notify\verify.ps1"
```

脚本自动探测端口 → 探活 → 各投一条 completed / interrupted → 复核计数，最后打印手动两步的提示。

### 第 0 步：确认宿主已加载（不发声音也能验）

```powershell
$Base = 'http://127.0.0.1:4161'   # 换成你当前的端口
Invoke-RestMethod "$Base/sound-notify/state"
```

**通过判据**：返回 JSON 且 `"subscribed": true`、`"version": "1.0.0"`。
若返回 `{"ok":false,"error":"unknown route /state"}` 或 404，说明宿主还没重启。

### 第 1 步：先确认浏览器能出声（不依赖真实对话）

点一下页面任意位置（浏览器自动播放策略要求一次用户手势），然后：

```powershell
Invoke-RestMethod "$Base/sound-notify/test?scene=completed"   -Method POST
Invoke-RestMethod "$Base/sound-notify/test?scene=interrupted" -Method POST
Start-Sleep -Milliseconds 1500
(Invoke-RestMethod "$Base/sound-notify/state").stats.lastAck
```

**通过判据**：约 0.6 秒内分别听到**上行**和**下行**两种不同的音，且 `lastAck` 里 `audioState` = `running`、`played` = `true`。
`lastAck` 是浏览器回传的执行回执——它证明「浏览器真的执行了播放」，而不只是宿主投递了事件。
若 `audioState` = `suspended`，说明还没点过页面（浏览器自动播放策略）。

### 第 2 步：触发一次「正常结束」

发一条随便什么消息（比如「回复 OK」），等它自然答完。

**通过判据**：

```powershell
(Invoke-RestMethod "$Base/sound-notify/state").stats
```

- `played` 比上一步末 +1
- `acked` 同步 +1，`lastAck.audioState` = `running`
- `lastEvent.scene` = `completed`
- `lastEvent.kind` = `completed`
- 耳朵：听到**上行两音**

> 子代理的轮次默认不响（`includeSubagents: false`），会计入 `skippedSubagent` 而不计入 `played`。

### 第 3 步：触发一次「中断」

发一条会跑一阵的消息（比如「把 1 到 100 万逐个平方后求和」），在它跑的过程中点**停止**按钮。

**通过判据**：

- `lastEvent.scene` = `interrupted`
- `lastEvent.kind` = `aborted`
- `stats.turnEnds` 比上一步 +1
- 耳朵：听到**下行两音**，与第 2 步明显不同

### 第 4 步（可选）：看落地日志

```powershell
Get-Content "$env:USERPROFILE\.dsh\sound-notify\activity.jsonl" -Tail 10
```

每行一条：正常产出的事件带 `seq/scene/kind`，被跳过的带 `skipped: quiet|subagent|throttled`。这是「到底判成了什么」的最直接证据。

---

## 五、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/sound-notify/state` 404 | 宿主未重启 | 完全退出 DSH 再打开 |
| 第 1 步就没声音 | 浏览器还没收到用户手势 | 先点一下页面任意处再试 |
| 有 `played` 计数但没声音 | 系统音量 / 浏览器标签静音 | 查系统音量混合器 |
| 正常结束响两次 | 一次对话带了多轮 `turn/end` | 调大 `minIntervalMs` |
| 子代理也响 | `includeSubagents` 开了 | 关掉 |
| 刷新页面后重响 | 不应发生（首次握手只取游标） | 若发生，看 `since` 是否被改 |
| `played` 涨但 `acked` 不涨 | 页面没在跑客户端插件（未刷新 / 插件未进 graph） | 刷新页面，再看 `eventsRequests` 是否递增 |

---

## 六、自测（不依赖 DSH，改代码后跑）

```powershell
cd "D:\DeepSeek space\ChaJian\dsh-sound-notify"
node test/host.mjs     # 宿主半边：事件分类、缓冲、HTTP 接口  22 项
node test/client.mjs   # 客户端半边：轮询、音效选择、音量合成  22 项
node test/e2e.mjs      # 端到端：真 HTTP 连接串起两半边        10 项
```

`e2e.mjs` 里只有「DSH 宿主」和「浏览器」是 stub，中间的事件判定、路由、轮询、音效合成全是真代码。

---

## 文件

```
dsh-sound-notify/
├── package.json          # type:module, main, exports, dsh.bundle/client
├── cordis.patch.yml      # 插入 sound-notify 行
├── lib/
│   ├── index.js          # 宿主半边：判类 + 环形缓冲 + 4 个路由
│   └── client.js         # 客户端半边：轮询 + Web Audio 合成
├── test/
│   ├── host.mjs
│   ├── client.mjs
│   └── e2e.mjs
└── README.md
```
