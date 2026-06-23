// ============================================================
// src/server/netease.js — 网易云音乐封装（OpenClaw ncm-cli）
//
// 2026年3月网易云音乐全面接入 OpenClaw，提供标准化 CLI：
//   - npx github:Davied-H/ncm-cli install --dir ~/.local/bin
//   - ncm login（浏览器扫码授权）
//   - 所有命令支持 --json 输出纯净结构化数据
//
// 广告情况：返回 JSON 数据无音频贴片广告、弹窗或推广内容。
//
// Spec 4.3 / 6.1 / 7.2 强制规范
// ============================================================

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

/**
 * 给 Promise 加超时，超时自动 reject。
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_DIR = path.join(__dirname, '..', 'data', 'fallback');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'cache', 'netease_urls.json');

// ncm CLI 二进制路径
const NCM_BIN = process.env.NCM_BIN || 'ncm';

// ---- CLI 调用封装 ----

/**
 * 执行 ncm CLI 命令并解析 JSON 输出。
 * @param {string[]} args - CLI 参数，不含 --json（自动追加）
 * @param {number} timeout - 超时 ms
 * @returns {Promise<object>} 解析后的 JSON 数据
 */
async function ncm(args, timeout = 15000) {
  try {
    const { stdout, stderr } = await execFileAsync(NCM_BIN, [...args, '--json'], {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env } // 继承 PATH 以找到 ncm
    });
    if (stderr) {
      console.warn('[netease] ncm stderr:', stderr.slice(0, 200));
    }
    if (!stdout || !stdout.trim()) return null;
    return JSON.parse(stdout.trim());
  } catch (err) {
    if (err.killed) {
      throw new Error(`ncm command timed out after ${timeout}ms: ${args.join(' ')}`);
    }
    if (err.stderr) {
      const msg = err.stderr.slice(0, 300);
      if (msg.includes('not logged in') || msg.includes('未登录')) {
        throw new NcmNotLoggedInError('ncm 未登录，请运行 ncm login 扫码登录');
      }
      throw new Error(`ncm error: ${msg}`);
    }
    if (err.code === 'ENOENT') {
      throw new Error(
        `未找到 ncm 命令。请先安装: npx github:Davied-H/ncm-cli install --dir ~/.local/bin`
      );
    }
    throw err;
  }
}

class NcmNotLoggedInError extends Error {
  constructor(msg) { super(msg); this.name = 'NcmNotLoggedInError'; this.code = 'NCM_NOT_LOGGED_IN'; }
}

// ---- 登录态校验（Spec 6.1）----

let loginChecked = false;
let ncmQuickChecked = null; // null=未检测, true=可用, false=不可用

/**
 * 快速检测 ncm 是否可用（短超时，仅 2s）。
 * 结果缓存，避免每次都 exec。
 */
async function checkNcmQuick() {
  if (ncmQuickChecked !== null) return ncmQuickChecked;
  try {
    await execFileAsync(NCM_BIN, ['--help'], { timeout: 2000 });
    ncmQuickChecked = true;
    return true;
  } catch {
    ncmQuickChecked = false;
    return false;
  }
}

/**
 * 校验 ncm CLI 登录态。
 * 启动时调用一次，后续复用结果。
 * @returns {Promise<boolean>}
 */
export async function ensureLogin() {
  if (loginChecked) return true;

  try {
    const result = await ncm(['me']);
    if (result && result.profile) {
      console.log(`[netease] 已登录: ${result.profile.nickname || '未知用户'}`);
      loginChecked = true;
      return true;
    }
    throw new NcmNotLoggedInError('ncm 登录态无效');
  } catch (err) {
    if (err instanceof NcmNotLoggedInError) {
      console.warn('[netease] ncm 未登录，请运行 ncm login 扫码登录');
      // 不设 loginChecked=true，让后续调用跳过 ncm
      return false;
    }
    // ncm 不可用时静默降级
    console.warn('[netease] 登录校验跳过 (ncm 不可用)，将使用本地兜底音乐');
    return false;
  }
}

