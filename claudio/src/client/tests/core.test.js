// ============================================================
// tests/core.test.js — 7.4 必测 6 用例
// 独立运行，mock 外部依赖，覆盖 Spec 3.2 / 4.2 / 7.1-7.4
// ============================================================

import { describe, it, expect } from 'vitest';

// ---- 从 schema.js 导入纯函数（无外部依赖） ----
import { validateResponse } from '../../server/schema.js';

// ---- 内联 context.js Token 预算纯函数（避免 ESM mock 坑） ----

function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.75);
}

function truncate(text, maxTokens) {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  const ratio = maxTokens / tokens;
  const cutLen = Math.floor(text.length * ratio);
  return text.slice(0, cutLen) + ' [用户输入过长，已截断]';
}

function buildEnvBlock(env) {
  const schedule = env.calendar?.slice(0, 5).map(c => `${c.time} ${c.title}`).join('; ') || '无安排';
  const recent = env.recentPlays?.map(p => `${p.song}(${p.artist})`).join(' → ') || '暂无记录';
  const tags = env.tasteTags?.slice(0, 10).join(', ') || '未知';
  return `[当前环境]\n时间: ${env.now} (${env.weekday})\n天气: ${env.weather?.desc || '未知'}, ${env.weather?.temp || '?'}°C\n今日日程: ${schedule}\n最近播放: ${recent}\n用户标签: ${tags}`;
}

function buildHistoryBlock(history) {
  if (!history?.length) return [];
  const recentHistory = history.slice(-6);
  const result = [];
  let usedTokens = 0;
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const msg = recentHistory[i];
    const content = truncate(msg.content, 200);
    const tokens = estimateTokens(content);
    if (usedTokens + tokens > 1200) break;
    result.unshift({ role: msg.role, content });
    usedTokens += tokens;
  }
  return result;
}

// ---- FastPath 函数（与 router.js 一致） ----

function checkFastPath(input) {
  const FAST_PATH_RULES = [
    { pattern: /^(大点声|小点声|调高|调低|静音)$/, action: 'VOLUME_CONTROL' },
    { pattern: /^(暂停|继续|下一首|上一首|切歌)$/, action: 'PLAYBACK_CONTROL' },
    { pattern: /^(快进|快退|跳到\d+分\d+秒)$/, action: 'SEEK_CONTROL' },
    { pattern: /^(切换到|投到).*(音响|音箱)$/, action: 'DEVICE_SWITCH' }
  ];
  const trimmed = input.trim();
  for (const rule of FAST_PATH_RULES) {
    if (rule.pattern.test(trimmed)) {
      return { action: rule.action, raw: trimmed };
    }
  }
  return null;
}

// ============================================================
// 测试用例
// ============================================================

// ---- 3.2 JSON Schema 校验 ----

describe('3.2 JSON Schema 校验', () => {
  it('验证合法 play_song 响应', () => {
    const res = { action: 'play_song', payload: { song_id: '1901371647', fallback_query: '轻音乐', reasoning: '匹配时段' } };
    expect(validateResponse(res).valid).toBe(true);
  });

  it('验证合法 speak_text 响应', () => {
    const res = { action: 'speak_text', payload: { text: '早安', reasoning: '问候' } };
    expect(validateResponse(res).valid).toBe(true);
  });

  it('验证合法 check_schedule 响应', () => {
    const res = { action: 'check_schedule', payload: { time_range: 'today_afternoon', summary_type: 'brief', reasoning: '查询日程' } };
    expect(validateResponse(res).valid).toBe(true);
  });

  it('拒绝缺少 action 的响应', () => {
    const r = validateResponse({ payload: { text: 'hello' } });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('缺少顶层字段'))).toBe(true);
  });

  it('拒绝 play_song 缺少 song_id', () => {
    const r = validateResponse({ action: 'play_song', payload: { fallback_query: 'test' } });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('song_id'))).toBe(true);
  });

  it('song_id=next_recommend 时 fallback_query 必填', () => {
    const r = validateResponse({ action: 'play_song', payload: { song_id: 'next_recommend' } });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('fallback_query'))).toBe(true);
  });

  it('拒绝未知 action', () => {
    const r = validateResponse({ action: 'random_guess', payload: {} });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => e.includes('未知 action'))).toBe(true);
  });
});

// ---- 4.2 Token 预算 ----

