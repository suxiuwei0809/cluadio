// ============================================================
// components/Player.js — 播放器视图（Spec 5.2）
// 零框架，监听 store:change 更新 DOM
// ============================================================

import store from '../store.js';

const Player = {
  /** DOM 引用缓存 */
  $: {},

  /**
   * 初始化播放器视图。
   * 绑定 DOM 引用和事件监听。
   */
  init() {
    this.$.cover = document.querySelector('.player-cover');
    this.$.coverArt = document.querySelector('.cover-art');
    this.$.songTitle = document.querySelector('.song-title');
    this.$.songArtist = document.querySelector('.song-artist');
    this.$.progressFill = document.querySelector('.progress-fill');
    this.$.timeCurrent = document.querySelector('.time-current');
    this.$.timeDuration = document.querySelector('.time-duration');
    this.$.btnPlay = document.querySelector('#btn-play');
    this.$.btnPrev = document.querySelector('#btn-prev');
    this.$.btnNext = document.querySelector('#btn-next');
    this.$.stream = document.querySelector('#player-stream');

    this._bindControls();
    this._listenStore();
    this._listenTrackEvents();
  },

  /**
   * 播放控制按钮
   */
  _bindControls() {
    this.$.btnPlay?.addEventListener('click', () => {
      if (store.isPlaying) {
        document.dispatchEvent(new CustomEvent('player:command', { detail: { action: 'pause' } }));
      } else {
        document.dispatchEvent(new CustomEvent('player:command', { detail: { action: 'play' } }));
      }
    });

    this.$.btnPrev?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('player:command', { detail: { action: 'prev' } }));
    });

    this.$.btnNext?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('player:command', { detail: { action: 'next' } }));
    });
  },

  /**
   * 监听 store 状态变化，更新 UI。
   */
  _listenStore() {
    document.addEventListener('store:change', (e) => {
      const { changed } = e.detail;

      if ('nowPlaying' in changed) {
        this._updateTrack(changed.nowPlaying);
      }
      if ('isPlaying' in changed) {
        this._updatePlayPause(changed.isPlaying);
      }
      if ('aiLastText' in changed || 'aiStatus' in changed) {
        console.log('[Player] store:change ai:', JSON.stringify(changed));
        this._updateAiStatus();
        // 信息流渲染
        if (changed.aiLastText) {
          console.log('[Player] calling _addStreamItem with:', (changed.aiLastText || '').slice(0, 50));
          this._addStreamItem(changed.aiLastText);
        }
      }
    });
  },

  /**
   * 监听 AudioEngine 自定义事件。
   */
  _listenTrackEvents() {
    document.addEventListener('track:progress', (e) => {
      const { currentTime, duration, progress } = e.detail;
      if (this.$.progressFill) {
        this.$.progressFill.style.width = `${(progress * 100).toFixed(1)}%`;
      }
      if (this.$.timeCurrent) {
        this.$.timeCurrent.textContent = this._formatTime(currentTime);
      }
      if (this.$.timeDuration && duration > 0) {
        this.$.timeDuration.textContent = this._formatTime(duration);
      }
    });

    document.addEventListener('track:start', () => {
      store.update({ isPlaying: true });
    });

    document.addEventListener('track:end', () => {
      store.update({ isPlaying: false });
    });

    document.addEventListener('track:pause', () => {
      store.update({ isPlaying: false });
    });
  },

  // ---- UI 更新 ----

  /**
   * 向信息流追加 AI 消息气泡。
   */
  _addStreamItem(text) {
    console.log('[Player] _addStreamItem called, stream:', !!this.$.stream, 'text:', (text || '').slice(0, 30));
    if (!this.$.stream || !text) return;
    // 首次消息时清除空状态占位（与 main.js 的 addUserBubble 共享 _started 标记）
    if (!this.$.stream._started) {
      this.$.stream.innerHTML = '';
      this.$.stream._started = true;
    }
    const item = document.createElement('div');
    item.className = 'stream-item';
    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `<div class="stream-avatar">C</div>
      <div class="stream-body">
        <div class="stream-text"><span class="typewriter-cursor">|</span></div>
        <div class="stream-time">${time}</div>
      </div>`;
    this.$.stream.appendChild(item);

    // 只保留最近 2 条消息，第 3 条出现时移除第 1 条（带淡出动画）
    while (this.$.stream.children.length > 2) {
      const first = this.$.stream.firstElementChild;
      if (first) {
        first.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        first.style.opacity = '0';
        first.style.transform = 'translateY(-10px)';
        first.addEventListener('transitionend', () => first.remove(), { once: true });
      }
    }

    // 滚动到底部
    this.$.stream.scrollTop = this.$.stream.scrollHeight;

    // 打字机效果：逐字显示
    this._typewrite(item.querySelector('.stream-text'), text);
  },

  /**
   * 打字机动画：逐字显示文本。
   * @param {HTMLElement} el - 文本容器
   * @param {string} fullText - 完整文本
   */
  _typewrite(el, fullText) {
    if (!el || !fullText) return;
    // 清除之前的打字动画（如果有）
    if (this._typeTimer) {
      clearInterval(this._typeTimer);
      this._typeTimer = null;
    }

    const chars = [...fullText];
    let i = 0;
    // 基础速度：每个字约 40-60ms，模拟真实打字
    const baseDelay = 45;

    this._typeTimer = setInterval(() => {
      if (i < chars.length) {
        // 逐个追加字符，保持 HTML 转义
        const span = document.createElement('span');
        span.textContent = chars[i];
        // 光标插入到最后一个子节点之前
        const cursor = el.querySelector('.typewriter-cursor');
        if (cursor) {
          el.insertBefore(span, cursor);
        } else {
          el.appendChild(span);
        }
        i++;
        // 滚动到底部
        this.$.stream.scrollTop = this.$.stream.scrollHeight;
      } else {
        // 打字完成，移除光标，恢复 AI 状态
        clearInterval(this._typeTimer);
        this._typeTimer = null;
        const cursor = el.querySelector('.typewriter-cursor');
        if (cursor) cursor.remove();
        // 打字完成 → 恢复 idle
        if (store.aiStatus === 'speaking') {
          store.update({ aiStatus: 'idle' });
        }
      }
    }, baseDelay);
  },

  _updateTrack(np) {
    if (np.name) this.$.songTitle.textContent = np.name;
    if (np.artist) this.$.songArtist.textContent = np.artist;

    // 动态封面
    if (this.$.coverArt) {
      if (np.coverUrl) {
        this.$.coverArt.src = np.coverUrl;
      } else {
        this.$.coverArt.removeAttribute('src');
      }
    }

    // 封面动画
    if (this.$.cover) {
      this.$.cover.classList.toggle('playing', store.isPlaying);
    }
  },

  _updatePlayPause(isPlaying) {
    if (this.$.btnPlay) {
      this.$.btnPlay.innerHTML = isPlaying
        ? '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
        : '<svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }
    if (this.$.cover) {
      this.$.cover.classList.toggle('playing', isPlaying);
    }
  },

  _updateAiStatus() {
    // 更新 AI 指示器（在 header 中）
    const dot = document.querySelector('#aiDot');
    const status = document.querySelector('#aiStatus');
    if (!dot || !status) return;

    dot.className = `ai-indicator__dot ${store.aiStatus}`;
    const labels = { idle: '在线', thinking: '思考中', speaking: '说话中', degraded: '降级运行', offline: '离线' };
    status.textContent = labels[store.aiStatus] || store.aiStatus;
  },

  // ---- 工具 ----

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  _formatTime(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
};

export default Player;
