// ============================================================
// schema.js — DeepSeek 响应 JSON Schema 校验模块
// 严格按照 Spec 3.2 定义，提供给 Fastify 路由和 DeepSeek
// 适配器做响应校验，禁止修改字段名或结构。
// ============================================================

/**
 * DeepSeek 响应 JSON Schema。
 * 三种 action 的 payload 字段严格区分，不可混用。
 *
 * 校验规则:
 *   action: "play_song" | "speak_text" | "check_schedule"
 *   payload.song_id:       string（play_song 必填）
 *   payload.fallback_query: string（play_song 可选，song_id="next_recommend" 时必填）
 *   payload.text:          string（speak_text 必填）
 *   payload.follow_up_song_id: string（speak_text 可选）
 *   payload.time_range:    "today_morning" | "today_afternoon" | "today_evening" | "tomorrow"
 *   payload.summary_type:  "brief" | "detailed"
 *   payload.reasoning:     string（三种 action 均适用，可选）
 */
export const chatResponseSchema = {
  type: 'object',
  required: ['action', 'payload'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['play_song', 'speak_text', 'check_schedule']
    },
    payload: {
      type: 'object',
      properties: {
        song_id: { type: 'string' },
        fallback_query: { type: 'string' },
        text: { type: 'string' },
        follow_up_song_id: { type: 'string' },
        time_range: {
          type: 'string',
          enum: ['today_morning', 'today_afternoon', 'today_evening', 'tomorrow']
        },
        summary_type: {
          type: 'string',
          enum: ['brief', 'detailed']
        },
        reasoning: { type: 'string' }
      }
      // 注意：不在此处做 required 校验，因为不同 action 的 required 字段不同，
      // 由 validateResponse() 做精确校验
    }
  }
};

/**
 * 每种 action 对应的 payload 必填字段
 */
const ACTION_REQUIRED_FIELDS = {
  play_song: ['song_id'],
  speak_text: ['text'],
  check_schedule: ['time_range', 'summary_type']
};

/**
 * 每种 action 对应的 payload 可选字段（不在列表中的字段会被警告）
 */
const ACTION_ALLOWED_FIELDS = {
  play_song: ['song_id', 'fallback_query', 'reasoning'],
  speak_text: ['text', 'follow_up_song_id', 'reasoning'],
  check_schedule: ['time_range', 'summary_type', 'reasoning']
};

/**
 * 验证 DeepSeek 响应是否合法的完整校验。
 * 
 * 校验层级:
 *   1. 顶层结构（action + payload 必须存在）
 *   2. action 枚举值
 *   3. payload 必填字段
 *   4. payload 额外字段检测
 *   5. play_song 特殊规则：song_id="next_recommend" 时 fallback_query 必填
 *   6. speak_text 特殊规则：follow_up_song_id 为字符串时 play_song action 的衔接约束
 *      （此约束的强制执行在 netease.js resolveSong() 中）
 *
 * @param {object} response - DeepSeek 返回的 JSON 对象
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateResponse(response) {
  const errors = [];
  const warnings = [];

  // 1. 顶层结构
  if (!response || typeof response !== 'object') {
    errors.push('响应不是有效 JSON 对象');
    return { valid: false, errors, warnings };
  }

  if (!response.action) {
    errors.push('缺少顶层字段: action');
    return { valid: false, errors, warnings };
  }

  if (!response.payload || typeof response.payload !== 'object') {
    errors.push('缺少顶层字段: payload 或 payload 不是对象');
    return { valid: false, errors, warnings };
  }

  const { action, payload } = response;

  // 2. action 枚举
  const VALID_ACTIONS = ['play_song', 'speak_text', 'check_schedule'];
  if (!VALID_ACTIONS.includes(action)) {
    errors.push(`未知 action: "${action}"，合法值: ${VALID_ACTIONS.join(', ')}`);
    return { valid: false, errors, warnings };
  }

  // 3. 必填字段
  const required = ACTION_REQUIRED_FIELDS[action];
  for (const field of required) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      errors.push(`action="${action}" 时 payload.${field} 为必填字段，当前为空`);
    }
  }

  // 4. 额外字段检测（不影响合法性，仅警告）
  const allowed = ACTION_ALLOWED_FIELDS[action];
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      warnings.push(`payload 包含未预期字段: "${key}"（action="${action}" 下可能被忽略）`);
    }
  }

  // 5. play_song 特殊规则
  if (action === 'play_song' && payload.song_id === 'next_recommend' && !payload.fallback_query) {
    errors.push('song_id="next_recommend" 时 fallback_query 为必填字段');
  }

  // 6. time_range / summary_type 枚举校验
  if (action === 'check_schedule') {
    const validRanges = ['today_morning', 'today_afternoon', 'today_evening', 'tomorrow'];
    const validTypes = ['brief', 'detailed'];
    if (payload.time_range && !validRanges.includes(payload.time_range)) {
      errors.push(`time_range 非法值: "${payload.time_range}"，合法值: ${validRanges.join(', ')}`);
    }
    if (payload.summary_type && !validTypes.includes(payload.summary_type)) {
      errors.push(`summary_type 非法值: "${payload.summary_type}"，合法值: ${validTypes.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * 生成一段简短的错误汇总文本，用于日志或 WS 推送。
 */
export function formatValidationErrors(result) {
  const parts = [];
  if (result.errors.length > 0) {
    parts.push(`[ERROR] ${result.errors.join('; ')}`);
  }
  if (result.warnings.length > 0) {
    parts.push(`[WARN] ${result.warnings.join('; ')}`);
  }
  return parts.join(' | ') || 'OK';
}

export default {
  chatResponseSchema,
  validateResponse,
  formatValidationErrors
};