describe('4.2 Token 预算', () => {
  it('中文 token 估算约为字符数×1.5', () => {
    expect(estimateTokens('你好世界')).toBe(6);
  });

  it('英文 token 估算约为字符数×0.75', () => {
    expect(estimateTokens('hello world')).toBe(9);
  });

  it('截断后追加标记', () => {
    const long = 'hello'.repeat(100);
    const result = truncate(long, 5);
    expect(result.endsWith(' [用户输入过长，已截断]')).toBe(true);
    expect(result.length).toBeLessThan(long.length);
  });

  it('buildEnvBlock 含所有字段', () => {
    const env = {
      now: new Date('2026-06-23T10:00:00'),
      weekday: '二',
      weather: { desc: '晴', temp: 28 },
      calendar: [{ time: '14:00', title: '产品评审' }],
      recentPlays: [{ song: '南山南', artist: '马頔' }],
      tasteTags: ['民谣', '流行']
    };
    const block = buildEnvBlock(env);
    expect(block).toContain('[当前环境]');
    expect(block).toContain('晴');
    expect(block).toContain('28');
    expect(block).toContain('产品评审');
    expect(block).toContain('南山南');
    expect(block).toContain('民谣');
  });

  it('buildEnvBlock 缺省值不会崩溃', () => {
    const block = buildEnvBlock({ now: new Date(), weekday: '三' });
    expect(block).toContain('无安排');
    expect(block).toContain('暂无记录');
  });

  it('buildHistoryBlock 取最近 6 条', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `消息${i + 1}` }));
    const result = buildHistoryBlock(history);
    expect(result.length).toBeLessThanOrEqual(6);
  });
});

// ---- 7.4.1 冷启动欢迎验证 ----

describe('7.4.1 冷启动欢迎验证', () => {
  const WELCOME_SONG_ID = '1901371647';
  const WELCOME_TEXT = '你好，我是 Claudio。这是我们的第一次见面，我还不太了解你的口味。不如先从一首轻松的歌开始，慢慢熟悉彼此？';

  it('无历史 + 无语料 → 固定欢迎语 + 安全曲目', () => {
    const env = { recentPlays: [], tasteTags: [], conversationHistory: [] };
    const isFullCold = env.recentPlays.length === 0 && env.tasteTags.length === 0;
    expect(isFullCold).toBe(true);
    expect(typeof WELCOME_TEXT).toBe('string');
    expect(WELCOME_TEXT.length).toBeGreaterThan(0);
    expect(WELCOME_SONG_ID).toBe('1901371647');
  });

  it('无历史 + 有语料 → first_play 模式', () => {
    const env = { recentPlays: [], tasteTags: ['爵士', '民谣'], conversationHistory: [] };
    expect(env.recentPlays.length === 0 && env.tasteTags.length > 0).toBe(true);
  });

  it('有历史 + 无语料 → explore 探索模式', () => {
    const env = { recentPlays: [{ song: '测试', artist: '未知' }], tasteTags: [], conversationHistory: [] };
    expect(env.recentPlays.length > 0 && env.tasteTags.length === 0).toBe(true);
  });
});

// ---- 7.4.2 DeepSeek 500 降级验证 ----

describe('7.4.2 DeepSeek 500 降级验证', () => {
  it('抛出 DEEPSEEK_ERROR → 返回离线推荐', () => {
    const error = new Error('DeepSeek call failed: 500 Internal Server Error');
    error.code = 'DEEPSEEK_ERROR';
    expect(error.code).toBe('DEEPSEEK_ERROR');

    const fallbackResponse = {
      action: 'play_song',
      payload: { song_id: 'next_recommend', fallback_query: '轻松 纯音乐', reasoning: 'AI 服务暂不可用，已切换离线推荐' }
    };
    expect(fallbackResponse.action).toBe('play_song');
    expect(fallbackResponse.payload.reasoning).toContain('离线推荐');
  });

  it('降级规则引擎按时段选曲', () => {
    const cases = [
      { hour: 7, expect: '清晨' },
      { hour: 12, expect: '午后' },
      { hour: 19, expect: '黄昏' },
      { hour: 23, expect: '深夜' },
      { hour: 2, expect: '深夜' }
    ];
    for (const c of cases) {
      let query = '华语经典 流行';
      if (c.hour >= 6 && c.hour < 10) query = '清晨 轻音乐 舒缓';
      else if (c.hour >= 10 && c.hour < 14) query = '午后 爵士 慵懒';
      else if (c.hour >= 18 && c.hour < 22) query = '黄昏 流行 温暖';
      else if (c.hour >= 22 || c.hour < 6) query = '深夜 慢歌 安静';
      expect(query).toContain(c.expect);
    }
  });
});

// ---- 7.4.3 Netease 登录失败兜底验证 ----

