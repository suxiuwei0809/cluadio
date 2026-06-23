import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 4.2 节强制 Token 预算表
const TOKEN_BUDGET = {
  persona: 800,
  env: 200,
  history: 1200,
  input: 200,
  reserve: 3600
};
const MAX_TOKENS = 8000;

// 缓存 Persona Prompt，避免每次请求读盘
let personaPromptCache = null;
async function getPersonaPrompt() {
  if (!personaPromptCache) {
    const promptPath = path.join(__dirname, 'prompts', 'ej-persona.md');
    personaPromptCache = await readFile(promptPath, 'utf-8');
  }
  return personaPromptCache;
}

/**
 * 简易 Token 估算（中文≈1.5 token/char，英文≈0.75 token/char）
 * 生产环境可替换为 tiktoken，但此估算已满足预算控制需求
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + otherChars * 0.75);
}

function truncate(text, maxTokens) {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return text;
  // 按字符比例截断，追加标记
  const ratio = maxTokens / tokens;
  const cutLen = Math.floor(text.length * ratio);
  return text.slice(0, cutLen) + ' [用户输入过长，已截断]';
}

/**
 * 构建环境上下文块（≤200 tokens）
 */
function buildEnvBlock(env) {
  const schedule = env.calendar?.slice(0, 5).map(c => `${c.time} ${c.title}`).join('; ') || '无安排';
  const recent = env.recentPlays?.map(p => `${p.song}(${p.artist})`).join(' → ') || '暂无记录';
  const tags = env.tasteTags?.slice(0, 10).join(', ') || '未知';

  const block = `[当前环境]\n时间: ${env.now} (${env.weekday})\n天气: ${env.weather?.desc || '未知'}, ${env.weather?.temp || '?'}°C\n今日日程: ${schedule}\n最近播放: ${recent}\n用户标签: ${tags}`;
  
  return truncate(block, TOKEN_BUDGET.env);
}

/**
 * 构建对话历史块（≤1200 tokens，最多3轮6条）
 */
function buildHistoryBlock(history) {
  if (!history?.length) return [];
  
  const recentHistory = history.slice(-6); // 最多3轮
  const result = [];
  let usedTokens = 0;

  // 从最新到最旧填充，超预算即停止
  for (let i = recentHistory.length - 1; i >= 0; i--) {
    const msg = recentHistory[i];
    const content = truncate(msg.content, 200); // 每条≤200 tokens
    const tokens = estimateTokens(content);
    
    if (usedTokens + tokens > TOKEN_BUDGET.history) break;
    
    result.unshift({ role: msg.role, content });
    usedTokens += tokens;
  }

  return result;
}

/**
 * 主拼接函数 - 4.2 节核心入口
 * @param {string} userInput - 用户原始输入
 * @param {Object} env - 由 router.js 组装的环境数据
 * @returns {Array} 符合预算的 messages 数组
 */
export async function buildMessages(userInput, env) {
  const persona = await getPersonaPrompt();
  
  const messages = [
    { role: 'system', content: truncate(persona, TOKEN_BUDGET.persona) },
    { role: 'system', content: buildEnvBlock(env) },
    ...buildHistoryBlock(env.history),
    { role: 'user', content: truncate(userInput, TOKEN_BUDGET.input) }
  ];

  // 最终安全校验：若仍超预算，强制裁剪历史
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const safeLimit = MAX_TOKENS - TOKEN_BUDGET.reserve;
  
  if (totalTokens > safeLimit) {
    console.warn(`[Context] Token overflow: ${totalTokens}/${safeLimit}, trimming history...`);
    // 移除最早的历史消息直到安全
    while (messages.length > 3 && estimateTokens(messages.map(m=>m.content).join('')) > safeLimit) {
      // 保留前2条system，从index=2开始删除
      messages.splice(2, 1);
    }
  }

  return messages;
}
