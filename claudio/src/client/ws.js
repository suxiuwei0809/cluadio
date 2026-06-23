// ============================================================
// ws.js — ReconnectingWebSocket 封装（Spec 6.4）
// 指数退避重连 1s→2s→4s→8s→30s 上限
// 断线期间缓存消息，重连后批量发送
// ============================================================

import store from './store.js';

/**
 * ReconnectingWebSocket 封装。
 * 驱动所有 WS 推送 → store.update()
 */
export class ReconnectingWS {
  /**
   * @param {string} url - WebSocket URL
   */
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.retryDelay = 1000;     // 初始重连延迟 1s
    this.maxRetryDelay = 30000; // 最大重连延迟 30s
    this.retryTimer = null;
    this.manualClose = false;

    // 断线消息缓冲队列
    this.pendingMessages = [];

    this.connect();
  }

  /**
   * 建立连接。
   */
  connect() {
    if (this.ws) {
      this.ws.onclose = null; // 清除旧事件
      try { this.ws.close(); } catch {}
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(this.url.startsWith('ws') ? this.url : `${protocol}//${location.host}${this.url}`);

    this.ws.onopen = () => {
      console.log('[WS] 已连接');
      this.retryDelay = 1000; // 重置延迟

      // 发送断线期间缓存的消息
      while (this.pendingMessages.length > 0) {
        const msg = this.pendingMessages.shift();
        this.send(msg);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleMessage(data);
      } catch (err) {
        console.warn('[WS] 无法解析消息:', err.message);
      }
    };

    this.ws.onclose = () => {
      if (this.manualClose) return;
      console.warn(`[WS] 断开，${this.retryDelay}ms 后重连`);
      this._scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] 错误:', err);
    };
  }

  /**
   * 发送消息。若未连接则加入待发送队列。
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } else {
      this.pendingMessages.push(typeof data === 'string' ? data : JSON.stringify(data));
      if (this.pendingMessages.length > 50) {
        this.pendingMessages.shift(); // 限制队列长度
      }
    }
  }

  /**
   * 主动关闭（不含重连）。
   */
  close() {
    this.manualClose = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
  }

  // ---- 内部 ----

  _scheduleReconnect() {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryDelay = Math.min(this.retryDelay * 2, this.maxRetryDelay);
      this.connect();
    }, this.retryDelay);
  }

  /**
   * 处理服务端推送的 WS 消息。
   * 消息类型：NOW_PLAYING | AI_SPEAKING | DEVICE_STATUS |
   *          DEGRADED_STATUS | VOLUME_CHANGED | PLAYBACK_STATE
   */
  _handleMessage(data) {
    const { type, payload } = data;

    switch (type) {
      case 'NOW_PLAYING':
        store.update({
          nowPlaying: {
            ...store.nowPlaying,
            songId: payload.songId || null,
            url: payload.url || null,
            name: payload.meta?.name || payload.name || store.nowPlaying.name,
            artist: payload.meta?.artist || store.nowPlaying.artist,
            source: payload.meta?.source || null
          }
        });
        break;

      case 'AI_SPEAKING':
        store.update({
          aiStatus: 'speaking',
          aiLastText: payload.text || ''
        });
        break;

      case 'PLAYBACK_STATE':
        if (payload.action === 'next' || payload.action === 'prev') {
          // 切歌命令由 AudioEngine 处理
          document.dispatchEvent(
            new CustomEvent('player:command', { detail: { action: payload.action } })
          );
        }
        if (typeof payload.isPlaying === 'boolean') {
          store.update({ isPlaying: payload.isPlaying });
        }
        break;

      case 'VOLUME_CHANGED':
        store.update({ volume: payload.volume });
        break;

      case 'DEGRADED_STATUS':
        if (payload.status === 'degraded') {
          store.update({
            aiStatus: 'degraded',
            degradedServices: [...new Set([...store.degradedServices, payload.service])]
          });
        } else if (payload.status === 'recovered') {
          const services = store.degradedServices.filter(s => s !== payload.service);
          store.update({
            degradedServices: services,
            aiStatus: services.length > 0 ? 'degraded' : 'idle'
          });
        }
        break;

      case 'DEVICE_STATUS':
        // UPnP 设备状态
        document.dispatchEvent(
          new CustomEvent('device:change', { detail: payload })
        );
        break;

      case 'DEEPSEEK_TOGGLE':
        store.update({ deepseekEnabled: payload.enabled });
        break;

      case 'PONG':
        // 心跳响应，忽略
        break;

      default:
        console.log('[WS] 未处理消息:', type);
    }
  }
}

export default ReconnectingWS;
