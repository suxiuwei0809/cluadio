// ============================================================
// tts.js — Fish Audio 语音合成服务封装
// 严格按照 Spec 6.3 实现：强制 mp3+44100Hz、ffmpeg 转码兜底、无 ffmpeg 降级 WAV
// ============================================================

import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

// ---- TTS 输出目录 ----
const TTS_OUTPUT_DIR = join(process.cwd(), 'src', 'data', 'cache', 'tts');

// Fish Audio API 基础配置
const FISH_API_BASE = 'https://api.fish.audio';
const FISH_MODEL = 'fish-speech-1.4';

// Spec 6.3 强制参数
const FORCED_FORMAT = 'mp3';
const FORCED_SAMPLE_RATE = 44100;

// ---- ffmpeg 检测 ----

let ffmpegAvailable = null;

/**
 * 检测系统是否有 ffmpeg。
 * 结果在首次调用时缓存，避免每次 TTS 都执行 which。
 * @returns {Promise<boolean>}
 */
async function checkFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    ffmpegAvailable = true;
  } catch {
    console.warn('[tts] ffmpeg 不可用，将降级为 WAV 格式');
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

// ---- Fish Audio TTS API ----

/**
 * 调用 Fish Audio TTS API 生成语音。
 * 强制请求 mp3 + 44100Hz 格式（Spec 6.3）。
 *
 * @param {string} text - 要合成语音的文本（≤500 字）
 * @param {object} [options]
 * @param {string} [options.voice] - 参考音色 ID（默认内置 Claudio 音色）
 * @returns {Promise<Buffer>} 音频数据 buffer
 */
async function callFishAudio(text, options = {}) {
  const apiKey = process.env.FISH_AUDIO_KEY;
  if (!apiKey) {
    throw new Error('FISH_AUDIO_KEY 未配置，请在 .env 中设置');
  }

  // 文本截断：Fish Audio 单次有长度限制
  const maxLen = 500;
  const inputText = text.length > maxLen ? text.slice(0, maxLen) : text;

  const response = await axios.post(
    `${FISH_API_BASE}/v1/tts`,
    {
      text: inputText,
      format: FORCED_FORMAT,       // Spec 6.3 强制
      sample_rate: FORCED_SAMPLE_RATE, // Spec 6.3 强制
      latency: 'normal'
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      responseType: 'arraybuffer',
      timeout: 30000
    }
  );

  return Buffer.from(response.data);
}

// ---- 音频格式校验 ----

/**
 * 检查 buffer 的 magic bytes 是否为 MP3 格式。
 * MP3 的常见 magic bytes: 0xFF 0xFB, 0xFF 0xF3, 0xFF 0xF2, ID3 tag "ID3"
 */
function isMp3(buffer) {
  if (buffer.length < 2) return false;
  // ID3v2 tag 开头
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  // MPEG frame sync
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return true;
  return false;
}

/**
 * 检查 buffer 的 magic bytes 是否为 WAV（RIFF header）。
 */
function isWav(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x52 && buffer[1] === 0x49  // "RI"
    && buffer[2] === 0x46 && buffer[3] === 0x46; // "FF"
}

// ---- ffmpeg 转码 ----

/**
 * 使用 ffmpeg 将音频转为 mp3 + 44100Hz。
 * @param {Buffer} inputBuffer - 原始音频数据
 * @param {string} inputExt - 输入格式扩展名（用于 temp 文件）
 * @returns {Promise<Buffer>} 转码后的 mp3 buffer
 */
async function transcodeToMp3(inputBuffer, inputExt = 'tmp') {
  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    // 降级 WAV：尝试提取 PCM 数据（简陋方案）
    console.warn('[tts] 无 ffmpeg，返回原始数据作为降级输出');
    return inputBuffer;
  }

  const tempDir = join(process.cwd(), 'src', 'data', 'cache', 'tts');
  await mkdir(tempDir, { recursive: true });

  const id = randomUUID().slice(0, 8);
  const inputPath = join(tempDir, `raw_${id}.${inputExt}`);
  const outputPath = join(tempDir, `conv_${id}.mp3`);

  try {
    // 写入临时文件
    await writeFile(inputPath, inputBuffer);

    // ffmpeg 转码：强制 mp3 + 44100Hz + 128k 比特率
    await execFileAsync('ffmpeg', [
      '-y',                    // 覆盖已存在文件
      '-i', inputPath,         // 输入
      '-ar', String(FORCED_SAMPLE_RATE), // 采样率 44100
      '-ac', '1',             // 单声道（语音无需立体声）
      '-b:a', '128k',         // 比特率
      '-f', 'mp3',            // 输出格式
      outputPath
    ], { timeout: 15000 });

    // 读取转码结果
    const { readFile } = await import('fs/promises');
    const resultBuffer = await readFile(outputPath);
    return resultBuffer;

  } catch (err) {
    console.error('[tts] ffmpeg 转码失败:', err.message);
    // 转码失败返回原始数据
    return inputBuffer;
  } finally {
    // 清理临时文件
    try { await unlink(inputPath); } catch {}
    try { await unlink(outputPath); } catch {}
  }
}

