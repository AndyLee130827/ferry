(function () {
  'use strict';
  /* global window, document */
  const F = window.F;
  const { h, clear, icon, iconEl, bytes, toast, confirm, openSheet, contextMenu, closeCtx } = F;

  class App {
    constructor() {
      this.hosts = [];
      this.palette = [];
      this.statuses = {};
      this.settings = { showHidden: false, concurrency: 3, preserveMtime: true, confirmDelete: true, theme: 'system' };
      this.meta = null;
      this.currentHostId = null;
      this.hostQuery = '';
      this.queueOpen = false;
      this.focused = null;
      this.wasBusy = false;

      this.els = {
        hostList: document.getElementById('hostList'),
        hostSearch: document.getElementById('hostSearch'),
        sidebarFoot: document.getElementById('sidebarFoot'),
        topbar: document.getElementById('topbar'),
        gutter: document.getElementById('gutter'),
        queueMount: document.getElementById('queueMount'),
      };

      this.local = new F.Pane({ side: 'local', el: document.getElementById('paneLocal'), app: this });
      this.remote = new F.Pane({ side: 'remote', el: document.getElementById('paneRemote'), app: this });
      this.queue = new F.Queue(this);
      this.els.queueMount.replaceWith(this.queue.el);

      this.buildChrome();
      this.wire();
      this.boot();
    }

    // ---------- 骨架 ----------
    buildChrome() {
      this.els.sidebarFoot.append(
        h('button', { class: 'btn ghost', title: '添加主机 (⌘N)', html: `${icon('plus', 14)}<span>主机</span>`, onclick: () => this.newHost() }),
        h('button', { class: 'btn icon ghost', title: '从 ~/.ssh/config 导入 (⇧⌘I)', html: icon('import', 14), onclick: () => this.importHosts() }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn icon ghost', title: '设置 (⌘,)', html: icon('gear', 14), onclick: () => this.openSettings() }));

      this.connChip = h('div', { class: 'conn-chip' });
      this.topActions = h('div', { style: { display: 'flex', gap: '6px' } });
      this.queueToggle = h('button', {
        class: 'btn',
        title: '传输面板 (⌘T)',
        onclick: () => this.toggleQueue(),
      });
      this.els.topbar.append(this.connChip, h('span', { class: 'spacer' }), this.topActions, this.queueToggle);

      this.upBtn = h('button', { class: 'xfer-btn', title: '上传到服务器 (⌘→)', html: icon('arrowR', 17), onclick: () => this.transferSelection('upload') });
      this.downBtn = h('button', { class: 'xfer-btn', title: '下载到本机 (⌘←)', html: icon('arrowL', 17), onclick: () => this.transferSelection('download') });
      this.els.gutter.append(this.upBtn, this.downBtn);

      this.renderTopbar();
      this.renderQueueToggle(null);
    }

    wire() {
      this.els.hostSearch.addEventListener('input', (e) => {
        this.hostQuery = e.target.value;
        F.renderSidebar(this);
      });
      this.els.hostSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.els.hostSearch.value = ''; this.hostQuery = ''; F.renderSidebar(this); this.els.hostSearch.blur(); }
        if (e.key === 'Enter') {
          const first = this.els.hostList.querySelector('.host');
          if (first) { this.selectHost(first.dataset.id); this.els.hostSearch.blur(); }
        }
      });

      window.ferry.on('prompt:request', (req) => F.handlePrompt(req));
      window.ferry.on('ssh:status', (s) => this.onStatus(s));
      window.ferry.on('transfer:snapshot', (snap) => this.onSnapshot(snap));
      window.ferry.on('transfer:progress', (p) => this.queue.applyProgress(p));
      window.ferry.on('menu', (action) => this.onMenu(action));
      window.ferry.on('theme', () => this.applyTheme());

      document.addEventListener('keydown', (e) => this.onGlobalKey(e));
      document.addEventListener('dragover', (e) => e.preventDefault());
      document.addEventListener('drop', (e) => e.preventDefault());
      window.addEventListener('blur', () => closeCtx());
    }

    async boot() {
      this.meta = await window.ferry.app.meta().catch(() => null);
      this.settings = { theme: 'system', ...(await window.ferry.settings.get()) };
      this.applyTheme();
      await this.reloadHosts();
      await this.local.navigate(this.settings.lastLocalPath || '~', { replace: true });
      this.setFocusedPane(this.local);
      this.queue.setSnapshot(await window.ferry.transfers.snapshot());

      const last = this.settings.lastHostId;
      if (last && this.hosts.some((x) => x.id === last)) this.selectHost(last, { connect: false });
      else this.renderTopbar();
    }

    async reloadHosts() {
      const r = await window.ferry.hosts.list();
      this.hosts = r.hosts;
      this.palette = r.palette;
      this.statuses = r.statuses;
      F.renderSidebar(this);
      this.renderTopbar();
    }

    statusOf(id) {
      return this.statuses[id] || { state: 'offline', error: null };
    }

    applyTheme() {
      document.documentElement.dataset.theme = this.settings.theme || 'system';
    }

    // ---------- 主机 ----------
    async selectHost(id, { connect = true } = {}) {
      const host = this.hosts.find((x) => x.id === id);
      if (!host) return;
      const changed = this.currentHostId !== id;
      this.currentHostId = id;
      F.renderSidebar(this);
      this.renderTopbar();

      if (changed) {
        this.remote.hostId = id;
        if (host.localPath) this.local.navigate(host.localPath, { replace: true });
      }
      const st = this.statusOf(id).state;
      if (st === 'ready') {
        if (changed || !this.remote.path) await this.remote.attachHost(id, host.remotePath || '~');
        return;
      }
      if (connect) await this.connect(id);
      else this.remote.render();
    }

    async connect(id) {
      const host = this.hosts.find((x) => x.id === id);
      if (!host) return;
      this.statuses[id] = { state: 'connecting' };
      F.renderSidebar(this);
      this.renderTopbar();
      try {
        await window.ferry.ssh.connect(id);
        if (this.currentHostId === id) await this.remote.attachHost(id, host.remotePath || '~');
      } catch (err) {
        this.statuses[id] = { state: 'error', error: err.message };
        F.renderSidebar(this);
        this.renderTopbar();
        if (this.currentHostId === id) { this.remote.error = err.message; this.remote.render(); }
        toast(`${host.name}：${err.message}`, 'error', 5000);
      }
    }

    async toggleConnection(id) {
      if (this.statusOf(id).state === 'ready') {
        await window.ferry.ssh.disconnect(id);
        if (this.currentHostId === id) await this.remote.detach();
        this.remote.hostId = this.currentHostId === id ? id : this.remote.hostId;
      } else {
        await this.selectHost(id);
        if (this.statusOf(id).state !== 'ready') await this.connect(id);
      }
    }

    onStatus(s) {
      this.statuses[s.hostId] = { state: s.state, error: s.error, info: s.info };
      F.renderSidebar(this);
      this.renderTopbar();
      if (s.hostId === this.currentHostId && s.state === 'offline' && this.remote.path) {
        this.remote.path = null;
        this.remote.entries = [];
        this.remote.error = '连接已断开';
        this.remote.render();
      }
    }

    async newHost() {
      const saved = await F.hostEditor(this, null);
      if (!saved) return;
      await this.reloadHosts();
      await this.selectHost(saved.id);
    }

    async editHost(host) {
      const target = host || this.hosts.find((x) => x.id === this.currentHostId);
      if (!target) return toast('先选一台主机', 'info');
      const saved = await F.hostEditor(this, target);
      if (!saved) return;
      await this.reloadHosts();
      if (this.statusOf(saved.id).state === 'ready') toast('已保存。改动在下次重连后生效。', 'ok');
    }

    async duplicateHost(host) {
      const copy = { ...host, id: undefined, name: `${host.name} 副本`, savePassword: false, savePassphrase: false };
      delete copy.id;
      const saved = await window.ferry.hosts.save(copy);
      await this.reloadHosts();
      await this.editHost(saved);
    }

    async deleteHost(host) {
      const ok = await confirm({
        title: `删除「${host.name}」？`,
        desc: '只会从 Ferry 里移除这条记录，并清掉钥匙串里保存的密码。服务器上的文件不受影响。',
        ok: '删除',
        danger: true,
      });
      if (!ok) return;
      await window.ferry.hosts.remove(host.id);
      if (this.currentHostId === host.id) {
        this.currentHostId = null;
        await this.remote.detach();
      }
      await this.reloadHosts();
      toast('已删除', 'ok', 2000);
    }

    async forgetSecrets(host) {
      await window.ferry.hosts.forgetSecrets(host.id);
      await this.reloadHosts();
      toast('已清除钥匙串里保存的凭据', 'ok');
    }

    importHosts() {
      return F.importSheet(this);
    }

    // ---------- 面板协作 ----------
    setFocusedPane(pane) {
      if (this.focused === pane) return;
      this.focused = pane;
      this.local.el.classList.toggle('focused', pane === this.local);
      this.remote.el.classList.toggle('focused', pane === this.remote);
      this.onSelectionChanged();
    }

    otherPane(pane) {
      return pane === this.local ? this.remote : this.local;
    }

    focusOther(pane) {
      this.otherPane(pane).el.focus();
    }

    onPaneNavigated(pane) {
      if (pane === this.local) window.ferry.settings.set({ lastLocalPath: pane.path }).catch(() => {});
      this.onSelectionChanged();
    }

    onSelectionChanged() {
      const canUp = !!(this.local.selectedEntries().length && this.remote.path && this.statusOf(this.currentHostId).state === 'ready');
      const canDown = !!(this.remote.selectedEntries().length && this.local.path);
      this.upBtn.disabled = !canUp;
      this.downBtn.disabled = !canDown;
      this.local.renderFoot();
      this.remote.renderFoot();
    }

    toggleHidden() {
      this.settings.showHidden = !this.settings.showHidden;
      window.ferry.settings.set({ showHidden: this.settings.showHidden });
      this.local.renderList();
      this.remote.renderList();
      toast(this.settings.showHidden ? '显示隐藏文件' : '隐藏“点文件”', 'info', 1600);
    }

    // ---------- 传输 ----------
    async transferSelection(direction) {
      const from = direction === 'upload' ? this.local : this.remote;
      const to = direction === 'upload' ? this.remote : this.local;
      const sources = from.selectedEntries();
      if (!sources.length) return toast(`请先在${from.label}一侧选中文件`, 'info');
      if (!to.path) return toast(direction === 'upload' ? '请先连接服务器' : '本地目录未就绪', 'info');
      return this.startTransfer({
        direction,
        hostId: this.currentHostId,
        sources: sources.map((e) => ({ path: e.path, name: e.name, kind: e.kind, linkTo: e.linkTo, size: e.size })),
        destDir: to.path,
      });
    }

    transferFrom(payload, destPane, destDir) {
      const direction = payload.side === 'local' ? 'upload' : 'download';
      const hostId = direction === 'upload' ? destPane.hostId || this.currentHostId : payload.hostId;
      if (!hostId) return toast('请先连接服务器', 'info');
      return this.startTransfer({ direction, hostId, sources: payload.items, destDir: destDir || destPane.path });
    }

    async startTransfer({ direction, hostId, sources, destDir }) {
      if (!hostId) return toast('请先连接服务器', 'info');
      if (!destDir) return toast('目标目录未就绪', 'info');
      const busy = toast('正在清点文件…', 'info', 60000);
      let plan;
      try {
        plan = await window.ferry.transfers.plan({ hostId, direction, sources, destDir });
      } catch (err) {
        busy.remove();
        return toast(err.message, 'error', 5000);
      }
      busy.remove();

      if (!plan.fileCount) {
        if (plan.dirCount) {
          await window.ferry.transfers.start(plan.planId, { conflict: 'overwrite' });
          this.refreshAfterTransfer();
          return toast('已创建空目录结构', 'ok');
        }
        return toast('没有可传输的文件', 'info');
      }

      const decision = await F.confirmPlan(plan);
      if (!decision.go) return;
      try {
        await window.ferry.transfers.start(plan.planId, { conflict: decision.conflict });
        this.toggleQueue(true);
      } catch (err) {
        toast(err.message, 'error', 5000);
      }
    }

    onSnapshot(snap) {
      this.queue.setSnapshot(snap);
      const busy = snap.stats.running + snap.stats.queued > 0;
      if (this.wasBusy && !busy) {
        this.refreshAfterTransfer();
        if (snap.stats.failed) toast(`传输结束，有 ${snap.stats.failed} 个失败`, 'error', 5000);
        else if (snap.stats.finished) toast('传输完成', 'ok');
      }
      this.wasBusy = busy;
    }

    refreshAfterTransfer() {
      if (this.local.path) this.local.refresh();
      if (this.remote.path) this.remote.refresh();
    }

    onQueueStats(s) {
      this.renderQueueToggle(s);
    }

    toggleQueue(force) {
      this.queueOpen = force === undefined ? !this.queueOpen : force;
      this.queue.el.classList.toggle('open', this.queueOpen);
    }

    renderQueueToggle(s) {
      const busy = s && s.running + s.queued > 0;
      this.queueToggle.innerHTML = busy
        ? `${icon('bolt', 14)}<span>${s.running + s.queued} 个传输 · ${F.speed(s.speed)}</span>`
        : `${icon('bolt', 14)}<span>传输</span>`;
      this.queueToggle.classList.toggle('primary', !!busy);
    }

    // ---------- 顶栏 ----------
    renderTopbar() {
      const chip = clear(this.connChip);
      const acts = clear(this.topActions);
      const host = this.hosts.find((x) => x.id === this.currentHostId);

      if (!host) {
        chip.append(iconEl('server', 14), h('span', { class: 'conn-sub', text: this.hosts.length ? '未选择主机' : '先添加一台服务器' }));
        acts.append(h('button', { class: 'btn primary', html: `${icon('plus', 14)}<span>添加主机</span>`, onclick: () => this.newHost() }));
        return;
      }

      const st = this.statusOf(host.id);
      const label = { ready: '已连接', connecting: '连接中…', error: st.error || '连接失败', offline: '未连接' }[st.state];
      chip.dataset.state = st.state;
      chip.append(
        h('span', { class: 'host-dot', style: { '--dot': host.color } }),
        h('div', { style: { minWidth: '0' } },
          h('div', { class: 'conn-title truncate', text: host.name }),
          h('div', { class: 'conn-sub truncate', text: `${host.username}@${host.host}:${host.port} · ${label}` })));
      const dot = chip.querySelector('.host-dot');
      if (st.state === 'ready') dot.style.background = 'var(--green)';
      else if (st.state === 'connecting') dot.style.background = 'var(--amber)';
      else if (st.state === 'error') dot.style.background = 'var(--red)';

      if (st.state === 'ready') {
        acts.append(
          h('button', { class: 'btn', title: '服务器信息', html: `${icon('terminal', 14)}<span>信息</span>`, onclick: () => this.showServerInfo(host) }),
          h('button', { class: 'btn', title: '断开 (⇧⌘C)', html: `${icon('power', 14)}<span>断开</span>`, onclick: () => this.toggleConnection(host.id) }));
      } else {
        acts.append(h('button', {
          class: 'btn primary',
          disabled: st.state === 'connecting',
          html: st.state === 'connecting' ? `${icon('refresh', 14, 'spin')}<span>连接中</span>` : `${icon('bolt', 14)}<span>连接</span>`,
          onclick: () => this.connect(host.id),
        }));
      }
      acts.append(h('button', { class: 'btn icon', title: '编辑主机 (⌘E)', html: icon('pencil', 14), onclick: () => this.editHost(host) }));
    }

    async showServerInfo(host) {
      let text = '读取中…';
      try {
        text = await window.ferry.ssh.info(host.id, this.remote.path || '.');
      } catch (err) {
        text = `无法执行远端命令：${err.message}`;
      }
      const [uname = '', df = '', up = ''] = text.split('---').map((s) => s.trim());
      await openSheet({
        title: host.name,
        desc: `${host.username}@${host.host}:${host.port}`,
        wide: true,
        body: h('div', {},
          h('div', { class: 'field' }, h('label', { text: '系统' }), h('div', { class: 'fp-box', text: uname || '—' })),
          h('div', { class: 'field' }, h('label', { text: `磁盘（${this.remote.path || '.'}）` }), h('div', { class: 'fp-box', text: df || '—' })),
          h('div', { class: 'field' }, h('label', { text: '负载' }), h('div', { class: 'fp-box', text: up || '—' })),
          host.note ? h('div', { class: 'field' }, h('label', { text: '备注' }), h('div', { class: 'fp-box', text: host.note })) : null),
        actions: [{ label: '关闭', value: true, kind: 'primary' }],
      });
    }

    // ---------- 设置 / 关于 ----------
    async openSettings() {
      const s = this.settings;
      const conc = h('input', { type: 'range', min: '1', max: '8', step: '1', value: String(s.concurrency), style: { flex: '1' } });
      const concVal = h('span', { class: 'num', style: { width: '18px', textAlign: 'right' }, text: String(s.concurrency) });
      conc.addEventListener('input', () => { concVal.textContent = conc.value; });

      const hidden = h('input', { type: 'checkbox', checked: !!s.showHidden });
      const mtime = h('input', { type: 'checkbox', checked: !!s.preserveMtime });
      const confirmDel = h('input', { type: 'checkbox', checked: !!s.confirmDelete });

      let theme = s.theme || 'system';
      const themeSeg = h('div', { class: 'seg' }, [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) => h('button', {
        class: theme === v ? 'on' : '',
        text: t,
        onclick: (e) => {
          theme = v;
          for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget);
          document.documentElement.dataset.theme = v;
        },
      })));

      const body = h('div', {},
        h('div', { class: 'field' },
          h('label', { text: '同时传输的文件数' }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, conc, concVal),
          h('div', { class: 'hint', text: '每个并发任务独占一条 SFTP 通道。高延迟链路上 3–5 通常最快。' })),
        h('div', { class: 'field' }, h('label', { text: '外观' }), themeSeg),
        h('div', { class: 'field' },
          h('label', { text: '行为' }),
          h('label', { class: 'check' }, hidden, h('span', { text: '显示隐藏文件（以 . 开头）' })),
          h('label', { class: 'check' }, mtime, h('span', { text: '传输后保留原文件的修改时间' })),
          h('label', { class: 'check' }, confirmDel, h('span', { text: '删除本地文件前先确认（服务器端始终确认）' }))),
        this.meta ? h('div', { class: 'field' },
          h('label', { text: '路径' }),
          h('div', { class: 'list-box' },
            [['主机配置', this.meta.userData], ['known_hosts', this.meta.knownHostsFile], ['ssh config', this.meta.sshConfigFile]]
              .map(([k, v]) => h('div', { class: 'list-row' },
                h('span', { style: { width: '92px', color: 'var(--text-2)', flex: 'none' }, text: k }),
                h('span', { class: 'mono truncate', style: { userSelect: 'text' }, title: v, text: v }))))) : null);

      const r = await openSheet({
        title: '设置',
        wide: true,
        body,
        actions: [
          { label: '取消', value: null },
          { label: '完成', kind: 'primary', collect: () => ({
            concurrency: Number(conc.value),
            showHidden: hidden.checked,
            preserveMtime: mtime.checked,
            confirmDelete: confirmDel.checked,
            theme,
          }) },
        ],
      });
      if (!r) { this.applyTheme(); return; }
      this.settings = { ...this.settings, ...(await window.ferry.settings.set(r)), theme: r.theme };
      this.applyTheme();
      this.local.renderList();
      this.remote.renderList();
    }

    async showAbout() {
      const m = this.meta || {};
      await openSheet({
        title: 'Ferry',
        desc: '在 Mac 和你的服务器之间搬文件，走 SSH/SFTP。',
        body: h('div', {},
          h('div', { class: 'list-box' },
            [['版本', m.version], ['Electron', m.electron], ['Node', m.node], ['ssh-agent', m.hasAgent ? '可用' : '未检测到']]
              .map(([k, v]) => h('div', { class: 'list-row' },
                h('span', { style: { width: '80px', color: 'var(--text-2)', flex: 'none' }, text: k }),
                h('span', { class: 'mono', text: String(v || '—') })))),
          h('div', { class: 'field', style: { marginTop: '14px' } },
            h('label', { text: '快捷键' }),
            h('div', { class: 'list-box' }, [
              ['⌘N', '添加主机'], ['⌘K', '快速切换主机'], ['⌘1…9', '切到第 N 台主机'],
              ['⌘→ / ⌘←', '上传 / 下载选中项'], ['⌘T', '传输面板'], ['⌘P', '暂停 / 继续队列'],
              ['Tab', '切换左右面板'], ['↩', '重命名'], ['⌘↓', '打开'], ['空格', '显示简介'],
              ['⌘↑', '上一级'], ['⌘[', '后退'], ['⌘F', '过滤当前目录'], ['⇧⌘.', '显示隐藏文件'],
              ['⌘R', '刷新'], ['⌘⌫', '删除'],
            ].map(([k, v]) => h('div', { class: 'list-row' },
              h('span', { class: 'mono', style: { width: '80px', flex: 'none' }, text: k }),
              h('span', { text: v })))))),
        wide: true,
        actions: [
          { label: '打开配置目录', value: 'reveal' },
          { label: '关闭', value: true, kind: 'primary' },
        ],
      }).then((v) => { if (v === 'reveal') window.ferry.app.revealUserData(); });
    }

    // ---------- 快速切换 ----------
    openPalette() {
      if (!this.hosts.length) return this.newHost();
      let items = this.hosts.slice();
      let active = 0;

      const input = h('input', { placeholder: '搜索主机，回车连接…', spellcheck: 'false' });
      const list = h('div', { class: 'palette-list' });
      const box = h('div', { class: 'palette' }, input, list);
      const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim) close(); } }, box);

      const close = () => {
        scrim.remove();
        document.removeEventListener('keydown', onKey, true);
      };
      const paint = () => {
        clear(list);
        if (!items.length) { list.append(h('div', { class: 'pane-empty', text: '没有匹配的主机' })); return; }
        items.forEach((host, i) => {
          const st = this.statusOf(host.id);
          list.append(h('div', {
            class: `p-item${i === active ? ' on' : ''}`,
            onmouseenter: () => { active = i; paint(); },
            onclick: () => { close(); this.selectHost(host.id); },
          },
          h('span', { class: 'host-dot', dataset: { state: st.state }, style: { '--dot': host.color } }),
          h('span', { class: 'truncate', text: host.name }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'p-sub truncate', text: `${host.username}@${host.host}` })));
        });
      };
      const refilter = () => {
        const q = input.value.trim().toLowerCase();
        items = this.hosts.filter((x) => !q || `${x.name} ${x.host} ${x.username}`.toLowerCase().includes(q));
        active = 0;
        paint();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); return paint(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); return paint(); }
        if (e.key === 'Enter') {
          e.preventDefault();
          const host = items[active];
          close();
          if (host) this.selectHost(host.id);
        }
      };

      input.addEventListener('input', refilter);
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);
      paint();
      setTimeout(() => input.focus(), 20);
    }

    // ---------- 菜单 / 快捷键 ----------
    onMenu(action) {
      const pane = this.focused || this.local;
      const map = {
        about: () => this.showAbout(),
        settings: () => this.openSettings(),
        palette: () => this.openPalette(),
        'host:new': () => this.newHost(),
        'host:edit': () => this.editHost(),
        'host:import': () => this.importHosts(),
        'host:toggle': () => this.currentHostId && this.toggleConnection(this.currentHostId),
        'file:newFolder': () => pane.newFolder(),
        'file:rename': () => { const s = pane.selectedEntries(); if (s.length === 1) pane.beginRename(s[0]); },
        'file:delete': () => pane.deleteSelected(),
        'file:refresh': () => { this.local.refresh(); if (this.remote.path) this.remote.refresh(); },
        'file:up': () => pane.up(),
        'file:filter': () => pane.toggleFilter(true),
        'file:toggleHidden': () => this.toggleHidden(),
        'transfer:up': () => this.transferSelection('upload'),
        'transfer:down': () => this.transferSelection('download'),
        'queue:toggle': () => this.toggleQueue(),
        'queue:pause': () => this.queue.togglePause(),
        'queue:retry': () => window.ferry.transfers.retryFailed(),
        'queue:clear': () => window.ferry.transfers.clear(),
      };
      (map[action] || (() => {}))();
    }

    onGlobalKey(e) {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.scrim')) return;
      if (e.key >= '1' && e.key <= '9') {
        const host = this.hosts[Number(e.key) - 1];
        if (host) { e.preventDefault(); this.selectHost(host.id); }
        return;
      }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); this.openPalette(); }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
  });

})();
