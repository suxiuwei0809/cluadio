import { chatCompletion, CHAT_RESPONSE_SCHEMA } from './deepseek.js';
import { buildMessages } from './context.js';
import { resolveSong, getLocalFallback } from './netease.js';
import { validateResponse } from './schema.js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

// ---- 状态文件 ----
const STATE_PATH = join(process.cwd(), 'src', 'data', 'state.json');
const WELCOME_SONG_ID = '1901371647';
const WELCOME_TEXT = '你好，我是 Claudio。这是我们的第一次见面，我还不太了解你的口味。不如先从一首轻松的歌开始，慢慢熟悉彼此？';

// ---- 7.3 节强制前置拦截正则表（零延迟，禁止透传 LLM）----
const FAST_PATH_RULES = [
  { pattern: /^(大点声|小点声|调高|调低|静音)$/, action: 'VOLUME_CONTROL' },
  { pattern: /^(暂停|继续|下一首|上一首|切歌)$/, action: 'PLAYBACK_CONTROL' },
  { pattern: /^(快进|快退|跳到\d+分\d+秒)$/, action: 'SEEK_CONTROL' },
  { pattern: /^(切换到|投到).*(音响|音箱)$/, action: 'DEVICE_SWITCH' }
];

/**
 * 前置拦截检查
 * @returns {Object|null} 命中则返回 {action, raw}，未命中返回 null
 */
function checkFastPath(input) {
  const trimmed = input.trim();
  for (const rule of FAST_PATH_RULES) {
    if (rule.pattern.test(trimmed)) {
      return { action: rule.action, raw: trimmed };
    }
  }
  return null;
}

/**
 * 本地预设回复：根据用户输入匹配 5 种场景，返回对应文案。
 * @param {string} input - 用户输入
 * @param {number} hour - 当前小时
 * @returns {string} 预设回复文本
 */
function matchLocalReply(input, hour) {
  const t = input.trim();

  // 1. 早安 / 起床场景
  if (/早安|早上好|起床|morning|早啊|早晨/i.test(t)) {
    const morning = [
      '早安！新的一天从一段好音乐开始吧。给你挑了一首清晨专属的旋律，慢慢醒来～',
      '早啊，今天阳光不错的感觉。来首轻快的歌，陪你开启元气满满的一天。',
      '早上好！一杯咖啡，一首好歌，这个早晨就很完美了。来听听这首～'
    ];
    return morning[Math.floor(Math.random() * morning.length)];
  }

  // 2. 来首歌 / 放歌 / 推荐场景
  if (/来首|放首|放歌|推荐|随便|播|来点|听歌|听点|来一个/i.test(t)) {
    const songs = [
      '好的，给你挑了一首很适合现在听的歌。希望你会喜欢～',
      '来了！这首曲子跟现在的氛围挺搭的，戴上耳机享受吧。',
      '没问题，帮你选了一首。不喜欢的话随时跟我说"换一首"哦。',
      '安排上了！这首歌我个人很推荐，旋律一响起就停不下来。'
    ];
    return songs[Math.floor(Math.random() * songs.length)];
  }

  // 3. 晚安 / 睡觉场景
  if (/晚安|睡了|睡觉|night|困了|休息/i.test(t)) {
    const night = [
      '晚安～给你放一首安静舒缓的曲子，伴你入眠。做个好梦。',
      '该休息啦。这首慢歌很温柔，闭上眼睛享受这一刻吧。晚安。',
      '夜深了，世界安静下来。让这首歌陪你慢慢入睡，明天见～'
    ];
    return night[Math.floor(Math.random() * night.length)];
  }

  // 4. 心情 / 情绪表达
  if (/开心|高兴|快乐|难过|伤心|累了|无聊|烦|郁闷|happy|sad|tired/i.test(t)) {
    const mood = [
      '音乐是最好的情绪解药。不管你现在是什么心情，这首歌都会陪着你。',
      '我懂。有时候不需要太多话，一首对的歌就够了。来听听这首～',
      '情绪有起伏很正常。给你放一首治愈系的歌，听完会好一点。'
    ];
    return mood[Math.floor(Math.random() * mood.length)];
  }

  // 5. 通用 / 闲聊兜底
  const general = [
    '嗯，我在听。给你放首好听的歌吧，边听边聊～',
    '收到！虽然我还不会聊太深的话题，但我很会挑歌哦。试试这首？',
    '哈哈，这个问题问得好。不如先听首歌，我再慢慢想答案～',
    '跟你聊天很开心。来，这首曲子送给你，很适合现在的心情。',
    '明白了。让我用音乐来回应你吧，这首应该对你的胃口。'
  ];
  return general[Math.floor(Math.random() * general.length)];
}

