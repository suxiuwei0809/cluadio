// ============================================================
// components/Profile.js — 个人品味视图（Spec 5.2）
// 品味雷达图 + 标签云 + 播放记忆时间线 + 语料编辑
// ============================================================

import store from '../store.js';

// 雷达图六轴定义
const RADAR_DIMS = ['摇滚', '爵士', '流行', '电子', '古典', '民谣'];

const Profile = {
  $: {},

  init() {
    this.$.tasteTags = document.querySelector('#taste-tags');
    this.$.playHistory = document.querySelector('#play-history');
    this.$.radar = document.querySelector('#taste-radar');

    // 语料编辑器
    const editor = document.querySelector('#taste-editor');
    const saveBtn = document.querySelector('#btn-save-taste');
    if (saveBtn && editor) {
      saveBtn.addEventListener('click', () => {
        const text = editor.value.trim();
        if (!text) return;
        fetch('/api/taste', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw: text })
        }).catch(() => {
          this._toast('保存失败，请检查网络');
        });
        this._toast('品味偏好已保存');
      });
    }

    this._listenStore();
    // 初始绘制
    this._drawRadar(store.tasteTags || []);
  },

  _listenStore() {
    document.addEventListener('store:change', (e) => {
      const { changed } = e.detail;
      if ('tasteTags' in changed) {
        this._renderTags();
        this._drawRadar(store.tasteTags);
      }
      if ('playHistory' in changed) this._renderHistory();
    });
  },

  /**
   * 将标签词映射到六维度的数值 (0–100)。
   * 关键词匹配规则。
   */
  _tagsToScores(tags) {
    const dims = RADAR_DIMS;
    const scores = dims.reduce((o, d) => { o[d] = 0; return o; }, {});

    const rules = {
      '摇滚': ['摇滚', 'rock', '金属', 'metal', '朋克', 'punk'],
      '爵士': ['爵士', 'jazz', '蓝调', 'blues', 'swing', 'latin'],
      '流行': ['流行', 'pop', '华语', '国语', '粤语', 'kpop', 'jpop', 'ballad'],
      '电子': ['电子', 'electronic', 'edm', 'house', 'techno', 'ambient', 'lofi'],
      '古典': ['古典', 'classical', '交响', '钢琴', 'piano', '小提琴', 'violin', '管弦', 'orchestra'],
      '民谣': ['民谣', 'folk', '乡村', 'country', 'acoustic', '吉他', 'guitar', 'indie']
    };

    for (const tag of tags) {
      const t = tag.toLowerCase();
      for (const [dim, keywords] of Object.entries(rules)) {
        if (keywords.some(k => t.includes(k))) {
          scores[dim] = Math.min(100, scores[dim] + 25);
        }
      }
    }
    // 无数据时给少量默认值以免雷达图为空
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    if (total === 0) {
      dims.forEach(d => { scores[d] = 10; });
    }
    return scores;
  },

  /**
   * Canvas 雷达图绘制。
   */
  _drawRadar(tags) {
    const canvas = this.$.radar;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const radius = 100;
    const dims = RADAR_DIMS;
    const N = dims.length;
    const scores = this._tagsToScores(tags);

    ctx.clearRect(0, 0, W, H);

    // 背景网格（3 层同心多边形）
    for (let level = 1; level <= 3; level++) {
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const angle = (Math.PI * 2 / N) * i - Math.PI / 2;
        const r = (radius / 3) * level;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 轴线
    for (let i = 0; i < N; i++) {
      const angle = (Math.PI * 2 / N) * i - Math.PI / 2;
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.stroke();
    }

    // 数据多边形
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const angle = (Math.PI * 2 / N) * i - Math.PI / 2;
      const val = (scores[dims[i]] || 0) / 100;
      const r = radius * val;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 179, 0, 0.15)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 179, 0, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 数据点
    for (let i = 0; i < N; i++) {
      const angle = (Math.PI * 2 / N) * i - Math.PI / 2;
      const val = (scores[dims[i]] || 0) / 100;
      const r = radius * val;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#FFB300';
      ctx.fill();
    }

    // 标签
    ctx.fillStyle = '#B3B3B3';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      const angle = (Math.PI * 2 / N) * i - Math.PI / 2;
      const labelR = radius + 20;
      const x = cx + labelR * Math.cos(angle);
      const y = cy + labelR * Math.sin(angle);
      ctx.fillText(dims[i], x, y);
    }
  },

  _renderTags() {
    const el = this.$.tasteTags;
    if (!el) return;

    const tags = store.tasteTags;
    if (!tags || tags.length === 0) {
      el.innerHTML = '<p class="muted-text" style="color:var(--color-text-disabled)">多听几首歌后，这里会出现你的音乐口味。</p>';
      return;
    }

    el.innerHTML = tags.map(t =>
      `<span class="tag" style="display:inline-block;padding:4px 12px;margin:4px;background:rgba(255,179,0,0.12);border-radius:16px;font-size:12px;color:var(--color-accent)">${t}</span>`
    ).join('');
  },

  _renderHistory() {
    const el = this.$.playHistory;
    if (!el) return;

    const history = store.playHistory;
    if (!history || history.length === 0) {
      el.innerHTML = '<p class="muted-text" style="color:var(--color-text-disabled)">还没有播放记录。</p>';
      return;
    }

    const items = history.slice(-20).reverse();
    el.innerHTML = items.map((h, i) => `
      <div class="timeline-item" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <span style="color:var(--color-text-disabled);font-size:12px;min-width:40px">#${items.length - i}</span>
        <span style="flex:1;color:var(--color-text-primary);font-size:13px">${h.song || '未知'}</span>
        <span style="color:var(--color-text-disabled);font-size:11px">${h.time ? new Date(h.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
      </div>
    `).join('');
  },

  _toast(msg) {
    const container = document.querySelector('#toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.style.cssText = 'background:var(--color-bg-elevated);color:var(--color-text-primary);padding:8px 16px;border-radius:8px;margin:4px;font-size:13px;animation:fadeIn 0.3s ease';
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 2500);
  }
};

export default Profile;
