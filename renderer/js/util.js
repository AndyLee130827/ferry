(function () {
  'use strict';
  /* global window, document */
  const F = (window.F = window.F || {});

  // ---------- DOM ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(3)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---------- 图标 ----------
  const PATHS = {
    folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3.2c.4 0 .78.16 1.06.44L8.9 4.5h3.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z',
    file: 'M4 2.5h4.6L12 5.9v7.6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Zm4.5.9v2.7h2.7',
    link: 'M6.3 9.7 9.7 6.3M7 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7L10.7 8.3M9 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7L5.3 7.7',
    server: 'M2.5 4.2A1.2 1.2 0 0 1 3.7 3h8.6A1.2 1.2 0 0 1 13.5 4.2v2A1.2 1.2 0 0 1 12.3 7.4H3.7A1.2 1.2 0 0 1 2.5 6.2v-2Zm0 5.6A1.2 1.2 0 0 1 3.7 8.6h8.6A1.2 1.2 0 0 1 13.5 9.8v2a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2v-2ZM4.8 5.2h.01M4.8 10.8h.01',
    home: 'M2.8 7 8 2.8 13.2 7M4.3 6v6.5c0 .3.2.5.5.5h2.4V9.8h1.6V13h2.4a.5.5 0 0 0 .5-.5V6',
    desktop: 'M2.5 3.8h11v6.4h-11zM6 13h4M8 10.2V13',
    download: 'M8 3v6.4M5.2 7.2 8 10l2.8-2.8M3 12.4h10',
    doc: 'M4.2 2.6h5L12 5.4v8H4.2zM6.2 7.6h3.6M6.2 10h3.6',
    plus: 'M8 3.6v8.8M3.6 8h8.8',
    minus: 'M3.6 8h8.8',
    x: 'M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4',
    check: 'M3.6 8.4 6.4 11.2l6-6.4',
    chevL: 'M9.8 4 5.8 8l4 4',
    chevR: 'M6.2 4l4 4-4 4',
    chevU: 'M4 9.8 8 5.8l4 4',
    chevD: 'M4 6.2 8 10.2l4-4',
    refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 3.2v2.6h-2.6',
    search: 'M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4ZM10.4 10.4 13.4 13.4',
    gear: 'M8 10.1a2.1 2.1 0 1 0 0-4.2 2.1 2.1 0 0 0 0 4.2ZM8 1.9l.5 1.5 1.6.3 1.1-1.1 1.2 1.2-1.1 1.1.3 1.6 1.5.5v1.7l-1.5.5-.3 1.6 1.1 1.1-1.2 1.2-1.1-1.1-1.6.3L8 14.1l-1.7-.5-.5-1.5-1.6-.3-1.1 1.1-1.2-1.2 1.1-1.1-.3-1.6L1.9 8.6V6.9l1.5-.5.3-1.6L2.6 3.7l1.2-1.2 1.1 1.1 1.6-.3L8 1.9Z',
    trash: 'M3.4 5h9.2M6.3 5V3.6h3.4V5M4.6 5l.6 8.1h5.6L11.4 5M6.8 7.4v3.4M9.2 7.4v3.4',
    pencil: 'M11.2 2.9 13.1 4.8 5.6 12.3 2.9 13.1 3.7 10.4ZM9.8 4.3l1.9 1.9',
    key: 'M10.2 2.8a3.2 3.2 0 1 1-2.4 5.3L3 12.9H2v-1l.9-.9v-1h1v-1h1l1.8-1.8A3.2 3.2 0 0 1 10.2 2.8Zm.6 2.3h.01',
    lock: 'M4.6 7.2h6.8v6H4.6zM6.1 7.2V5.4a1.9 1.9 0 0 1 3.8 0v1.8',
    user: 'M8 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM3.4 13.2a4.6 4.6 0 0 1 9.2 0',
    up: 'M8 12.6V3.8M4.4 7.4 8 3.8l3.6 3.6',
    arrowR: 'M3 8h9.2M8.8 4.4 12.4 8l-3.6 3.6',
    arrowL: 'M13 8H3.8M7.2 4.4 3.6 8l3.6 3.6',
    pause: 'M5.6 3.6v8.8M10.4 3.6v8.8',
    play: 'M5.4 3.4 12 8l-6.6 4.6z',
    retry: 'M3 8a5 5 0 1 0 5-5M8 1.2 10.6 3 8 4.8',
    warn: 'M8 2.6 14.2 13H1.8L8 2.6ZM8 6.4v3.2M8 11.4h.01',
    info: 'M8 13.8A5.8 5.8 0 1 0 8 2.2a5.8 5.8 0 0 0 0 11.6ZM8 7.4v3.6M8 5.4h.01',
    eye: 'M1.6 8S4.2 3.8 8 3.8 14.4 8 14.4 8 11.8 12.2 8 12.2 1.6 8 1.6 8Zm6.4 1.9a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z',
    dots: 'M4 8h.01M8 8h.01M12 8h.01',
    bolt: 'M9 1.8 3.6 9.2h3.2l-.8 5 5.4-7.4H8.2z',
    terminal: 'M2.4 3.4h11.2v9.2H2.4zM4.8 6.4 6.6 8l-1.8 1.6M8.4 10h3',
    folderPlus: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3.2c.4 0 .78.16 1.06.44L8.9 4.5h3.6A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7ZM8 7.2v3.4M6.3 8.9h3.4',
    import: 'M8 10.4V2.6M5.2 7.6 8 10.4l2.8-2.8M2.8 13.4h10.4',
    power: 'M8 2.6v4.8M11.4 4.4a4.8 4.8 0 1 1-6.8 0',
    cmd: 'M5.4 5.4h5.2v5.2H5.4zM5.4 5.4a1.6 1.6 0 1 0-1.6-1.6v1.6Zm5.2 0a1.6 1.6 0 1 1 1.6-1.6v1.6Zm0 5.2a1.6 1.6 0 1 1 1.6 1.6h-1.6Zm-5.2 0a1.6 1.6 0 1 0-1.6 1.6h1.6Z',
  };

  function icon(name, size = 16, extra = '') {
    const d = PATHS[name] || PATHS.file;
    const filled = name === 'play' || name === 'bolt';
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" class="${extra}" aria-hidden="true"><path d="${d}"/></svg>`;
  }
  function iconEl(name, size = 16, extra = '') {
    const span = document.createElement('span');
    span.innerHTML = icon(name, size, extra);
    return span.firstChild;
  }

  // ---------- 格式化 ----------
  const KB = 1024;
  function bytes(n) {
    if (n === null || n === undefined) return '—';
    if (n < KB) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n / KB;
    let i = 0;
    while (v >= KB && i < units.length - 1) { v /= KB; i += 1; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }
  function speed(bps) {
    if (!bps || bps < 1) return '—';
    return `${bytes(bps)}/s`;
  }
  function duration(secs) {
    if (secs === null || secs === undefined || !isFinite(secs)) return '—';
    const s = Math.max(0, Math.round(secs));
    if (s < 60) return `${s} 秒`;
    if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
  }
  function when(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const pad = (x) => String(x).padStart(2, '0');
    if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameYear = d.getFullYear() === now.getFullYear();
    const base = `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return sameYear ? base : `${d.getFullYear()}年${base}`;
  }
  function modeStr(mode) {
    if (mode === null || mode === undefined) return '';
    return (mode & 0o777).toString(8).padStart(3, '0');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 其它 ----------
  const posix = {
    join: (...parts) => {
      const p = parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
      return p.length > 1 ? p.replace(/\/$/, '') : p;
    },
    dirname: (p) => {
      const t = p.replace(/\/+$/, '');
      const i = t.lastIndexOf('/');
      if (i < 0) return '.';
      return i === 0 ? '/' : t.slice(0, i);
    },
    basename: (p) => {
      const t = String(p).replace(/\/+$/, '');
      return t.slice(t.lastIndexOf('/') + 1) || '/';
    },
  };
  const nativePath = {
    join: (...parts) => parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
    dirname: posix.dirname,
    basename: posix.basename,
  };

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  // 自然排序：file2 排在 file10 前面
  const collator = new Intl.Collator(['zh-Hans', 'en'], { numeric: true, sensitivity: 'base' });
  const naturalCmp = (a, b) => collator.compare(a, b);

  Object.assign(F, {
    h, $, $$, clear, icon, iconEl, bytes, speed, duration, when, modeStr,
    escapeHtml, posix, nativePath, debounce, naturalCmp,
  });

})();