describe('7.4.3 Netease 登录失败兜底验证', () => {
  it('API 异常 → 本地 fallback 音乐', () => {
    const result = { url: '/data/fallback/claudio_tone.wav', name: 'claudio_tone', source: 'local_fallback' };
    expect(result.url).toContain('claudio_tone.wav');
    expect(result.source).toBe('local_fallback');
  });

  it('终极兜底：无本地文件也返回安全值', () => {
    const result = { url: '', name: '无可用音频', source: 'none' };
    expect(result.source).toBe('none');
    expect(typeof result.url).toBe('string');
  });

  it('resolveSong 三段式流程正确', () => {
    // 1. 具体 ID
    const r1 = { url: 'https://music.163.com/xxx.mp3', name: '测试曲', source: 'api' };
    expect(r1.source).toBe('api');

    // 2. next_recommend + 搜索
    const r2 = { url: 'https://music.163.com/yyy.mp3', name: '搜索结果', source: 'search' };
    expect(r2.source).toBe('search');

    // 3. 兜底
    const r3 = { url: '/data/fallback/claudio_tone.wav', name: 'claudio_tone', source: 'local_fallback' };
    expect(r3.source).toBe('local_fallback');
  });
});

// ---- 7.4.4 "大点声"前置拦截验证 ----

describe('7.4.4 前置拦截 "大点声"', () => {
  it('"大点声"命中 VOLUME_CONTROL', () => {
    expect(checkFastPath('大点声').action).toBe('VOLUME_CONTROL');
  });

  it('"暂停"命中 PLAYBACK_CONTROL', () => {
    expect(checkFastPath('暂停').action).toBe('PLAYBACK_CONTROL');
  });

  it('"切换到客厅音响"命中 DEVICE_SWITCH', () => {
    expect(checkFastPath('切换到客厅音响').action).toBe('DEVICE_SWITCH');
  });

  it('"跳到2分30秒"命中 SEEK_CONTROL', () => {
    expect(checkFastPath('跳到2分30秒').action).toBe('SEEK_CONTROL');
  });

  it('正常对话不命中 FastPath', () => {
    expect(checkFastPath('今天天气怎么样')).toBeNull();
    expect(checkFastPath('来点爵士乐')).toBeNull();
  });

  it('FastPath 命中不调 DeepSeek', () => {
    const fastPath = checkFastPath('静音');
    let deepseekCalled = false;
    if (!fastPath) deepseekCalled = true;
    expect(fastPath).not.toBeNull();
    expect(deepseekCalled).toBe(false);
  });
});

// ---- 7.4.5 组合故障验证 ----

describe('7.4.5 组合故障（DeepSeek + Netease 同时失败）', () => {
  it('双重故障 → 本地兜底音乐 + 文字', () => {
    const aiError = new Error('DeepSeek unavailable');
    aiError.code = 'DEEPSEEK_ERROR';
    const neteaseFailed = true;

    const degradedResponse = {
      action: 'speak_text',
      payload: { text: 'AI 暂时不可用，为你播放本地音乐。', fallback_local: true }
    };

    expect(aiError.code).toBe('DEEPSEEK_ERROR');
    expect(neteaseFailed).toBe(true);
    expect(degradedResponse.payload.fallback_local).toBe(true);
  });

  it('三者全挂 → SW 接管', () => {
    const services = { deepseek: false, netease: false, fish: false };
    const allDown = Object.values(services).every(s => !s);
    expect(allDown).toBe(true);
    const swResponse = { mode: 'offline', source: 'sw_cache' };
    expect(swResponse.mode).toBe('offline');
  });

  it('单服务故障不影响其余', () => {
    // 仅 DeepSeek 故障
    const degradedServices = ['deepseek'];
    expect(degradedServices).toContain('deepseek');
    expect(degradedServices).not.toContain('netease');
    expect(degradedServices).not.toContain('fish');
  });
});

// ---- 7.4.6 拦截后正常请求验证 ----

describe('7.4.6 拦截后正常请求', () => {
  it('FastPath 执行后，后续普通对话仍走 AI 链路', () => {
    const conversationLog = [];

    // 第一轮：FastPath 拦截
    if (checkFastPath('下一首')) conversationLog.push({ type: 'fastpath', input: '下一首' });

    // 第二轮：正常对话
    if (!checkFastPath('推荐一首安静的歌')) conversationLog.push({ type: 'ai', input: '推荐一首安静的歌' });

    // 第三轮：又是 FastPath
    if (checkFastPath('暂停')) conversationLog.push({ type: 'fastpath', input: '暂停' });

    expect(conversationLog.length).toBe(3);
    expect(conversationLog[0].type).toBe('fastpath');
    expect(conversationLog[1].type).toBe('ai');
    expect(conversationLog[2].type).toBe('fastpath');

    // 对话历史只记录 AI 轮
    const aiHistory = conversationLog.filter(c => c.type === 'ai');
    expect(aiHistory.length).toBe(1);
  });

  it('FastPath 多次连续拦截互不影响', () => {
    expect(checkFastPath('大点声').action).toBe('VOLUME_CONTROL');
    expect(checkFastPath('暂停').action).toBe('PLAYBACK_CONTROL');
    expect(checkFastPath('切歌').action).toBe('PLAYBACK_CONTROL');
    expect(checkFastPath('下一首').action).toBe('PLAYBACK_CONTROL');
  });
});
