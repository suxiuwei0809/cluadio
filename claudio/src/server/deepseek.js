import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

// 3.2 节强制响应 Schema（与 Fastify 校验保持一致）
export const CHAT_RESPONSE_SCHEMA = {
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
        reasoning: { type: 'string' },
        _resolvedUrl: { type: 'string' },
        _resolvedName: { type: 'string' },
        _branch: { type: 'string' }
      }
    }
  }
};

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com' // 强制指定 DeepSeek 端点
});

/**
 * 调用 DeepSeek JSON Mode
 * @param {Array} messages - 已由 context.js 按预算拼接好的消息数组
 * @returns {Promise<Object>} 符合 CHAT_RESPONSE_SCHEMA 的结构化对象
 */
export async function chatCompletion(messages) {
  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      response_format: { type: 'json_object' }, // 3.2 节强制开启
      temperature: 0.7
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned empty content');

    const parsed = JSON.parse(content);
    
    // 基础字段校验（Fastify 层会做完整校验，此处防 LLM 输出畸形）
    if (!parsed.action || !parsed.payload) {
      throw new Error(`Invalid AI response structure: ${content}`);
    }

    return parsed;
  } catch (err) {
    // 7.2 节降级：AI 异常时抛出特定错误供 router.js 捕获
    const error = new Error(`DeepSeek call failed: ${err.message}`);
    error.code = 'DEEPSEEK_ERROR';
    throw error;
  }
}
