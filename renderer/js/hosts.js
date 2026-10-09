(function () {
  'use strict';
  /* global window, document */
  const F = window.F;
  const { h, clear, icon, iconEl, toast, confirm, openSheet, contextMenu } = F;

  // ---------- 侧栏 ----------
  function renderSidebar(app) {
    const list = clear(app.els.hostList);
    const q = app.hostQuery.trim().toLowerCase();
    const hosts = app.hosts.filter((x) => !q
      || x.name.toLowerCase().includes(q)
      || x.host.toLowerCase().includes(q)
      || (x.username || '').toLowerCase().includes(q));

    if (!app.hosts.length) {
      list.append(h('div', { class: 'sb-empty' },
        iconEl('server', 26, ''),
        h('div', { style: { marginTop: '10px' }, text: '还没有添加服务器' }),
        h('button', { class: 'btn primary', style: { marginTop: '14px' }, html: `${icon('plus', 14)}<span>添加主机</span>`, onclick: () => app.newHost() }),
        h('button', {
          class: 'btn ghost',
          style: { marginTop: '6px' },
          html: `${icon('import', 14)}<span>从 ~/.ssh/config 导入</span>`,
          onclick: () => app.importHosts(),
        })));
      return;
    }
    if (!hosts.length) {
      list.append(h('div', { class: 'sb-empty', text: '没有匹配的主机' }));
      return;
    }

    const connected = hosts.filter((x) => app.statusOf(x.id).state === 'ready');
    const others = hosts.filter((x) => app.statusOf(x.id).state !== 'ready');

    const push = (title, arr) => {
      if (!arr.length) return;
      if (connected.length && others.length) list.append(h('div', { class: 'sb-group', text: title }));
      for (const host of arr) list.append(hostRow(app, host));
    };
    push('已连接', connected);
    push('全部主机', others);
  }

  function hostRow(app, host) {
    const st = app.statusOf(host.id);
    const isCurrent = app.currentHostId === host.id;
    const idx = app.hosts.indexOf(host);

    const row = h('div', {
      class: `host${isCurrent ? ' sel' : ''}`,
      dataset: { id: host.id, state: st.state },
      draggable: 'true',
      title: st.error ? `${host.username}@${host.host}:${host.port}\n${st.error}` : `${host.username}@${host.host}:${host.port}`,
      onclick: () => app.selectHost(host.id),
      oncontextmenu: (e) => { e.preventDefault(); hostMenu(app, host, e.clientX, e.clientY); },
    },
    h('span', { class: 'host-dot', style: { '--dot': host.color } }),
    h('div', { class: 'host-text' },
      h('div', { class: 'host-name truncate', text: host.name }),
      h('div', { class: 'host-sub truncate', text: st.state === 'connecting' ? '连接中…' : st.state === 'error' ? st.error : `${host.username}@${host.host}` })),
    idx < 9 && !app.hostQuery ? h('span', { class: 'host-kbd', text: `⌘${idx + 1}` }) : null,
    h('button', {
      class: 'host-act',
      title: st.state === 'ready' ? '断开' : '连接',
      html: icon(st.state === 'ready' ? 'power' : 'bolt', 13),
      onclick: (e) => { e.stopPropagation(); app.toggleConnection(host.id); },
    }));

    // 侧栏拖拽排序 + 把文件拖到主机上直接上传
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-ferry-host', host.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes('application/x-ferry-host') || types.includes('application/x-ferry') || types.includes('Files')) {
        e.preventDefault();
        row.classList.add('drag-over');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const moving = e.dataTransfer.getData('application/x-ferry-host');
      if (moving && moving !== host.id) {
        const ids = app.hosts.map((x) => x.id).filter((x) => x !== moving);
        ids.splice(app.hosts.findIndex((x) => x.id === host.id), 0, moving);
        app.hosts = await window.ferry.hosts.reorder(ids);
        renderSidebar(app);
        return;
      }
      const payload = e.dataTransfer.getData('application/x-ferry');
      const files = [...(e.dataTransfer.files || [])];
      let sources = null;
      if (payload) {
        const p = JSON.parse(payload);
        if (p.side !== 'local') return;
        sources = p.items;
      } else if (files.length) {
        const paths = files.map((f) => window.ferry.pathForFile(f)).filter(Boolean);
        sources = await Promise.all(paths.map(async (pp) => ({
          path: pp, name: F.posix.basename(pp), kind: (await window.ferry.local.stat(pp))?.isDir ? 'dir' : 'file',
        })));
      }
      if (!sources || !sources.length) return;
      await app.selectHost(host.id);
      if (app.remote.path) app.startTransfer({ direction: 'upload', hostId: host.id, sources, destDir: app.remote.path });
    });

    return row;
  }

  function hostMenu(app, host, x, y) {
    const st = app.statusOf(host.id);
    contextMenu(x, y, [
      { label: st.state === 'ready' ? '断开连接' : '连接', icon: st.state === 'ready' ? 'power' : 'bolt', action: () => app.toggleConnection(host.id) },
      'sep',
      { label: '编辑…', icon: 'pencil', shortcut: '⌘E', action: () => app.editHost(host) },
      { label: '复制一份', icon: 'doc', action: () => app.duplicateHost(host) },
      { label: '清除已保存的密码', icon: 'key', disabled: !host.savePassword && !host.savePassphrase, action: () => app.forgetSecrets(host) },
      'sep',
      { label: '删除主机', icon: 'trash', action: () => app.deleteHost(host) },
    ]);
  }

  // ---------- 主机编辑器 ----------
  const BLANK = {
    name: '', host: '', port: 22, username: '', auth: 'key', privateKeyPath: '',
    remotePath: '', localPath: '', color: '#3b82f6', note: '',
  };

  async function hostEditor(app, existing) {
    const host = { ...BLANK, ...(existing || {}) };
    const defaultKeys = await window.ferry.hosts.defaultKeys().catch(() => []);
    if (!host.privateKeyPath && defaultKeys.length) host.privateKeyPath = defaultKeys[0];

    const nameIn = h('input', { class: 'inp', value: host.name, placeholder: '例如：生产环境 Web', autofocus: true });
    const hostIn = h('input', { class: 'inp', value: host.host, placeholder: 'example.com 或 10.0.0.5', spellcheck: 'false' });
    const portIn = h('input', { class: 'inp num', value: String(host.port), type: 'number', min: '1', max: '65535' });
    const userIn = h('input', { class: 'inp', value: host.username, placeholder: 'root', spellcheck: 'false' });
    const keyIn = h('input', { class: 'inp mono', value: host.privateKeyPath, placeholder: '~/.ssh/id_ed25519', spellcheck: 'false' });
    const remoteIn = h('input', { class: 'inp mono', value: host.remotePath, placeholder: '留空＝登录后的主目录', spellcheck: 'false' });
    const localIn = h('input', { class: 'inp mono', value: host.localPath, placeholder: '留空＝个人目录', spellcheck: 'false' });
    const noteIn = h('textarea', { class: 'inp', placeholder: '备注，可留空' });
    noteIn.value = host.note || '';

    // 认证方式切换
    let auth = host.auth;
    const keyField = h('div', { class: 'field' },
      h('label', { text: '私钥文件' }),
      h('div', { class: 'row2' },
        keyIn,
        h('button', { class: 'btn', style: { flex: '0 0 auto' }, text: '选择…', onclick: async () => {
          const p = await window.ferry.dialog.pickKey();
          if (p) keyIn.value = p;
        } })),
      defaultKeys.length > 1
        ? h('div', { class: 'hint' }, '检测到：', defaultKeys.map((k, i) => h('button', {
          class: 'btn ghost',
          style: { height: '20px', fontSize: '11px', padding: '0 6px' },
          text: F.posix.basename(k),
          onclick: () => { keyIn.value = k; },
        })))
        : h('div', { class: 'hint', text: '支持 OpenSSH / PEM 格式；加密私钥会在连接时问一次口令，可存进钥匙串。' }));

    const agentField = h('div', { class: 'alert info', hidden: true }, iconEl('key', 15),
      h('div', {}, '使用本机 ssh-agent 里已加载的身份。适合用 ', h('span', { class: 'mono', text: 'ssh-add' }), ' 管理密钥的情况。'));
    const pwField = h('div', { class: 'alert warn', hidden: true }, iconEl('lock', 15),
      h('div', {}, '密码会存进 macOS 登录钥匙串（不落明文到配置文件）。可能的话还是更建议用密钥。'));

    const segBtns = [
      ['key', '密钥文件', 'key'],
      ['agent', 'ssh-agent', 'bolt'],
      ['password', '密码', 'lock'],
    ].map(([val, text, ic]) => h('button', {
      class: auth === val ? 'on' : '',
      html: `${icon(ic, 13)}<span>${text}</span>`,
      onclick: (e) => {
        auth = val;
        for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget);
        keyField.hidden = val !== 'key';
        agentField.hidden = val !== 'agent';
        pwField.hidden = val !== 'password';
      },
    }));
    const seg = h('div', { class: 'seg' }, segBtns);
    keyField.hidden = auth !== 'key';
    agentField.hidden = auth !== 'agent';
    pwField.hidden = auth !== 'password';

    // 颜色
    let color = host.color;
    const swatches = h('div', { class: 'swatches' }, app.palette.map((c) => h('button', {
      class: `swatch${c === color ? ' on' : ''}`,
      style: { background: c },
      onclick: (e) => {
        color = c;
        for (const s of e.currentTarget.parentElement.children) s.classList.toggle('on', s === e.currentTarget);
      },
    })));

    const body = h('div', {},
      h('div', { class: 'field' }, h('label', { text: '显示名称' }), nameIn),
      h('div', { class: 'row2' },
        h('div', { class: 'field', style: { flex: '1' } }, h('label', { text: '主机地址' }), hostIn),
        h('div', { class: 'field narrow' }, h('label', { text: '端口' }), portIn)),
      h('div', { class: 'field' }, h('label', { text: '用户名' }), userIn),
      h('div', { class: 'field' }, h('label', { text: '登录方式' }), seg),
      keyField, agentField, pwField,
      h('div', { class: 'field' }, h('label', { text: '默认远端目录' }), remoteIn),
      h('div', { class: 'field' },
        h('label', { text: '默认本地目录' }),
        h('div', { class: 'row2' }, localIn,
          h('button', { class: 'btn', style: { flex: '0 0 auto' }, text: '选择…', onclick: async () => {
            const p = await window.ferry.dialog.pickDir(localIn.value);
            if (p) localIn.value = p;
          } }))),
      h('div', { class: 'field' }, h('label', { text: '标识颜色' }), swatches),
      h('div', { class: 'field' }, h('label', { text: '备注' }), noteIn));

    const collect = () => ({
      ...host,
      name: nameIn.value.trim() || hostIn.value.trim(),
      host: hostIn.value.trim(),
      port: Number(portIn.value) || 22,
      username: userIn.value.trim(),
      auth,
      privateKeyPath: auth === 'key' ? keyIn.value.trim() : host.privateKeyPath,
      remotePath: remoteIn.value.trim(),
      localPath: localIn.value.trim(),
      color,
      note: noteIn.value.trim(),
    });

    const result = await openSheet({
      title: existing ? `编辑「${host.name}」` : '添加主机',
      wide: true,
      body,
      actions: [
        { label: '取消', value: null },
        {
          label: existing ? '保存' : '添加',
          kind: 'primary',
          validate: () => {
            if (!hostIn.value.trim()) return '请填写主机地址';
            if (!userIn.value.trim()) return '请填写用户名';
            if (auth === 'key' && !keyIn.value.trim()) return '请选择私钥文件';
            return null;
          },
          collect,
        },
      ],
    });
    if (!result) return null;
    return window.ferry.hosts.save(result);
  }

  // ---------- 从 ~/.ssh/config 导入 ----------
  async function importSheet(app) {
    let entries = [];
    try {
      entries = await window.ferry.hosts.sshConfig();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    const known = new Set(app.hosts.map((x) => `${x.host}:${x.port}:${x.username}`));
    if (!entries.length) {
      await openSheet({
        title: '没有可导入的主机',
        desc: '~/.ssh/config 里没找到具名的 Host 条目（带 * 的通配条目会被跳过）。',
        actions: [{ label: '好', value: true, kind: 'primary' }],
      });
      return;
    }

    const boxes = new Map();
    const rows = entries.map((e) => {
      const dup = known.has(`${e.host}:${e.port}:${e.username}`);
      const cb = h('input', { type: 'checkbox', checked: !dup, disabled: dup });
      boxes.set(e, cb);
      return h('label', { class: 'list-row' }, cb,
        h('div', { style: { minWidth: '0', flex: '1' } },
          h('div', { class: 'truncate', text: e.alias }),
          h('div', { class: 'q-sub truncate', text: `${e.username || '（未指定用户）'}@${e.host}:${e.port}${e.identityFile ? ` · ${F.posix.basename(e.identityFile)}` : ''}` })),
        dup ? h('span', { class: 'q-sub', text: '已存在' }) : null,
        e.proxyJump ? h('span', { class: 'q-sub', title: `ProxyJump ${e.proxyJump}`, text: '跳板' }) : null);
    });

    const all = h('button', { class: 'btn ghost', text: '全选 / 全不选', onclick: () => {
      const target = [...boxes.values()].some((c) => !c.checked && !c.disabled);
      for (const c of boxes.values()) if (!c.disabled) c.checked = target;
    } });

    const picked = await openSheet({
      title: '从 ~/.ssh/config 导入',
      desc: '勾选要加入 Ferry 的主机。未指定用户名的条目导入后需要补一下。',
      wide: true,
      body: h('div', {}, h('div', { style: { marginBottom: '8px' } }, all), h('div', { class: 'list-box' }, rows)),
      actions: [
        { label: '取消', value: null },
        { label: '导入', kind: 'primary', collect: () => entries.filter((e) => boxes.get(e).checked) },
      ],
    });
    if (!picked || !picked.length) return;

    let n = 0;
    for (const e of picked) {
      await window.ferry.hosts.save({
        name: e.alias,
        host: e.host,
        port: e.port,
        username: e.username || '',
        auth: e.identityFile ? 'key' : 'agent',
        privateKeyPath: e.identityFile || '',
        color: app.palette[n % app.palette.length],
        note: e.proxyJump ? `~/.ssh/config 中配置了 ProxyJump ${e.proxyJump}（Ferry 暂不支持跳板，请直连或用隧道）` : '',
      });
      n += 1;
    }
    await app.reloadHosts();
    toast(`已导入 ${n} 台主机`, 'ok');
  }

  Object.assign(F, { renderSidebar, hostEditor, importSheet });

})();
