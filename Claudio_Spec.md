 # Claudio 个人 AI 电台系统 - 全栈开发实施文档 (修正后最终版)

## 1. 项目概述

### 1.1 项目名称与定位
**Claudio**：一个能够读懂用户听歌习惯、规划声音内容，并像 DJ 一样进行播报的个人 AI 电台系统。

### 1.2 核心能力矩阵
-   **智能中枢：** DeepSeek API (`deepseek-chat`) 负责决策、意图识别与 JSON 结构化输出。
-   **音乐服务：** 网易云音乐官方 CLI（`ncm-cli` / `@music163/ncm-cli`）通过 OpenClaw 标准化接口，返回纯净 JSON 结构化数据（歌曲信息、推荐列表、歌单、播放地址），无广告、无贴片。负责检索、直链、歌词、推荐。
-   **语音合成：** Fish Audio TTS 负责文本转语音。
-   **上下文感知：** 飞书日程 + OpenWeather 天气 + 本地用户语料。
-   **硬件联动：** UPnP 协议推送至家庭音响。
-   **交互终端：** 沉浸式暗色 PWA，支持离线与实时流。

## 2. 系统架构与技术栈

### 2.1 四层架构
1.  **外部上下文层：** 用户语料、DeepSeek、网易云音乐（OpenClaw ncm-cli）、Fish、Feishu、Weather、UPnP。
2.  **本地大脑层：** Fastify 服务端，包含 Router、Context 组装、DeepSeek 适配器、调度器、TTS 管线、LowDB 状态存储。
3.  **运行时聚合层：** Prompt 拼接 → DeepSeek JSON Mode → Action Handler 分发 → WS 推送。
4.  **交互表层：** Vite + Vanilla JS PWA，Player/Profile/Settings 三视图，双 Audio 无缝切换。

### 2.2 强制技术选型
| 模块 | 指定技术 | 备注 |
| :--- | :--- | :--- |
| Web 框架 | Fastify | 高性能，原生支持 JSON Schema 校验 |
| AI SDK | openai | baseURL: `https://api.deepseek.com` |
| 网易云 API | `ncm-cli`（网易云官方 CLI） | 通过 OpenClaw 标准接口，子进程调用 `ncm` 命令，`--json` 输出纯净结构化数据，无广告 |
| 前端构建 | Vite + Vanilla JS | 零重型框架，极致轻量 |
| 本地存储 | lowdb | JSON 文件持久化 |
| PWA | vite-plugin-pwa | precache + runtime caching |
| 样式方案 | CSS Variables + Flex/Grid | 手写 CSS，暗色主题 |

## 3. 后端核心约束

### 3.1 目录结构
```text
/project-root
├── /public           # PWA 静态资源
├── /src/server       # Fastify 后端
│   ├── index.js      # 入口
│   ├── router.js     # 路由（含前置拦截）
│   ├── context.js    # Context 组装
│   ├── deepseek.js   # AI 封装
│   ├── tts.js        # TTS 封装
│   ├── netease.js    # 音乐封装
│   ├── upnp.js       # 投送封装
│   └── /prompts      # Prompt 模板文件
├── /src/data         # taste.md, state.json, fallback/, cache/
├── /src/client       # 前端源码
├── package.json
└── .env              # 所有密钥
```

### 3.2 DeepSeek 接口协议与响应 Schema
-   **请求：** 必须携带 `response_format: { type: "json_object" }`
-   **响应结构：** 根据 `action` 不同，`payload` 字段严格区分如下：

| action | payload 必填字段 | payload 可选字段 | 说明 |
| :--- | :--- | :--- | :--- |
| `play_song` | `song_id`: string | `fallback_query`: string | `song_id` 为网易云数字ID或 `"next_recommend"`；`fallback_query` 仅在 `song_id="next_recommend"` 时生效，供 netease.js 搜索兜底 |
| `speak_text` | `text`: string | `follow_up_song_id`: string | `follow_up_song_id` 为播报结束后自动接续的歌曲ID，可为空表示不接歌 |
| `check_schedule` | `time_range`: string, `summary_type`: string | — | `time_range`: `"today_morning"/"today_afternoon"/"today_evening"/"tomorrow"`；`summary_type`: `"brief"/"detailed"` |

