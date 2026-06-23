// ============================================================
// components/Settings.js — 设置视图（Spec 5.2）
// AI 人格调节 + 服务状态灯 + UPnP 设备 + PWA 缓存管理
// ============================================================

import store from '../store.js';

const Settings = {
  $: {},

  init() {
    this.$.statusDeepSeek = document.querySelector('#status-deepseek');
    this.$.statusNetease = document.querySelector('#status-netease');
    this.$.statusFish = document.querySelector('#status-fish');
    this.$.statusFeishu = document.querySelector('#status-feishu');
    this.$.statusWeather = document.querySelector('#status-weather');
    this.$.upnpDevices = document.querySelector('#upnp-devices');
    this.$.cacheCount = document.querySelector('#cache-count');
    this.$.cacheSize = document.querySelector('#cache-size');
    this.$.deepseekToggle = document.querySelector('#toggle-deepseek');

    this._bindControls();
    this._listenStore();

    // 初始加载 DeepSeek 开关状态
    this._loadDeepseekToggle();
  },

  _bindControls() {
    // DeepSeek 开关
    if (this.$.deepseekToggle) {
      this.$.deepseekToggle.addEventListener('change', async () => {
        const enabled = this.$.deepseekToggle.checked;
        try {
          const res = await fetch('/api/deepseek/toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          const data = await res.json();
          if (data.ok) {
            store.update({ deepseekEnabled: enabled });
            this._toast(`DeepSeek 已${enabled ? '开启' : '关闭'}`);
          }
        } catch {
          // 恢复原状态
          this.$.deepseekToggle.checked = !enabled;
          this._toast('切换失败，请重试');
        }
      });
    }

    // AI 人格设置
    const freq = document.querySelector('#setting-frequency');
    const style = document.querySelector('#setting-style');
    if (freq) {
      freq.addEventListener('change', () => this._saveSettings());
    }
    if (style) {
      style.addEventListener('change', () => this._saveSettings());
    }

    // UPnP 扫描
    const scanBtn = document.querySelector('#btn-scan-devices');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => {
        this._renderDevices([{ name: '搜索中…', status: 'scanning' }]);
        fetch('/api/upnp/scan').then(r => r.json()).then(data => {
          this._renderDevices(data.devices || []);
        }).catch(() => {
          this._renderDevices([{ name: '未发现设备', status: 'offline' }]);
        });
      });
    }

    // 清除缓存
    const clearCache = document.querySelector('#btn-clear-cache');
    if (clearCache) {
      clearCache.addEventListener('click', async () => {
        if ('caches' in window) {
          const keys = await caches.keys();
          for (const key of keys) await caches.delete(key);
          store.update({ cacheCount: 0, cacheSize: 0 });
          this._toast('缓存已清除');
        }
      });
    }
  },

  _listenStore() {
    document.addEventListener('store:change', (e) => {
      const { changed } = e.detail;
      if ('degradedServices' in changed) this._updateServiceStatus();
      if ('cacheCount' in changed || 'cacheSize' in changed) this._updateCacheInfo();
      if ('deepseekEnabled' in changed) this._syncDeepseekToggle();
    });
  },

  _updateServiceStatus() {
    const degraded = store.degradedServices;
    this._setBadge(this.$.statusDeepSeek, degraded.includes('deepseek') ? 'degraded' : 'online');
    this._setBadge(this.$.statusNetease, degraded.includes('netease') ? 'degraded' : 'online');
    this._setBadge(this.$.statusFish, degraded.includes('fish') ? 'degraded' : 'online');
  },

  _setBadge(el, status) {
    if (!el) return;
    el.className = `badge badge--${status}`;
    const labels = { online: '在线', degraded: '降级', offline: '离线', unknown: '未配置' };
    el.textContent = labels[status] || status;
  },

  _updateCacheInfo() {
    if (this.$.cacheCount) this.$.cacheCount.textContent = store.cacheCount;
    if (this.$.cacheSize) this.$.cacheSize.textContent = `共 ${store.cacheSize} MB`;
  },

  _renderDevices(devices) {
    const el = this.$.upnpDevices;
    if (!el) return;

    if (!devices || devices.length === 0) {
      el.innerHTML = '<p class="muted-text" style="color:var(--color-text-disabled)">未发现 UPnP 设备</p>';
      return;
    }

    el.innerHTML = devices.map(d => `
      <div class="device-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <span style="color:var(--color-text-primary);font-size:13px">${d.name}</span>
        <span class="badge badge--${d.status === 'scanning' ? 'online' : 'offline'}" style="${d.status === 'scanning' ? 'animation:pulse 2s ease-in-out infinite' : ''}">${d.status === 'scanning' ? '搜索中' : '可投送'}</span>
      </div>
    `).join('');
  },

  async _saveSettings() {
    const freq = document.querySelector('#setting-frequency')?.value;
    const style = document.querySelector('#setting-style')?.value;
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { frequency: freq, style } })
      });
    } catch {}
  },

  async _loadDeepseekToggle() {
    try {
      const res = await fetch('/api/deepseek/toggle');
      const data = await res.json();
      store.update({ deepseekEnabled: data.deepseekEnabled });
    } catch {}
  },

  _syncDeepseekToggle() {
    if (this.$.deepseekToggle) {
      this.$.deepseekToggle.checked = store.deepseekEnabled;
    }
  },

  _toast(msg) {
    const container = document.querySelector('#toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.style.cssText = 'background:var(--color-bg-elevated);color:var(--color-text-primary);padding:8px 16px;border-radius:8px;margin:4px;font-size:13px;animation:fadeIn 0.3s ease';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }
};

export default Settings;
