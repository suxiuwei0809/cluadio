// ============================================================
// store.js — Claudio 全局状态管理（Spec 5.3）
// 原生 CustomEvent + 单一状态对象，零框架依赖
// ============================================================

/**
 * 全局 Store。
 * 所有状态变更通过 update() 触发 'store:change' CustomEvent，
 * 视图组件监听该事件自行更新 DOM。
 */
const store = {
  // ---- 播放状态 ----
  nowPlaying: {
    songId: null,
    url: null,
    name: '等待播放...',
    artist: 'Claudio AI Radio',
    source: null,
    coverUrl: ''
  },
  isPlaying: false,
  volume: 80,

  // ---- AI 状态 ----
  aiStatus: 'idle',      // idle | thinking | speaking | degraded | offline
  aiLastText: '',

  // ---- 服务状态 ----
  degradedServices: [],
  deepseekEnabled: false,

  // ---- 用户数据 ----
  tasteTags: [],
  playHistory: [],

  // ---- 缓存 ----
  cacheCount: 0,
  cacheSize: 0,

  /**
   * 原子更新状态。支持部分合并。
   * @param {object} patch - 要合并的键值对
   */
  update(patch) {
    const changed = {};
    for (const key of Object.keys(patch)) {
      if (this[key] !== patch[key]) {
        this[key] = patch[key];
        changed[key] = patch[key];
      }
    }
    if (Object.keys(changed).length > 0) {
      document.dispatchEvent(
        new CustomEvent('store:change', { detail: { changed, state: { ...this } } })
      );
    }
  },

  /**
   * 重置到初始状态
   */
  reset() {
    this.nowPlaying = { songId: null, url: null, name: '等待播放...', artist: 'Claudio AI Radio', source: null, coverUrl: '' };
    this.isPlaying = false;
    this.aiStatus = 'idle';
    this.aiLastText = '';
    this.degradedServices = [];
    this.tasteTags = [];
    this.playHistory = [];
    this.cacheCount = 0;
    this.cacheSize = 0;
    document.dispatchEvent(
      new CustomEvent('store:change', { detail: { changed: { __reset: true }, state: { ...this } } })
    );
  }
};

// 挂载到 window 供全局访问
window.__claudioStore = store;

export default store;