> ⚠️ **顶层 `reasoning` 字段已移除。** 所有决策依据统一放入 `payload.reasoning`（string），三种 action 均适用。

**Fastify JSON Schema 校验代码（AI 生成时必须使用）：**
```javascript
const chatResponseSchema = {
  type: 'object',
  required: ['action', 'payload'],
  properties: {
    action: { type: 'string', enum: ['play_song', 'speak_text', 'check_schedule'] },
    payload: {
      type: 'object',
      properties: {
        song_id: { type: 'string' },
        fallback_query: { type: 'string' },
        text: { type: 'string' },
        follow_up_song_id: { type: 'string' },
        time_range: { type: 'string', enum: ['today_morning','today_afternoon','today_evening','tomorrow'] },
        summary_type: { type: 'string', enum: ['brief','detailed'] },
        reasoning: { type: 'string' }
      }
    }
  }
};
```

### 3.3 HTTP & WS 契约
-   `POST /api/chat` | `GET /api/now` | `GET /api/next`
-   `GET /api/taste` | `GET /api/plan/today`
-   `WS /stream`：推送 `NOW_PLAYING`, `AI_SPEAKING`, `DEVICE_STATUS`, `DEGRADED_STATUS`, `VOLUME_CHANGED`, `PLAYBACK_STATE`

## 4. Prompt 工程规范与模板库（强制执行）

> ⚠️ **核心原则：** 以下所有模板为生产级配置，AI 生成代码时必须原样嵌入 `src/server/prompts/` 目录，禁止自行改写或简化。

### 4.1 System Persona（DJ 人设系统提示词）
文件路径：`src/server/prompts/ej-persona.md`

```markdown
# Role: Claudio - 个人 AI 电台 DJ

## 身份定义
你是 Claudio，一位陪伴型私人电台 DJ。你不是助手、不是搜索引擎、不是客服。你的唯一使命是通过音乐和声音，为用户提供有温度的陪伴体验。

## 语气与风格
- 温暖克制：像深夜电台主播，语速平缓，用词简洁有画面感。禁止感叹号堆砌、过度热情、说教。
- 第一人称叙事：始终用"我"称呼自己，用"你"称呼用户。不说"本系统""AI""模型"。
- 音乐优先：能用歌表达的情绪，不用长篇大论解释。播报文案控制在 50 字以内。
- 自然过渡：衔接要像呼吸一样自然，禁止生硬的"接下来为您播放"。

## 绝对禁忌
- ❌ 禁止输出任何非 JSON 内容
- ❌ 禁止推荐版权受限或无法获取直链的歌曲
- ❌ 禁止主动询问用户偏好（应从历史行为推断）
- ❌ 禁止使用 emoji
- ❌ 禁止在 speak_text 中重复歌词原文
- ❌ 禁止对用户情绪做诊断或医疗建议

## Few-shot Examples
User: 早安
Assistant: {"action":"speak_text","payload":{"text":"早。窗外有雾，给你选了首慢慢醒来的曲子。","follow_up_song_id":"1901371647","reasoning":"晨间问候+天气感知+轻柔唤醒"}}

User: 放首适合加班听的
Assistant: {"action":"play_song","payload":{"song_id":"next_recommend","fallback_query":"专注 纯音乐 工作","reasoning":"加班场景无明确曲目，交由推荐引擎搜索"}}

User: 今天下午有什么事
Assistant: {"action":"check_schedule","payload":{"time_range":"today_afternoon","summary_type":"brief","reasoning":"明确查询今日下午日程"}}

User: 心情不好
Assistant: {"action":"speak_text","payload":{"text":"那就让音乐替你说说话。","follow_up_song_id":"27807838","reasoning":"情绪承接+非说教式安慰+后续接歌"}}

User: 切歌
Assistant: {"action":"play_song","payload":{"song_id":"next_recommend","fallback_query":"相似风格 换一首","reasoning":"跳过当前，保持风格连贯"}}
```

### 4.2 Context 拼接模板与 Token 预算

`src/server/context.js` 组装逻辑必须严格遵循以下结构与预算：