// ---- 运行时状态 ----
let appState = {
  nowPlaying: null,
  degradedServices: [],
  volume: 80,
  isPlaying: false,
  weather: null,
  calendar: [],
  tasteTags: [],
  playHistory: [],
  conversationHistory: [],
  deepseekEnabled: false   // 默认关闭，需手动开启
};

let wsClients = new Set();

async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    if (saved.degradedServices) appState.degradedServices = saved.degradedServices;
    if (saved.volume != null) appState.volume = saved.volume;
    if (saved.tasteTags) appState.tasteTags = saved.tasteTags;
    if (saved.playHistory) appState.playHistory = saved.playHistory;
    if (saved.conversationHistory) appState.conversationHistory = saved.conversationHistory;
    if (saved.deepseekEnabled != null) appState.deepseekEnabled = saved.deepseekEnabled;
  } catch { /* 首次运行，使用默认值 */ }
}

async function saveState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const saved = JSON.parse(raw);
    saved.degradedServices = appState.degradedServices;
    saved.volume = appState.volume;
    saved.tasteTags = appState.tasteTags;
    saved.playHistory = appState.playHistory;
    saved.conversationHistory = appState.conversationHistory;
    saved.deepseekEnabled = appState.deepseekEnabled;
    await writeFile(STATE_PATH, JSON.stringify(saved, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

/**
 * 注册所有 API 路由
 */
export async function registerRoutes(fastify) {
  await loadState();

  // ---- 环境上下文中间件 ----
  fastify.addHook('preHandler', async (request) => {
    request.envContext = {
      now: new Date(),
      weekday: ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()],
      weather: appState.weather || null,
      recentPlays: (appState.playHistory || []).slice(-5),
      calendar: appState.calendar || [],
      tasteTags: appState.tasteTags || [],
      history: appState.conversationHistory || []
    };
  });

  // ============================================================
  // POST /api/chat - 核心对话入口
  // ============================================================
  fastify.post('/api/chat', {
    schema: {
      body: { type: 'object', required: ['input'], properties: { input: { type: 'string' } } },
      response: { 200: CHAT_RESPONSE_SCHEMA } // 3.2 响应校验
    }
  }, async (request, reply) => {
    const { input } = request.body;

    // ✅ 7.3 前置拦截：命中直接返回，不调 DeepSeek，不计入历史
    const fastPath = checkFastPath(input);
    if (fastPath) {
      console.log(`[FastPath] Hit: ${fastPath.action} <- "${fastPath.raw}"`);

      // 执行实际控制逻辑
      const { action, raw } = fastPath;
      if (action === 'VOLUME_CONTROL') {
        if (raw === '大点声' || raw === '调高') { appState.volume = Math.min(100, appState.volume + 10); }
        else if (raw === '小点声' || raw === '调低') { appState.volume = Math.max(0, appState.volume - 10); }
        else if (raw === '静音') { appState.volume = 0; }
        broadcast('VOLUME_CHANGED', { volume: appState.volume });
        await saveState();
      }
      if (action === 'PLAYBACK_CONTROL') {
        if (raw === '暂停') { appState.isPlaying = false; broadcast('PLAYBACK_STATE', { isPlaying: false }); }
        else if (raw === '继续') { appState.isPlaying = true; broadcast('PLAYBACK_STATE', { isPlaying: true }); }
        else if (raw === '下一首' || raw === '切歌') { broadcast('PLAYBACK_STATE', { action: 'next' }); }
        else if (raw === '上一首') { broadcast('PLAYBACK_STATE', { action: 'prev' }); }
      }

      return reply.send({
        action: 'speak_text',
        payload: { text: '', reasoning: `前置拦截: ${fastPath.action}` }
      });
    }

    // ✅ 7.1 冷启动检测（仅第一次对话触发，之后走 AI 链路）
    const env = request.envContext;
    const hasHistory = env.history && env.history.length > 0;

    if (!hasHistory) {
      // 冷启动：直接走本地兜底音乐，不依赖 ncm
      console.log('[router] 冷启动分支: 首次对话，使用欢迎语');
      const resolved = await getLocalFallback();
      console.log('[router] getLocalFallback result:', JSON.stringify(resolved));
      broadcast('AI_SPEAKING', { text: WELCOME_TEXT, song_id: WELCOME_SONG_ID });
      if (resolved.url) {
        appState.nowPlaying = { songId: WELCOME_SONG_ID, url: resolved.url, name: resolved.name };
        broadcast('NOW_PLAYING', appState.nowPlaying);
      }
      appState.conversationHistory.push(
        { role: 'user', content: input },
        { role: 'assistant', content: JSON.stringify({ action: 'speak_text', payload: { text: WELCOME_TEXT, follow_up_song_id: WELCOME_SONG_ID, reasoning: '冷启动欢迎' } }) }
      );
      return reply.send({
        action: 'speak_text',
        payload: {
          text: WELCOME_TEXT,
          follow_up_song_id: WELCOME_SONG_ID,
          _resolvedUrl: resolved.url,
          _resolvedName: resolved.name,
          _branch: 'cold_start'
        }
      });
    }

    // ✅ DeepSeek 开关：关闭时走本地预设回复 + 按时段推荐
    if (!appState.deepseekEnabled) {
      console.log('[router] DeepSeek 已关闭，使用本地预设回复');
      const hour = new Date().getHours();
      let query = '华语经典 流行';
      if (hour >= 6 && hour < 10) query = '清晨 轻音乐 舒缓';
      else if (hour >= 10 && hour < 14) query = '午后 爵士 慵懒';
      else if (hour >= 18 && hour < 22) query = '黄昏 流行 温暖';
      else if (hour >= 22 || hour < 6) query = '深夜 慢歌 安静';

      // 本地预设回复：根据用户输入匹配 5 种场景
      const localReply = matchLocalReply(input, hour);
      const resolved = await resolveSong('next_recommend', query);

      appState.conversationHistory.push(
        { role: 'user', content: input },
        { role: 'assistant', content: JSON.stringify({ action: 'speak_text', payload: { text: localReply, follow_up_song_id: 'next_recommend', reasoning: '本地预设回复' } }) }
      );

      return reply.send({
        action: 'speak_text',
        payload: {
          text: localReply,
          follow_up_song_id: 'next_recommend',
          reasoning: '本地预设回复',
          _resolvedUrl: resolved.url,
          _resolvedName: resolved.name,
          _branch: 'local_reply'
        }
      });
    }

    try {
      // 正常 AI 决策链路
      const messages = await buildMessages(input, env);
      const aiResponse = await chatCompletion(messages);

      // Schema 校验
      const validation = validateResponse(aiResponse);
      if (!validation.valid) {
        console.warn('[router] AI 响应校验失败，降级处理');
        throw Object.assign(new Error('Schema validation failed'), { code: 'DEEPSEEK_ERROR' });
      }

      // ✅ 4.3 song_id 解析：play_song 时自动解析直链
      if (aiResponse.action === 'play_song') {
        const resolved = await resolveSong(
          aiResponse.payload.song_id,
          aiResponse.payload.fallback_query
        );
        aiResponse.payload._resolvedUrl = resolved.url;
        aiResponse.payload._resolvedName = resolved.name;
      }

      // 分发 action 事件
      if (aiResponse.action === 'speak_text') {
        broadcast('AI_SPEAKING', { text: aiResponse.payload.text });
        if (aiResponse.payload.follow_up_song_id) {
          console.log('[router] speak_text with follow_up_song_id:', aiResponse.payload.follow_up_song_id);
          const resolved = await resolveSong(aiResponse.payload.follow_up_song_id);
          console.log('[router] resolveSong result:', JSON.stringify(resolved));
          // 把解析结果回填到 payload，前端直接可用
          aiResponse.payload._resolvedUrl = resolved.url;
          aiResponse.payload._resolvedName = resolved.name;
          aiResponse.payload._branch = 'ai_speak_text';
          if (resolved.url) {
            appState.nowPlaying = { songId: aiResponse.payload.follow_up_song_id, url: resolved.url, name: resolved.name };
            broadcast('NOW_PLAYING', appState.nowPlaying);
          }
        }
      }
      if (aiResponse.action === 'play_song') {
        if (aiResponse.payload._resolvedUrl) {
          appState.nowPlaying = { songId: aiResponse.payload.song_id, url: aiResponse.payload._resolvedUrl, name: aiResponse.payload._resolvedName };
          broadcast('NOW_PLAYING', appState.nowPlaying);
          appState.playHistory.push({
            song: aiResponse.payload._resolvedName || aiResponse.payload.song_id,
            artist: '',
            time: new Date().toISOString()
          });
        }
      }
      if (aiResponse.action === 'check_schedule') {
        const cal = appState.calendar || [];
        const text = cal.length
          ? `今天有 ${cal.length} 项安排：${cal.map(c => `${c.time} ${c.title}`).join('，')}`
          : '今天没有日程安排，安心享受音乐吧。';
        broadcast('AI_SPEAKING', { text });
      }

      // 恢复降级标记（DeepSeek 恢复正常）
      if (appState.degradedServices.includes('deepseek')) {
        appState.degradedServices = appState.degradedServices.filter(s => s !== 'deepseek');
        await saveState();
        broadcast('DEGRADED_STATUS', { service: 'deepseek', status: 'recovered' });
      }

      // 记录对话历史
      appState.conversationHistory.push(
        { role: 'user', content: input },
        { role: 'assistant', content: JSON.stringify(aiResponse) }
      );

      return reply.send(aiResponse);

    } catch (err) {
      // ✅ 7.2 降级：DeepSeek 异常时切换本地规则引擎
      if (err.code === 'DEEPSEEK_ERROR') {
        console.warn('[Degrade] DeepSeek failed:', err.message);

        // 标记降级
        if (!appState.degradedServices.includes('deepseek')) {
          appState.degradedServices.push('deepseek');
          await saveState();
        }
        broadcast('DEGRADED_STATUS', { service: 'deepseek', status: 'degraded' });

        // 本地规则引擎：按时段匹配
        const hour = new Date().getHours();
        let query = '华语经典 流行';
        if (hour >= 6 && hour < 10) query = '清晨 轻音乐 舒缓';
        else if (hour >= 10 && hour < 14) query = '午后 爵士 慵懒';
        else if (hour >= 18 && hour < 22) query = '黄昏 流行 温暖';
        else if (hour >= 22 || hour < 6) query = '深夜 慢歌 安静';

        const resolved = await resolveSong('next_recommend', query);
        return reply.send({
          action: 'play_song',
          payload: {
            song_id: 'next_recommend',
            fallback_query: query,
            reasoning: 'AI 服务暂不可用，已切换离线推荐',
            _resolvedUrl: resolved.url,
            _resolvedName: resolved.name
          }
        });
      }
      throw err;
    }
  });

  // ============================================================
  // GET /api/now - 当前播放状态
  // ============================================================
  fastify.get('/api/now', async () => {
    return {
      nowPlaying: appState.nowPlaying,
      volume: appState.volume,
      isPlaying: appState.isPlaying,
      degradedServices: appState.degradedServices,
      deepseekEnabled: appState.deepseekEnabled
    };
  });

  // ============================================================
  // GET /api/song/:id - 按 ID 获取歌曲直链
  // ============================================================
  fastify.get('/api/song/:id', async (request) => {
    const { id } = request.params;
    const resolved = await resolveSong(id);
    return { url: resolved.url, name: resolved.name, source: resolved.source };
  });

  // ============================================================
  // GET /api/next - 下一首预览（预留）
  // ============================================================
  fastify.get('/api/next', async () => {
    return { next: null };
  });

  // ============================================================
  // GET /api/taste - 用户品味画像
  // ============================================================
  fastify.get('/api/taste', async () => {
    return { tasteTags: appState.tasteTags || [] };
  });

  // ============================================================
  // GET /api/plan/today - 今日日程
  // ============================================================
  fastify.get('/api/plan/today', async () => {
    return { calendar: appState.calendar || [] };
  });

  // ============================================================
  // POST /api/state - 更新天气/日程等环境数据
  // ============================================================
  fastify.post('/api/state', async (request) => {
    const { weather, calendar, tasteTags } = request.body || {};
    if (weather) appState.weather = weather;
    if (calendar) appState.calendar = calendar;
    if (tasteTags) appState.tasteTags = tasteTags;
    await saveState();
    return { ok: true };
  });

  // ============================================================
  // GET /api/deepseek/toggle - 读取 DeepSeek 开关状态
  // ============================================================
  fastify.get('/api/deepseek/toggle', async () => {
    return { deepseekEnabled: appState.deepseekEnabled };
  });

  // ============================================================
  // POST /api/deepseek/toggle - 切换 DeepSeek 开关
  // ============================================================
  fastify.post('/api/deepseek/toggle', async (request) => {
    const { enabled } = request.body || {};
    if (typeof enabled !== 'boolean') {
      return { error: 'enabled must be a boolean', ok: false };
    }
    appState.deepseekEnabled = enabled;
    await saveState();
    broadcast('DEEPSEEK_TOGGLE', { enabled });
    console.log(`[router] DeepSeek 已${enabled ? '开启' : '关闭'}`);
    return { ok: true, deepseekEnabled: enabled };
  });

  // ============================================================
  // WS /stream - 实时推送（Spec 3.3）
  // 消息类型: NOW_PLAYING | AI_SPEAKING | DEVICE_STATUS |
  //           DEGRADED_STATUS | VOLUME_CHANGED | PLAYBACK_STATE | DEEPSEEK_TOGGLE
  // ============================================================
  fastify.get('/stream', { websocket: true }, (connection) => {
    const socket = connection.socket;
    wsClients.add(socket);

    // ✅ 6.4 连接建立时主动推送完整 NOW_PLAYING 同步状态
    socket.send(JSON.stringify({
      type: 'NOW_PLAYING',
      payload: appState.nowPlaying || { songId: null, url: null },
      ts: Date.now()
    }));
    socket.send(JSON.stringify({
      type: 'VOLUME_CHANGED',
      payload: { volume: appState.volume },
      ts: Date.now()
    }));
    socket.send(JSON.stringify({
      type: 'PLAYBACK_STATE',
      payload: { isPlaying: appState.isPlaying },
      ts: Date.now()
    }));
    if (appState.degradedServices.length > 0) {
      socket.send(JSON.stringify({
        type: 'DEGRADED_STATUS',
        payload: { services: appState.degradedServices },
        ts: Date.now()
      }));
    }
    socket.send(JSON.stringify({
      type: 'DEEPSEEK_TOGGLE',
      payload: { enabled: appState.deepseekEnabled },
      ts: Date.now()
    }));

    socket.on('close', () => wsClients.delete(socket));

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'PING') {
          socket.send(JSON.stringify({ type: 'PONG', ts: Date.now() }));
        }
        if (data.type === 'PLAYBACK_STATE') {
          appState.isPlaying = data.payload?.isPlaying ?? appState.isPlaying;
        }
      } catch { /* 非法消息，忽略 */ }
    });
  });

  console.log('[router] 路由注册完成');
}

export { appState, broadcast };