// ---- URL 缓存（Spec 6.2 直链有效期管理）----

let urlCache = {};
try { urlCache = JSON.parse(await readFile(CACHE_FILE, 'utf-8')); } catch { /* 首次忽略 */ }

async function saveCache() {
  try { await writeFile(CACHE_FILE, JSON.stringify(urlCache, null, 2)); } catch { /* 忽略目录未创建 */ }
}

/**
 * 解析 ncm url 命令的输出，提取可用播放地址。
 * 返回格式: { url: string, br: number } 或 null（不可播）
 */
async function getSongUrlFromApi(id) {
  const result = await ncm(['url', String(id)]);
  // ncm url --json 返回 { id, url, level, playable, reason, ... } 或 { data: [...] }
  const data = result?.data || (Array.isArray(result) ? result : [result]);
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || !entry.url) {
    const reason = entry?.reason || 'unknown';
    console.warn(`[netease] 歌曲 ${id} 不可播放: ${reason}`);
    throw new Error(`Song ${id} not playable: ${reason}`);
  }
  return { url: entry.url, name: null, br: entry.br || 0 };
}

/**
 * 搜索歌曲。
 * @returns {Array<{id, name, artist}>}
 */
async function searchSongsFromApi(keyword, limit = 5) {
  const result = await ncm(['search', 'song', '--keyword', keyword, '--limit', String(limit)]);
  const songs = result?.songs || result?.result?.songs || [];
  return songs.map(s => ({
    id: s.id,
    name: s.name,
    artist: (s.ar || s.artists || []).map(a => a.name || a).join('/'),
    album: s.al || s.album || {}
  }));
}

// ---- 核心 API ----

/**
 * ✅ Spec 4.3 核心：song_id 三段式解析。
 * @param {string} songId - 数字ID 或 "next_recommend"
 * @param {string} [fallbackQuery] - 仅 next_recommend 生效的搜索关键词
 * @returns {Promise<{ url: string, name: string, source: string, id?: string, coverUrl?: string }>}
 */
export async function resolveSong(songId, fallbackQuery) {
  // 给 ncm 调用加 3s 超时，超时直接走本地兜底
  const NCM_TIMEOUT = 3000;

  try {
    // 1️⃣ 具体数字 ID → 直接获取直链
    if (songId && songId !== 'next_recommend') {
      const cached = urlCache[songId];
      if (cached && cached.expireAt > Date.now()) {
        return { url: cached.url, name: cached.name, source: 'cache', id: songId };
      }
      const result = await withTimeout(getSongUrlFromApi(songId), NCM_TIMEOUT);
      urlCache[songId] = {
        url: result.url,
        name: result.name || `Song ${songId}`,
        expireAt: Date.now() + 20 * 60 * 1000
      };
      await saveCache();
      return { url: result.url, name: result.name || `Song ${songId}`, source: 'api', id: songId };
    }

    // 2️⃣ next_recommend + fallback_query → 搜索取第一条
    if (fallbackQuery) {
      const results = await withTimeout(searchSongsFromApi(fallbackQuery, 5), NCM_TIMEOUT);
      if (results.length > 0) {
        const first = results[0];
        const cached = urlCache[first.id];
        if (cached && cached.expireAt > Date.now()) {
          return { url: cached.url, name: first.name, source: 'cache', id: first.id };
        }
        const urlResult = await withTimeout(getSongUrlFromApi(first.id), NCM_TIMEOUT);
        urlCache[first.id] = {
          url: urlResult.url,
          name: first.name,
          expireAt: Date.now() + 20 * 60 * 1000
        };
        await saveCache();
        return {
          url: urlResult.url,
          name: first.name,
          source: 'search',
          id: String(first.id),
          coverUrl: first.album?.picUrl || first.album?.cover || ''
        };
      }
    }

    // 3️⃣ 兜底 → 本地 fallback
    return await getLocalFallback();

  } catch (err) {
    console.error(`[netease] resolveSong failed: ${err.message}`);
    return await getLocalFallback();
  }
}

/**
 * 校验/刷新缓存，过期则重新获取直链。
 */