| Prompt 片段 | Token 预算 | 类型 | 截断策略 |
| :--- | :--- | :--- | :--- |
| Persona + Few-shot | ≤800 | 固定 | 永不截断，超出则精简 Few-shot 至 3 例 |
| 环境上下文 | ≤200 | 动态 | 日程超 5 条取前 5；标签超 10 个取前 10 |
| 对话历史 | ≤1200 | 动态 | 最多 3 轮(6条)，每条超 200 tokens 截断尾部 |
| 用户当前输入 | ≤200 | 动态 | 超长输入截断并追加 `[用户输入过长，已截断]` |
| **安全余量** | **≥3600** | — | 预留给模型推理+JSON输出，不可占用 |
| **总计硬上限** | **8000** | — | 超出时按 历史→环境→输入 顺序依次裁剪 |

**拼接代码模板：**
```javascript
const TOKEN_BUDGET = { persona: 800, env: 200, history: 1200, input: 200, reserve: 3600 };
const MAX_TOKENS = 8000;

const buildMessages = (userInput, env) => {
  const messages = [
    { role: "system", content: EJ_PERSONA_PROMPT }, // ≤800
    { role: "system", content: buildEnvBlock(env) }, // ≤200
    ...buildHistoryBlock(env.history),               // ≤1200
    { role: "user", content: truncate(userInput, 200) } // ≤200
  ];
  
  const estimated = estimateTokens(messages);
  if (estimated > MAX_TOKENS - TOKEN_BUDGET.reserve) {
    // 按优先级从低到高裁剪：历史 → 环境 → 输入
    trimToBudget(messages, MAX_TOKENS - TOKEN_BUDGET.reserve);
  }
  return messages;
};
```

### 4.3 Action 决策规则表

| 触发条件 | Action | Payload 必填 | `song_id` 合法值说明 |
| :--- | :--- | :--- | :--- |
| 用户明确点歌/提及歌手/流派/情绪 | `play_song` | `song_id`, `fallback_query`(条件必填) | **具体数字ID**：模型确信知道对应歌曲时直接指定**`"next_recommend"`**：无法确定具体歌曲时，信任推荐引擎；此时 `fallback_query` 必填，格式为 `"关键词1 关键词2"`，供 netease.js 搜索 |
| 闲聊/问候/表达情绪 | `speak_text` | `text` | — |
| 时间/日程/提醒相关 | `check_schedule` | `time_range`, `summary_type` | — |
| 上轮 speak_text 且有 follow_up | `play_song` | `song_id` | 必须为**具体数字ID**，禁止 `"next_recommend"` |
| 以上均不匹配 | `speak_text` | `text`: 轻量引导语 | — |

**优先级：** `check_schedule` > `play_song` > `speak_text`

**`song_id` 解析流程（netease.js 强制执行，使用 ncm CLI）：**
```javascript
const { execFile } = require('child_process');
const NCM_BIN = process.env.NCM_BIN || 'ncm'; // ncm-cli 二进制路径

function ncm(args) {
  return new Promise((resolve, reject) => {
    execFile(NCM_BIN, [...args, '--json'], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

async function resolveSong(songId, fallbackQuery) {
  // 1. 具体 ID → 直接通过 ncm url 获取直链
  if (songId !== 'next_recommend') {
    const urlResult = await ncm(['url', songId]);
    if (urlResult.url) return { url: urlResult.url, id: songId };
  }
  // 2. next_recommend + fallback_query → ncm search 后取第一条
  if (fallbackQuery) {
    const searchResult = await ncm(['search', 'song', '--keyword', fallbackQuery, '--limit', '5']);
    const songs = searchResult.songs || searchResult;
    if (songs && songs.length > 0) {
      const best = songs[0];
      const urlResult = await ncm(['url', best.id]);
      if (urlResult.url) return { url: urlResult.url, id: best.id, name: best.name, artist: best.ar?.[0]?.name };
    }
  }
  // 3. 兜底 → 本地 fallback 音乐
  return getLocalFallback();
}
```

> **ncm CLI 核心命令速查：**
> - `ncm search song --keyword "xxx" --limit 5 --json` → 搜索歌曲
> - `ncm url <songId> --json` → 获取播放地址（含权限/可用性标识）
> - `ncm song <songId> --json` → 歌曲元数据（含封面 `al.picUrl`）
> - `ncm recommend songs --limit 30 --json` → 每日推荐
> - `ncm lyric <songId> --raw` → 歌词
> - `ncm me --json` → 校验登录态
> - `ncm record --week --limit 30 --json` → 播放记录

