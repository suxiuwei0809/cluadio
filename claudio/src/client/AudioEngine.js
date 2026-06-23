// ============================================================
// AudioEngine.js — 双 Audio 无缝切换 + Web Audio API
// 严格按照 Spec 5.3 实现：
//   - 双 <audio> 预加载（剩余 10s 加载下一首）
//   - Web Audio API 处理音频管线（禁止第三方播放器 SDK）
//   - error 事件自动重试（最多 3 次，Spec 6.2）
//   - CustomEvent 驱动状态通知
//   - 详细时序注释
// ============================================================

/**
 * 切换时序图：
 *
 *   t=-10s  t=0               t=duration-10s
 *   [preload B]──→ [B 就绪，等待A结束]
 *     │                   │
 *     │    A fade out ────┤──────── B fade in
 *     │    (volume 1→0)   │         (volume 0→1)
 *     │    duration: 2s   │         duration: 2s
 *     ▼                   ▼
 *   [track:preload]    [track:start(B)] [track:end(A)]
 *
 * 错误重试时序（Spec 6.2）：
 *   track error → retryCount++ → 500ms → retry url
 *   if retryCount >= 3 → [track:error] → 停止
 */

export class AudioEngine {
  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.eventTarget] - CustomEvent 的挂载元素（默认 document）
   * @param {number} [options.preloadThreshold=10] - 预加载触发剩余秒数
   * @param {number} [options.crossfadeDuration=2] - 淡入淡出时长（秒）
   * @param {number} [options.maxRetries=3] - 最大错误重试次数
   */
  constructor(options = {}) {
    this.eventTarget = options.eventTarget || document;
    this.preloadThreshold = options.preloadThreshold ?? 10;
    this.crossfadeDuration = options.crossfadeDuration ?? 2;
    this.maxRetries = options.maxRetries ?? 3;

    // ---- 双 Audio 元素（Spec 5.3） ----
    this.audioA = new Audio();
    this.audioB = new Audio();

    // 标记当前活跃的音频槽位
    this.activeSlot = null;   // 'A' | 'B' | null
    this.standbySlot = null;  // 'B' | 'A' | null

    // 下一首 URL（由 store/WS 驱动预加载）
    this.nextUrl = null;

    // 重试状态
    this.retryCount = 0;
    this.currentUrl = null;

    // 预加载标记：防止重复预加载同一条 URL
    this.preloadedUrl = null;

    // 是否正在交叉淡入淡出
    this.isCrossfading = false;

    // 防止 ended 事件重入
    this._endingSlot = null;

    // 音量（0-1）
    this._volume = 0.8;

    // ---- Web Audio API 管线（Spec 5.3） ----
    /** @type {AudioContext|null} */
    this.audioCtx = null;
    /** @type {GainNode|null} */
    this.gainNodeA = null;
    /** @type {GainNode|null} */
    this.gainNodeB = null;
    /** @type {AnalyserNode|null} */
    this.analyserNode = null;

    // ---- 绑定方法 ----
    this._initAudioElements();
  }

  // ============================================================
  // 初始化
  // ============================================================

  /**
   * 初始化 Audio 元素的事件监听。
   * 两个 audio 元素共用同一套事件处理逻辑。
   */
  _initAudioElements() {
    [this.audioA, this.audioB].forEach((audio, i) => {
      const slot = i === 0 ? 'A' : 'B';

      // ---- 加载完成 ----
      audio.addEventListener('canplaythrough', () => {
        // 预加载完成通知
        if (this[`audio${slot}`] !== this._active()) {
          this._emit('track:preload', { slot, src: audio.src });
        }
      });

      // ---- 播放进度（每 250ms 检查预加载阈值） ----
      let preloadChecked = false;
      audio.addEventListener('timeupdate', () => {
        // 只在当前活跃的 track 上检查预加载条件
        if (this[`audio${slot}`] !== this._active()) return;

        const remaining = audio.duration - audio.currentTime;

        // === 关键时序：剩余 10s 时预加载下一首 ===
        if (remaining <= this.preloadThreshold && !preloadChecked && this.nextUrl) {
          preloadChecked = true;
          this._preloadNext(this.nextUrl);
        }

        // 送出当前播放进度
        this._emit('track:progress', {
          currentTime: audio.currentTime,
          duration: audio.duration,
          remaining,
          progress: audio.duration > 0 ? audio.currentTime / audio.duration : 0
        });
      });

      // ---- 播放结束（自然结束，非用户触发） ----
      // 使用 onended 属性便于 stop() 中清空防止重入
      audio.onended = () => {
        // 防止 stop() 清空 src 后再次触发 ended 导致重入
        if (this._endingSlot === slot) return;
        this._endingSlot = slot;

        // 重置预加载标记
        preloadChecked = false;

        // 如果 standby 已预加载，自动切换到 standby
        const standby = this._standby();
        if (standby && standby.src && standby.readyState >= 3) {
          this._endingSlot = null;
          this._switchToStandby();
        } else {
          // 先保存当前 URL，stop() 会清空它
          const endedUrl = this.currentUrl;
          // stop(false) 不 emit track:end，避免重复触发
          this.stop(false);
          // 手动发送 track:end，携带 endedUrl 供上层判断
          this._emit('track:end', { slot, reason: 'ended', url: endedUrl });
          this._endingSlot = null;
        }
      };

      // ---- 错误处理（Spec 6.2: 最多重试 3 次） ----
      audio.addEventListener('error', () => {
        console.warn(`[AudioEngine] 播放错误 (slot=${slot}, retry=${this.retryCount}/${this.maxRetries})`);

        if (this.retryCount < this.maxRetries) {
          // 递增重试计数
          this.retryCount++;
          const delay = 500 * this.retryCount; // 500ms, 1000ms, 1500ms

          this._emit('track:retry', { slot, retry: this.retryCount, max: this.maxRetries, delay });

          // 延迟后重试同一 URL
          setTimeout(() => {
            if (this.currentUrl) {
              this._load(audio, this.currentUrl);
            }
          }, delay);
        } else {
          // 超过重试上限
          this._emit('track:error', { slot, reason: 'max_retries_exceeded', url: this.currentUrl });
          this.retryCount = 0;
          this.stop();
        }
      });

      // ---- 开始播放 ----
      audio.addEventListener('play', () => {
        // 仅在当前活跃 slot 的首次 play 时发送 track:start
        if (this.activeSlot === slot) {
          this._emit('track:start', { slot, src: audio.src });
          this.retryCount = 0; // 播放成功，重置重试计数
        }
      });

      // ---- 暂停 ----
      audio.addEventListener('pause', () => {
        if (this.activeSlot === slot && !this.isCrossfading) {
          this._emit('track:pause', { slot });
        }
      });
    });
  }

  // ============================================================
  // 内部：Audio 元素快捷访问
  // ============================================================

  /** @returns {HTMLAudioElement} 当前活跃的 Audio 元素 */
  _active() {
    return this.activeSlot === 'A' ? this.audioA : this.activeSlot === 'B' ? this.audioB : null;
  }

  /** @returns {HTMLAudioElement} 当前待命的 Audio 元素 */
  _standby() {
    return this.standbySlot === 'A' ? this.audioA : this.standbySlot === 'B' ? this.audioB : null;
  }

  /**
   * 获取某个 slot 的 GainNode。
   */
  _gain(slot) {
    return slot === 'A' ? this.gainNodeA : this.gainNodeB;
  }

  // ============================================================
  // Web Audio API 管线
  // ============================================================

  /**
   * 惰性初始化 AudioContext（需用户交互后才能创建 AudioContext）。
   * Web Audio API 要求：浏览器必须在用户手势后创建 AudioContext。
   */
  _ensureAudioContext() {
    if (this.audioCtx) return;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // ---- 管线：MediaElementSource → GainNode → AnalyserNode → destination ----
    // Channel A
    const sourceA = this.audioCtx.createMediaElementSource(this.audioA);
    this.gainNodeA = this.audioCtx.createGain();
    this.gainNodeA.gain.value = 0;

    // Channel B
    const sourceB = this.audioCtx.createMediaElementSource(this.audioB);
    this.gainNodeB = this.audioCtx.createGain();
    this.gainNodeB.gain.value = 0;

    // Analyser（用于可视化波形/频谱）
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 256;

    // 连接：SourceA → GainA → Analyser → Destination
    //       SourceB → GainB ↗
    sourceA.connect(this.gainNodeA);
    sourceB.connect(this.gainNodeB);
    this.gainNodeA.connect(this.analyserNode);
    this.gainNodeB.connect(this.analyserNode);
    this.analyserNode.connect(this.audioCtx.destination);
  }

  /**
   * 获取频率数据用于可视化。
   * @returns {Uint8Array|null}
   */
  getFrequencyData() {
    if (!this.analyserNode) return null;
    const data = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(data);
    return data;
  }

  // ============================================================
  // 核心：双 Audio 切换
  // ============================================================

  /**
   * 加载音频 URL 到指定的 Audio 元素。
   * 不触发播放，仅加载。
   */
  _load(audio, url) {
    return new Promise((resolve, reject) => {
      audio.src = url;
      audio.load();

      const onReady = () => {
        audio.removeEventListener('canplaythrough', onReady);
        audio.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        audio.removeEventListener('canplaythrough', onReady);
        audio.removeEventListener('error', onError);
        reject(new Error(`Failed to load: ${url}`));
      };

      audio.addEventListener('canplaythrough', onReady, { once: false });
      audio.addEventListener('error', onError, { once: true });
    });
  }

  /**
   * 预加载下一首到 standby Audio 元素。
   * Spec 5.3：剩余 10s 时由 timeupdate 触发。
   */
  async _preloadNext(url) {
    if (this.preloadedUrl === url) return; // 已预加载同一条
    const standby = this._standby();
    if (!standby) return;

    try {
      await this._load(standby, url);
      this.preloadedUrl = url;
      console.log(`[AudioEngine] 预加载完成: ${url.slice(0, 50)}...`);
    } catch (err) {
      console.warn('[AudioEngine] 预加载失败:', err.message);
    }
  }

  /**
   * 切换到 standby Audio 元素（淡入淡出过渡）。
   * Spec 5.3 核心：双 audio 无缝切换。
   */
  async _switchToStandby() {
    if (!this.standbySlot || this.isCrossfading) return;

    const oldSlot = this.activeSlot;
    const newSlot = this.standbySlot;
    const oldAudio = this._active();
    const newAudio = this._standby();

    this.isCrossfading = true;

    // 确保 Web Audio 管线就绪
    this._ensureAudioContext();

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
      // 修复 resume() 后已把 audio 接回 destination 的问题
      // 不需要额外处理，GainNode 仍在线路上
    }

    const oldGain = this._gain(oldSlot);
    const newGain = this._gain(newSlot);

    // 设置新 track 增益为 0，准备淡入
    newGain.gain.setValueAtTime(0, this.audioCtx.currentTime);
    newAudio.currentTime = 0;

    try {
      await newAudio.play();
    } catch (err) {
      console.error('[AudioEngine] 切换播放失败:', err.message);
      this.isCrossfading = false;
      return;
    }

    // === 交叉淡入淡出（duration = crossfadeDuration 秒） ===
    const now = this.audioCtx.currentTime;

    // 旧 track: 增益从当前值线性降到 0
    oldGain.gain.setValueAtTime(oldGain.gain.value, now);
    oldGain.gain.linearRampToValueAtTime(0, now + this.crossfadeDuration);

    // 新 track: 增益从 0 线性升到目标音量
    newGain.gain.setValueAtTime(0, now);
    newGain.gain.linearRampToValueAtTime(this._volume, now + this.crossfadeDuration);

    // 交叉淡入淡出完成后清理旧 track
    setTimeout(() => {
      oldAudio.pause();
      oldAudio.src = '';   // 释放资源
      this.isCrossfading = false;
      this.preloadedUrl = null;
      this._emit('track:switched', { from: oldSlot, to: newSlot });
    }, this.crossfadeDuration * 1000 + 100); // 多 100ms 确保 ramp 完成

    // 更新槽位状态
    this.activeSlot = newSlot;
    this.standbySlot = oldSlot;
  }

  // ============================================================
  // 公开 API：播放控制
  // ============================================================

  /**
   * 播放指定 URL。
   * 首次播放使用 audioA，后续播放通过预加载+切换机制。
   *
   * @param {string} url - 音频 URL
   * @param {object} [meta] - 歌曲元信息
   */
  async play(url, meta = {}) {
    if (!url) {
      console.warn('[AudioEngine] play() called with empty URL');
      return;
    }

    this._ensureAudioContext();
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // 如果已被预加载到 standby → 直接切换
    const standby = this._standby();
    if (standby && standby.src === url && standby.readyState >= 3) {
      await this._switchToStandby();
      return;
    }

    // 否则，停止当前并加载到空闲 slot
    this.stop(false); // 不触发 track:end

    const targetAudio = this.activeSlot === 'A' ? this.audioB : this.audioA;
    const targetSlot = this.activeSlot === 'A' ? 'B' : 'A';

    this.currentUrl = url;

    try {
      await this._load(targetAudio, url);
    } catch (err) {
      this._emit('track:error', { reason: 'load_failed', url });
      return;
    }

    // 设置增益
    const targetGain = this._gain(targetSlot);
    if (targetGain) {
      targetGain.gain.setValueAtTime(this._volume, this.audioCtx.currentTime);
    }

    try {
      await targetAudio.play();
    } catch (err) {
      console.error('[AudioEngine] play() 失败:', err.message);
      this._emit('track:error', { reason: 'play_rejected', url });
      return;
    }

    this.activeSlot = targetSlot;
    this.standbySlot = targetSlot === 'A' ? 'B' : 'A';

    this._emit('track:start', { slot: targetSlot, url, meta });
  }

  /**
   * 暂停当前播放。
   */
  pause() {
    const active = this._active();
    if (active) active.pause();
  }

  /**
   * 恢复播放。
   */
  resume() {
    const active = this._active();
    if (active && active.src) {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      active.play().catch(err => {
        console.error('[AudioEngine] resume() 失败:', err.message);
      });
    }
  }

  /**
   * 停止播放，清理资源。
   * @param {boolean} [emitEnd=true] - 是否触发 track:end 事件
   */
  stop(emitEnd = true) {
    const active = this._active();
    const activeUrl = this.currentUrl;

    // 先清空槽位标记，防止 _active()/_standby() 在清理期间被意外引用
    const oldActiveSlot = this.activeSlot;
    const oldStandbySlot = this.standbySlot;
    this.activeSlot = null;
    this.standbySlot = null;
    this.currentUrl = null;
    this.preloadedUrl = null;
    this.retryCount = 0;

    if (active) {
      if (emitEnd && active.src) {
        this._emit('track:end', { slot: oldActiveSlot, reason: 'stopped', url: activeUrl });
      }
      // 先移除 ended 监听再清空 src，防止 src='' 触发 ended 事件
      active.onended = null;
      active.pause();
      active.src = '';
    }

    // 同时清理 standby
    const standby = oldStandbySlot === 'A' ? this.audioA : oldStandbySlot === 'B' ? this.audioB : null;
    if (standby) {
      standby.onended = null;
      standby.pause();
      standby.src = '';
    }
  }

  /**
   * 跳转到指定时间。
   * @param {number} seconds
   */
  seek(seconds) {
    const active = this._active();
    if (active && isFinite(seconds)) {
      active.currentTime = Math.max(0, Math.min(seconds, active.duration || 0));
    }
  }

  /**
   * 设置下一首 URL（供 WS 或 store 调用）。
   * 设置后，当前 track 进入最后 10s 时自动预加载。
   * @param {string} url
   */
  setNext(url) {
    this.nextUrl = url;
  }

  // ============================================================
  // 音量控制
  // ============================================================

  /**
   * 设置音量。
   * @param {number} vol - 0-1 或 0-100
   */
  setVolume(vol) {
    // 兼容 0-100 的整数输入
    this._volume = vol > 1 ? Math.min(1, Math.max(0, vol / 100)) : Math.min(1, Math.max(0, vol));

    // 更新活跃 slot 的 GainNode
    const gain = this._gain(this.activeSlot);
    if (gain && this.audioCtx) {
      gain.gain.setValueAtTime(this._volume, this.audioCtx.currentTime);
    }
  }

  /** @returns {number} 0-1 */
  get volume() {
    return this._volume;
  }

  // ============================================================
  // 状态查询
  // ============================================================

  /** @returns {boolean} */
  get isPlaying() {
    const active = this._active();
    return active ? !active.paused : false;
  }

  /** @returns {number} 当前播放时间（秒） */
  get currentTime() {
    const active = this._active();
    return active ? active.currentTime : 0;
  }

  /** @returns {number} 总时长（秒） */
  get duration() {
    const active = this._active();
    return active ? active.duration || 0 : 0;
  }

  // ============================================================
  // 事件系统（Spec 5.3: CustomEvent）
  // ============================================================

  /**
   * 发送 CustomEvent。
   * @param {string} type - 事件类型
   * @param {object} [detail={}] - 事件载荷
   */
  _emit(type, detail = {}) {
    const event = new CustomEvent(type, { detail });
    this.eventTarget.dispatchEvent(event);
  }

  /**
   * 监听事件。
   * @param {string} type - 事件类型
   * @param {Function} handler
   */
  on(type, handler) {
    this.eventTarget.addEventListener(type, handler);
  }

  /** 移除事件监听 */
  off(type, handler) {
    this.eventTarget.removeEventListener(type, handler);
  }

  // ============================================================
  // 销毁
  // ============================================================

  /**
   * 销毁引擎，释放所有资源。
   */
  destroy() {
    this.stop(false);
    this.audioA.remove();
    this.audioB.remove();
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.gainNodeA = null;
    this.gainNodeB = null;
    this.analyserNode = null;
  }
}

export default AudioEngine;