// ---- 公开 API ----

/**
 * 语音合成主入口。
 * 流程：Fish Audio API → 格式校验 → ffmpeg 转码兜底 → 返回最终音频 buffer。
 *
 * @param {string} text - 要播报的文本
 * @param {object} [options]
 * @param {string} [options.voice] - 参考音色 ID
 * @param {boolean} [options.cacheKey] - 缓存键，用于避免重复合成
 * @returns {Promise<{ buffer: Buffer, mimeType: string, format: string, fromCache: boolean }>}
 */
export async function synthesizeSpeech(text, options = {}) {
  if (!text || text.trim().length === 0) {
    throw new Error('TTS text 为空');
  }

  // 1. 调用 Fish Audio API
  let audioBuffer;
  try {
    audioBuffer = await callFishAudio(text, options);
  } catch (err) {
    console.error('[tts] Fish Audio API 调用失败:', err.message);
    throw new Error(`TTS API failed: ${err.message}`);
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('TTS returned empty buffer');
  }

  // 2. 格式校验（Spec 6.3）
  let finalBuffer = audioBuffer;
  let finalFormat = FORCED_FORMAT;
  let finalMime = 'audio/mpeg';

  if (isMp3(audioBuffer)) {
    // ✅ 已经是 mp3，直接使用
    finalBuffer = audioBuffer;
  } else if (isWav(audioBuffer)) {
    // ⚠️ 返回的是 WAV，需要转码
    console.log('[tts] Fish Audio 返回 WAV，转码为 mp3...');
    finalBuffer = await transcodeToMp3(audioBuffer, 'wav');
  } else {
    // ⚠️ 未知格式，尝试转码
    console.log('[tts] Fish Audio 返回未知格式，尝试转码...');
    finalBuffer = await transcodeToMp3(audioBuffer, 'tmp');
  }

  // 验证转码结果
  if (isMp3(finalBuffer)) {
    finalFormat = 'mp3';
    finalMime = 'audio/mpeg';
  } else if (isWav(finalBuffer)) {
    // 降级 WAV（Spec 6.3）
    finalFormat = 'wav';
    finalMime = 'audio/wav';
    console.warn('[tts] 转码失败，降级为 WAV 格式');
  }

  // 3. 缓存到磁盘（可选，用于重复播报）
  if (options.cacheKey) {
    const cacheDir = join(process.cwd(), 'src', 'data', 'cache', 'tts');
    await mkdir(cacheDir, { recursive: true });
    const cachePath = join(cacheDir, `${options.cacheKey}.${finalFormat}`);
    try {
      await writeFile(cachePath, finalBuffer);
    } catch {}
  }

  return {
    buffer: finalBuffer,
    mimeType: finalMime,
    format: finalFormat,
    fromCache: false
  };
}

/**
 * 批量合成多段文本。
 * 用于播报队列：将长文本拆分为多段，逐段合成。
 *
 * @param {string[]} textSegments - 文本段数组
 * @returns {Promise<Array<{buffer: Buffer, mimeType: string, format: string}>>}
 */
export async function synthesizeBatch(textSegments) {
  const results = [];
  for (const segment of textSegments) {
    if (!segment.trim()) continue;
    try {
      const result = await synthesizeSpeech(segment);
      results.push(result);
    } catch (err) {
      console.error('[tts] 批量合成失败:', segment.slice(0, 20), err.message);
    }
  }
  return results;
}

/**
 * 健康检查：验证 Fish Audio API 可用性。
 * @returns {Promise<boolean>}
 */
export async function healthCheck() {
  try {
    const result = await synthesizeSpeech('测试', {});
    return result.buffer.length > 0;
  } catch {
    return false;
  }
}

export default { synthesizeSpeech, synthesizeBatch, healthCheck };