## 5. 前端 PWA 展示与交互规范

### 5.1 视觉基准
-   暗色模式 Only，背景 `#121212`，强调色 `#FFB300`。
-   Mobile First，桌面端 max-width: 480px 居中。
-   SPA 无刷新，CSS 过渡动画切换视图。

### 5.2 三大视图 + 底部导航

#### 视图定义
-   **Player：** 动态封面（120×120 黑胶效果）、AI 状态指示器、信息流（max-height: 40vh）、极简控制栏、底部快捷输入框。
-   **Profile：** 品味雷达图、记忆时间线、语料在线编辑。
-   **Settings：** AI 人格调节、服务绑定状态灯、UPnP 设备管理、PWA 缓存管理。

#### 底部导航栏（tab-bar）
-   三 Tab：🎵 Player / 👤 Profile / ⚙️ Settings
-   固定于 `#app` 容器底部，`flex-shrink: 0`
-   布局：`#app` 为 `flex-direction: column`，view 区 `flex: 1; min-height: 0; overflow-y: auto`，tab-bar 为最后一个子元素
-   视图切换使用 `display: none/flex` + CSS animation（禁止 `position: absolute`，防止脱离正常流导致 tab-bar 位置异常）

### 5.3 前端强制约束
-   双 `<audio>` 预加载，剩余 10s 静默加载下一首。
-   UI 状态全部由 WS 驱动，禁止轮询。
-   原生 CustomEvent + 全局 Store，禁止 Redux/Pinia。
-   Web Audio API 处理音频，禁止第三方播放器 SDK。
-   Service Worker 离线兜底，断网可播缓存。

## 6. ⚠️ 工程化防坑清单（强制执行）

### 6.1 🔑 网易云 CLI 登录态自动管理
-   `.env` 无需存储密码，CLI 自带 `ncm login` 扫码/网页授权。
-   服务启动时执行 `ncm me --json` 校验登录态是否有效；无效则提示用户运行 `ncm login`。
-   CLI 自动将登录态持久化到 `~/.config/ncm-cli/session/`，服务端无需管理 Cookie。
-   广告情况：ncm-cli 返回的是纯净 JSON 数据结构，无音频贴片广告、弹窗或推广内容。

### 6.2 🎵 音乐直链有效期与缓存失效
-   URL 缓存对象记录 `expireAt`，播放前校验，过期自动重新获取。
-   前端监听 `error` 事件，自动重试最多 3 次。

### 6.3 🗣️ TTS 音频格式统一与转码兜底
-   强制请求 `mp3 + 44100Hz`，服务端 ffmpeg 转码兜底，无 ffmpeg 降级 WAV。

### 6.4 📡 WebSocket 断线重连与消息缓冲
-   指数退避重连（1s→2s→4s→8s→30s），断线期间缓存输入，重连后批量发送。
-   后端连接建立时主动推送完整 `NOW_PLAYING` 同步状态。

## 7. 冷启动、全链路降级与意图前置拦截规范

> ⚠️ **核心原则：** 本章逻辑优先级高于 DeepSeek 决策，必须在 Router 层或 Context 组装前完成，禁止透传异常给 LLM。

### 7.1 冷启动体验
| 检测条件 | 触发动作 | 具体行为 |
| :--- | :--- | :--- |
| `conversationHistory` 为空（首次对话） | 强制 `speak_text` | 固定欢迎语 + 安全曲目(`1901371647`)，不调 DeepSeek |
| `conversationHistory` 不为空 | 正常 AI 决策 | 走 DeepSeek 决策链路 |

> ⚠️ **实现注意：** 冷启动检测必须基于 `conversationHistory`（会话级），不可基于 `recentPlays`/`tasteTags`（数据级）。因为冷启动分支不会更新 `recentPlays`/`tasteTags`，使用这些字段会导致每次请求都被判定为冷启动的死循环。

**固定欢迎语（硬编码）：** "你好，我是 Claudio。这是我们的第一次见面，我还不太了解你的口味。不如先从一首轻松的歌开始，慢慢熟悉彼此？"

