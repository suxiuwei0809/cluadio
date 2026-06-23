// ============================================================
// main.js — Claudio PWA 入口
// 视图切换 + AudioEngine 接线 + WS 连接 + chat API 调用
// ============================================================

import store from './store.js';
import { ReconnectingWS } from './ws.js';
import { AudioEngine } from './AudioEngine.js';
import Player from './components/Player.js';
import Profile from './components/Profile.js';
import Settings from './components/Settings.js';

// ---- 初始化 AudioEngine ----

const audio = new AudioEngine({ eventTarget: document });

// ---- 视图切换 ----

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

  const viewEl = document.getElementById(`view-${viewName}`);
  if (viewEl) viewEl.classList.add('active');

  const tabEl = document.querySelector(`.tab[data-view="${viewName}"]`);
  if (tabEl) tabEl.classList.add('active');
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

// ---- chat 输入框接线 ----

/**
 * 将用户消息渲染到对话流中。
 */
function addUserBubble(text) {
  // 通过 store:change 触发 Player._addStreamItem 不够直接，
  // 这里直接操作 DOM 追加用户气泡
  const stream = document.querySelector('#player-stream');
  if (!stream || !text) return;

  // 首次消息时清除空状态占位
  if (!stream._started) {
    stream.innerHTML = '';
    stream._started = true;
  }

  const item = document.createElement('div');
  item.className = 'stream-item stream-item--user';
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `<div class="stream-avatar stream-avatar--user">U</div>
    <div class="stream-body">
      <div class="stream-text">${escapeHtml(text)}</div>
      <div class="stream-time">${time}</div>
    </div>`;
  stream.appendChild(item);

  // 只保留最近 2 条消息，第 3 条出现时移除第 1 条
  while (stream.children.length > 2) {
    const first = stream.firstElementChild;
    if (first) {
      first.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      first.style.opacity = '0';
      first.style.transform = 'translateY(-10px)';
      first.addEventListener('transitionend', () => first.remove(), { once: true });
    }
  }

  stream.scrollTop = stream.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sendChatMessage(text) {
  if (!text?.trim()) return;

  // 先渲染用户消息到对话流
  addUserBubble(text);

  store.update({ aiStatus: 'thinking' });

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text })
  })
    .then(res => res.json())
    .then(data => handleAiResponse(data))
    .catch(err => {
      console.error('[chat] 请求失败:', err.message);
      store.update({ aiStatus: 'idle' });
      toast('连接失败，请检查网络');
    });
}

/**
 * 处理 AI 响应，分发到 AudioEngine 播放或显示。
 */
function handleAiResponse(data) {
  console.log('[Claudio] handleAiResponse:', JSON.stringify(data).slice(0, 200));
  const { action, payload } = data;

  if (action === 'speak_text') {
    const speakText = payload.text || '';
    console.log('[Claudio] speak_text, text:', speakText.slice(0, 50));
    // 如果有文本内容，触发打字机动画；否则保持 idle
    if (speakText) {
      store.update({ aiLastText: speakText, aiStatus: 'speaking' });
    } else {
      // 无文本但有歌曲时，直接恢复 idle（打字机不会运行）
      if (payload._resolvedUrl || payload.follow_up_song_id) {
        store.update({ aiStatus: 'idle' });
      }
    }

    // 如果带歌曲 URL，直接播放
    if (payload._resolvedUrl || payload.follow_up_song_id) {
      const url = payload._resolvedUrl || `/api/song/${payload.follow_up_song_id}`;
      if (url) {
        console.log('[Claudio] speak_text playing:', url.slice(0, 60));
        audio.play(url, { name: payload._resolvedName || 'AI 推荐' });
      }
    }
  }

  if (action === 'play_song') {
    const url = payload._resolvedUrl;
    if (url) {
      audio.play(url, { name: payload._resolvedName || '播放中' });
    } else {
      toast('歌曲暂不可用');
    }
  }

  if (action === 'check_schedule') {
    store.update({ aiStatus: 'speaking' });
  }

  if (action === 'no_action') {
    store.update({ aiStatus: 'idle' });
  }

  // 兜底：如果处理后 aiStatus 还是 thinking，恢复 idle
  if (store.aiStatus === 'thinking') {
    store.update({ aiStatus: 'idle' });
  }
}

// 绑定输入框
const chatInput = document.getElementById('chatInput');
const btnSend = document.getElementById('btnSend');

btnSend?.addEventListener('click', () => {
  const text = chatInput.value;
  chatInput.value = '';
  sendChatMessage(text);
});

chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatInput.value;
    chatInput.value = '';
    sendChatMessage(text);
  }
});

// ---- 全局 AudioEngine 命令转发 ----

document.addEventListener('player:command', (e) => {
  const { action } = e.detail;
  switch (action) {
    case 'play':
      // 如果没有歌曲在播放，自动请求 AI 推荐一首
      if (!audio.isPlaying && !audio.currentUrl) {
        console.log('[player:command] play: no current song, requesting AI');
        sendChatMessage('来首歌');
      } else if (!audio.isPlaying) {
        // 有歌曲 URL 但暂停了，恢复播放
        console.log('[player:command] play: resuming');
        audio.resume();
      } else {
        // 正在播放，什么都不做（或可忽略）
        console.log('[player:command] play: already playing');
      }
      break;
    case 'pause':
      audio.pause();
      break;
    case 'next':
      // 切歌 → 走 AI 推荐
      sendChatMessage('下一首');
      break;
    case 'prev':
      // 上一首暂不支持（无播放历史回溯）
      toast('上一首暂未支持');
      break;
  }
});

document.addEventListener('audio:play', (e) => {
  audio.play(e.detail.url, e.detail.meta);
});

document.addEventListener('audio:pause', () => {
  audio.pause();
});

// ---- Toast 通知 ----

function toast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.style.cssText =
    'background:var(--color-bg-elevated, #2C2C2C);color:var(--color-text-primary, #FFF);padding:8px 16px;border-radius:8px;margin:4px;font-size:13px;animation:fadeIn 0.3s ease';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---- 音量控制（FastPath 通过 WS 回调） ----

document.addEventListener('store:change', (e) => {
  const { changed } = e.detail;
  if ('volume' in changed) {
    audio.setVolume(changed.volume);
  }
});

// ---- 启动 ----

async function init() {
  // Service Worker
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.warn('[PWA] SW 注册失败:', err.message);
    }
  }

  // WebSocket
  const ws = new ReconnectingWS('/stream');
  window.__claudioWS = ws;

  // 初始化状态
  try {
    const res = await fetch('/api/now');
    const data = await res.json();
    if (data.nowPlaying) store.update({ nowPlaying: { ...store.nowPlaying, ...data.nowPlaying } });
    if (data.volume != null) store.update({ volume: data.volume });
    if (data.isPlaying != null) store.update({ isPlaying: data.isPlaying });
    if (data.degradedServices) store.update({ degradedServices: data.degradedServices });
  } catch (err) {
    console.warn('[Init] 状态加载失败:', err.message);
  }

  // 初始化视图组件
  Player.init();
  Profile.init();
  Settings.init();

  // 初始音量
  audio.setVolume(store.volume);

  console.log('[Claudio] 就绪');
}

document.addEventListener('DOMContentLoaded', init);
