(function () {
  'use strict';
  /* global window, document */
  const F = window.F;
  const { h, clear, icon, iconEl } = F;

  // ---------- 提示条 ----------
  const toastHost = document.getElementById('toasts');
  function toast(message, kind = 'info', ms = 3200) {
    const el = h('div', { class: `toast ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}` },
      iconEl(kind === 'error' ? 'warn' : kind === 'ok' ? 'check' : 'info', 14),
      h('span', { class: 'truncate', text: message }));
    toastHost.append(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(() => el.remove(), 220);
    }, ms);
    return el;
  }

  // ---------- 模态 ----------
  let openCount = 0;
  function openSheet({ title, desc, body, actions = [], wide = false, onMount, dismissable = true }) {
    return new Promise((resolve) => {
      const sheet = h('div', { class: `sheet${wide ? ' wide' : ''}` });
      if (title || desc) {
        sheet.append(h('div', { class: 'sheet-head' },
          title ? h('div', { class: 'sheet-title', text: title }) : null,
          desc ? h('div', { class: 'sheet-desc', html: typeof desc === 'string' ? desc : '' }) : null));
      }
      const bodyEl = h('div', { class: 'sheet-body' });
      if (body) bodyEl.append(body);
      sheet.append(bodyEl);

      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        openCount -= 1;
        document.removeEventListener('keydown', onKey, true);
        scrim.style.animation = 'fade .12s ease reverse';
        setTimeout(() => scrim.remove(), 110);
        resolve(value);
      };

      const foot = h('div', { class: 'sheet-foot' });
      let primaryBtn = null;
      for (const a of actions) {
        const btn = h('button', {
          class: `btn lg ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger solid' : ''}`,
          text: a.label,
          onclick: async () => {
            if (a.validate) {
              const err = await a.validate();
              if (err) return toast(err, 'error');
            }
            close(a.collect ? a.collect() : a.value);
          },
        });
        if (a.kind === 'primary' || a.kind === 'danger') primaryBtn = btn;
        foot.append(btn);
      }
      if (actions.length) sheet.append(foot);

      const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (dismissable && e.target === scrim) close(null); } }, sheet);

      const onKey = (e) => {
        if (openCount !== myDepth) return;
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
        else if (e.key === 'Enter' && !e.shiftKey && primaryBtn) {
          const t = document.activeElement;
          if (t && (t.tagName === 'TEXTAREA' || t.dataset.noEnter)) return;
          e.stopPropagation(); e.preventDefault();
          primaryBtn.click();
        }
      };

      openCount += 1;
      const myDepth = openCount;
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);
      if (onMount) onMount({ body: bodyEl, close, sheet });
      const focusTarget = sheet.querySelector('[autofocus]') || sheet.querySelector('input,textarea,select') || primaryBtn;
      if (focusTarget) setTimeout(() => focusTarget.focus(), 30);
    });
  }

  function confirm({ title, desc, ok = '确定', cancel = '取消', danger = false, detail }) {
    const body = detail ? h('div', {}, detail) : null;
    return openSheet({
      title,
      desc,
      body,
      actions: [
        { label: cancel, value: false },
        { label: ok, value: true, kind: danger ? 'danger' : 'primary' },
      ],
    }).then((v) => v === true);
  }

  function promptText({ title, desc, label, value = '', placeholder = '', ok = '确定', selectStem = false }) {
    const input = h('input', { class: 'inp', value, placeholder, autofocus: true, spellcheck: 'false' });
    const body = h('div', { class: 'field' }, label ? h('label', { text: label }) : null, input);
    return openSheet({
      title,
      desc,
      body,
      actions: [{ label: '取消', value: null }, { label: ok, kind: 'primary', collect: () => input.value.trim() || null }],
      onMount: () => setTimeout(() => {
        input.focus();
        if (selectStem) {
          const i = value.lastIndexOf('.');
          input.setSelectionRange(0, i > 0 ? i : value.length);
        } else input.select();
      }, 30),
    });
  }

  // ---------- 右键菜单 ----------
  let ctxEl = null;
  function closeCtx() {
    if (ctxEl) { ctxEl.remove(); ctxEl = null; }
  }
  function contextMenu(x, y, items) {
    closeCtx();
    const menu = h('div', { class: 'ctx' });
    for (const it of items) {
      if (!it) continue;
      if (it === 'sep') { menu.append(h('hr')); continue; }
      menu.append(h('button', {
        disabled: !!it.disabled,
        onclick: () => { closeCtx(); it.action && it.action(); },
      },
      it.icon ? iconEl(it.icon, 14) : h('span', { style: { width: '14px' } }),
      h('span', { text: it.label }),
      it.shortcut ? h('span', { class: 'sh', text: it.shortcut }) : null));
    }
    menu.style.left = '0px';
    menu.style.top = '0px';
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    ctxEl = menu;
    const off = () => { closeCtx(); document.removeEventListener('mousedown', off, true); document.removeEventListener('keydown', esc, true); };
    const esc = (e) => { if (e.key === 'Escape') off(); };
    setTimeout(() => {
      document.addEventListener('mousedown', off, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
  }

  // ---------- 来自主进程的询问 ----------
  async function handlePrompt({ id, type, payload }) {
    const reply = (v) => window.ferry.reply(id, v);

    if (type === 'error') {
      await openSheet({
        title: '出错了',
        desc: payload.message,
        actions: [{ label: '好', value: true, kind: 'primary' }],
      });
      return reply({ ok: true });
    }

    if (type === 'password' || type === 'passphrase' || type === 'interactive') {
      const isPass = type === 'passphrase';
      const input = h('input', {
        class: 'inp',
        type: type === 'interactive' && payload.echo ? 'text' : 'password',
        autofocus: true,
        placeholder: isPass ? '私钥口令' : '密码',
      });
      const saveBox = h('input', { type: 'checkbox', checked: true });
      const body = h('div', {},
        h('div', { class: 'field' },
          h('label', { text: type === 'interactive' ? (payload.prompt || '请输入') : isPass ? '私钥口令' : `${payload.user || ''} 的登录密码` }),
          input,
          isPass && payload.keyPath ? h('div', { class: 'hint mono', text: payload.keyPath }) : null),
        payload.canSave ? h('label', { class: 'check' }, saveBox, h('span', { text: '保存到 macOS 钥匙串，下次免输' })) : null);

      const v = await openSheet({
        title: payload.host ? `连接 ${payload.host}` : '需要凭据',
        desc: isPass ? '这把私钥有口令保护。' : undefined,
        body,
        dismissable: false,
        actions: [
          { label: '取消', value: null },
          { label: '继续', kind: 'primary', collect: () => ({ value: input.value, save: payload.canSave && saveBox.checked }) },
        ],
      });
      return reply(v || { cancelled: true });
    }

    if (type === 'hostkey') {
      const { kind, fingerprint, keyType, known = [], host, port, name } = payload;
      const bad = kind === 'mismatch' || kind === 'revoked';
      const rememberBox = h('input', { type: 'checkbox', checked: kind === 'unknown' });

      const body = h('div', {},
        bad
          ? h('div', { class: 'alert bad' }, iconEl('warn', 16),
            h('div', {}, h('b', { text: kind === 'revoked' ? '这把主机密钥已被吊销。' : '主机密钥和 known_hosts 里记录的不一致。' }),
              h('div', { text: '可能是服务器重装或换了密钥，也可能是中间人攻击。确认无误再继续。' })))
          : h('div', { class: 'alert info' }, iconEl('info', 16),
            h('div', { text: '第一次连接这台服务器，请核对指纹后再信任它。' })),
        h('div', { class: 'field' },
          h('label', { text: '服务器' }),
          h('div', { class: 'fp-box', text: `${host}:${port}` })),
        h('div', { class: 'field' },
          h('label', { text: `本次收到的密钥（${keyType}）` }),
          h('div', { class: 'fp-box', text: fingerprint })),
        known.length
          ? h('div', { class: 'field' },
            h('label', { text: 'known_hosts 里已有的记录' }),
            h('div', { class: 'fp-box', text: known.join('\n') }))
          : null,
        h('label', { class: 'check' }, rememberBox, h('span', { text: '写入 ~/.ssh/known_hosts，以后不再询问' })));

      const v = await openSheet({
        title: bad ? '主机密钥已变更' : `信任 ${name || host}？`,
        body,
        wide: true,
        dismissable: false,
        actions: [
          { label: '断开', value: null },
          { label: bad ? '我确认，继续连接' : '信任并连接', kind: bad ? 'danger' : 'primary', collect: () => ({ accept: true, remember: rememberBox.checked }) },
        ],
      });
      return reply(v || { cancelled: true });
    }

    return reply({ cancelled: true });
  }

  Object.assign(F, { toast, openSheet, confirm, promptText, contextMenu, closeCtx, handlePrompt });

})();
