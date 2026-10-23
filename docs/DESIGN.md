# dsh-sound-notify 设计说明

本文件回答四个问题：**它是什么**、**为什么做**、**解决什么问题**、**怎么用**。安装与配置的完整参数表在 [README](../README.md)。

## 一、它是什么

一个 DeepSeek Harness（下称 DSH）的 **bundle 插件**，由两个半边组成：

| 半边 | 文件 | 跑在哪 | 职责 |
| --- | --- | --- | --- |
| 宿主半 | `lib/index.js` | DSH Host 进程（Node） | 监听 `session/event`，判定每轮怎么结束的，写环形缓冲，暴露 4 条 HTTP 路由 |
| 客户端半 | `lib/client.js` | 浏览器（Web GUI） | 每 600ms 轮询宿主，按场景用 Web Audio 合成音效并播放，回传执行回执 |

插件在 profile 里注册为 `sound-notify`，宿主路由前缀是 `/sound-notify/`。当前版本 `1.0.0`，宿主协议要求 `dsh >=0.1.1-rc.2 <0.3.0`。

## 二、为什么做

两件事促使必须拆成两半，且必须由宿主做判定：

**1. 只有宿主知道「为什么结束」。** 一轮对话结束时不只有一个信号：跑完、用户点停止、报错、被策略拦住、token 超限，在宿主事件里都是 `turn/end`，区别只在载荷里的 `reason.kind`（`completed` / `aborted` / `error` / `blocked` / `max-tokens` …）。浏览器侧拿到的只是渲染结果，没有这个字段，自己判会把「跑完了」和「被打断」混成一件事——而这恰恰是要区分开的两条音。

**2. 声音只能在浏览器发。** Host 是 Node 进程，没有音频设备上下文；而且哪怕能发，用户戴耳机听的是浏览器那个标签页。所以职责切成「宿主判定 + 浏览器发声」，中间用一条游标式的 HTTP 长轮询通道连起来，避免为了一个提示音引入 WebSocket 或新增依赖。

```text
宿主 lib/index.js                      浏览器 lib/client.js
  ctx.on('session/event')               每 600ms 轮询
        │                                     │
   turn/end? ── 分类 ── 环形缓冲 ──► GET /sound-notify/events?since=N
        │                                     │
   (aborted/interrupted/error/           按 scene 选音效
    blocked/max-tokens → 中断)           Web Audio 合成 / <audio>
   (completed → 正常结束)
```

## 三、解决什么问题

**人不在屏幕前，不知道那一轮完了没有。** 长任务跑着的时候人会去干别的，回来只看得到最终画面，分不清「它早就答完了」和「它刚被你手滑停掉」。这插件把两种结局配成两种听感上明确不同的音：上行两音（C6→E6，sine，明亮）代表正常跑完，下行两音（A4→E4，square，低沉）代表中断或报错。音色差异比音量差异更容易在背景里分辨。

顺带解决的三个连带问题：

- **多会话齐响**：`minIntervalMs`（默认 500ms）节流，两条音不会叠成噪音。
- **子代理刷屏**：子代理每轮也会 `turn/end`，默认 `includeSubagents: false` 直接跳过并计数。
- **配置改了不知道有没有生效**：`/sound-notify/state` 暴露 `played` / `acked` / `lastEvent` / `lastAck` 四组计数，改配置后看一眼计数就能确认链路活着，不用等一次真实对话。

## 四、基本用法

**装**（已装可跳过）：

```powershell
dsh plugin --profile desktop add link:"D:\DeepSeek space\ChaJian\dsh-sound-notify"
```

装完必须完整退出并重开 DSH——宿主只在启动时读一次插件名录。

**验**（重启后，任选）：

```powershell
pwsh -File "D:\DeepSeek space\ChaJian\dsh-sound-notify\verify.ps1"
```

脚本自动探测当前端口 → 探活 → 各投一条 completed / interrupted → 复核计数。注意浏览器自动播放策略：**页面要先点一下**，否则 `audioState` 会是 `suspended`，计数涨但没声音。

**改**：在 profile 的 `cordis.patch.yml` 里加 `id: sound-notify` 段，字段见 README 第三节；三个场景（`completed` / `interrupted` / `ask`）各有独立的 `enabled` / `sound` / `volume`。

**自测**（不依赖 DSH）：`node test/host.mjs`、`node test/client.mjs`、`node test/e2e.mjs`，共 54 项断言。