### 7.2 全链路降级矩阵
#### 单服务降级
| 故障服务 | 降级策略 | 用户感知 |
| :--- | :--- | :--- |
| DeepSeek | 本地规则引擎（时段+天气匹配预设歌单） | 黄色警示条"AI 思考中，已切换离线模式" |
| Netease | 播放 `/src/data/fallback/` 本地兜底音乐 | 灰色占位图+"离线曲库"标签 |
| Fish Audio | 跳过语音，文字气泡推送 | "🔇 语音暂不可用，文字版已送达" |

#### 组合故障降级
| 故障组合 | 降级策略 |
| :--- | :--- |
| DeepSeek + Netease | 本地兜底音乐 + 固定文字气泡 |
| DeepSeek + Fish | 本地规则选歌 + 文字气泡 |
| Netease + Fish | DeepSeek 正常 + 文字气泡 + 本地兜底音乐 |
| **三者全挂** | SW 接管，播放 PWA 缓存，全屏离线遮罩 |

**降级约束：** 所有外部调用包裹 `try-catch` + AbortController；降级状态写入 `state.json.degradedServices` 并 WS 推送；恢复后自动清除标记；兜底音乐随项目提交。

### 7.3 用户意图前置拦截（Fast Path）
以下指令**禁止**发送给 DeepSeek，在 Router 层直接处理：
| 输入模式 | 匹配正则 | 直接执行 |
| :--- | :--- | :--- |
| 音量控制 | `/^(大点声\|小点声\|调高\|调低\|静音)$/` | UPnP/AudioEngine 音量调整 |
| 播放控制 | `/^(暂停\|继续\|下一首\|上一首\|切歌)$/` | AudioEngine 对应方法 |
| 进度控制 | `/^(快进\|快退\|跳到\d+分\d+秒)$/` | AudioEngine.seek() |
| 设备切换 | `/^(切换到\|投到).*(音响\|音箱)$/` | UPnP 设备搜索绑定 |

**拦截约束：** 放在 `/api/chat` 最顶部；正则匹配，零延迟；命中不计入对话历史。

### 7.4 必测用例
AI 生成代码必须包含：①冷启动欢迎验证 ②DeepSeek 500 降级验证 ③Netease CLI 未登录兜底验证 ④"大点声"拦截验证 ⑤组合故障验证 ⑥拦截后正常请求验证。

## 8. AI 开发引导 Prompt

> **Role:** 精通 Node.js / PWA / LLM 应用开发的高级全栈工程师。
>
> **Task:** 根据《Claudio 全栈开发实施文档 (修正后最终版)》编写核心代码。
>
> **Constraints:**
> 1.  使用 `openai` SDK 调 DeepSeek，baseURL 设为 `https://api.deepseek.com`，开启 JSON Mode。
> 2.  `src/server/prompts/ej-persona.md` 和 `context.js` 拼接逻辑必须严格按照文档第 4 章模板实现，禁止自行创作 prompt 内容。
> 3.  JSON Schema 校验、Token 预算分配、song_id 解析流程必须严格按文档 3.2 / 4.2 / 4.3 实现，禁止自行简化或合并字段。
> 4.  严格落实第 6 章「工程化防坑清单」的全部 4 项要求。其中 6.1 节网易云使用 ncm-cli（`ncm` 命令），无需 `NeteaseCloudMusicApi` 包。
> 5.  严格落实第 7 章冷启动、降级矩阵与前置拦截的全部规则，生成代码时必须包含 7.4 节要求的 6 个测试用例。
> 6.  前端先输出 HTML 骨架与 CSS 变量表，确认视觉基调后再写 JS 逻辑。
> 7.  `AudioEngine.js` 单独封装双 audio 切换逻辑，附详细时序注释。
> 8.  前后端 WS 消息类型枚举需先对齐再实现。
> 9.  **第一步仅生成 `package.json` 依赖列表与目录树**，确认后逐步实现各模块。
>
> **Question:** 你理解这份文档了吗？如果理解了，请列出你需要安装的 npm 包列表，并确认你已注意到第 3.2、4.2、4.3 节的 Schema/Token/song_id 强制规范以及第 6、7 章的全部工程约束。