export async function getOrRefreshUrl(songId) {
  const cached = urlCache[songId];
  if (cached && Date.now() >= cached.expireAt) {
    delete urlCache[songId];
    await saveCache();
  }
  if (songId && songId !== 'next_recommend') {
    const result = await resolveSong(songId);
    return result.url;
  }
  return null;
}

/**
 * 获取每日推荐歌曲。
 * @returns {Array<{id, name, artist, album, coverUrl}>}
 */
export async function getRecommendSongs(limit = 30) {
  try {
    const result = await ncm(['recommend', 'songs', '--limit', String(limit)]);
    const songs = result?.data?.dailySongs || result?.dailySongs || result?.songs || [];
    if (!songs.length) {
      console.warn('[netease] 每日推荐为空或被限频');
      return [];
    }
    return songs.map(s => ({
      id: s.id,
      name: s.name,
      artist: (s.ar || s.artists || []).map(a => a.name || a).join('/'),
      album: s.al || s.album || {},
      coverUrl: s.al?.picUrl || s.album?.picUrl || ''
    }));
  } catch (err) {
    console.error('[netease] getRecommendSongs failed:', err.message);
    return [];
  }
}

/**
 * 获取歌曲详情（含封面图）。
 * @returns {{ id, name, artist, coverUrl }}
 */
export async function getSongDetail(songId) {
  try {
    const result = await ncm(['song', String(songId)]);
    const s = result?.songs?.[0] || result;
    return {
      id: s.id,
      name: s.name || '',
      artist: (s.ar || s.artists || []).map(a => a.name || a).join('/'),
      coverUrl: s.al?.picUrl || s.album?.picUrl || '',
      album: s.al?.name || s.album?.name || ''
    };
  } catch (err) {
    console.error(`[netease] getSongDetail ${songId} failed:`, err.message);
    return null;
  }
}

/**
 * 获取歌词。
 */
export async function getLyric(songId) {
  try {
    const raw = await ncm(['lyric', songId, '--raw'], 10000);
    // --raw 返回纯文本，非 JSON 时直接返回
    if (typeof raw === 'string') return raw;
    return raw?.lrc?.lyric || raw?.lyric || '';
  } catch (err) {
    console.error(`[netease] getLyric ${songId} failed:`, err.message);
    return '';
  }
}

/**
 * 获取播放记录。
 */
export async function getPlayRecord(limit = 30) {
  try {
    const result = await ncm(['record', '--week', '--limit', String(limit)]);
    return (result?.weekData || result?.data || []).map(r => ({
      song: r.song?.name || r.name || '',
      artist: (r.song?.ar || []).map(a => a.name).join('/'),
      time: r.playTime || r.time || Date.now()
    }));
  } catch (err) {
    console.error('[netease] getPlayRecord failed:', err.message);
    return [];
  }
}

// ---- 本地兜底 ----

/**
 * 本地兜底音乐（Spec 7.2 降级必需）。
 */
export async function getLocalFallback() {
  try {
    const files = await readdir(FALLBACK_DIR);
    const musicFiles = files.filter(f => /\.(mp3|wav|ogg)$/i.test(f));
    if (musicFiles.length === 0) throw new Error('无本地兜底音乐');
    const picked = musicFiles[Math.floor(Math.random() * musicFiles.length)];
    return {
      url: `/data/fallback/${picked}`,
      name: picked.replace(/\.[^.]+$/, ''),
      source: 'local_fallback'
    };
  } catch {
    return { url: '', name: '无可用音频', source: 'none' };
  }
}

// ---- 缓存维护 ----

/**
 * 清空过期缓存。
 */
export async function cleanExpiredCache() {
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(urlCache)) {
    if (now >= urlCache[id].expireAt) { delete urlCache[id]; changed = true; }
  }
  if (changed) await saveCache();
}

export default {
  ensureLogin, resolveSong, getOrRefreshUrl, cleanExpiredCache,
  getRecommendSongs, getSongDetail, getLyric, getPlayRecord,
  getLocalFallback,
  NcmNotLoggedInError
};
