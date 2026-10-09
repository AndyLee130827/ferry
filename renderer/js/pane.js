(function () {
  'use strict';
  /* global window, document */
  const F = window.F;
  const { h, clear, icon, iconEl, bytes, when, posix, toast, confirm, promptText, contextMenu } = F;

  const ICON_FOR = (e) => {
    if (e.kind === 'dir' || e.linkTo === 'dir') return 'folder';
    if (e.kind === 'link') return 'link';
    return 'file';
  };

  class Pane {
    constructor({ side, el, app }) {
      this.side = side; // 'local' | 'remote'
      this.el = el;
      this.app = app;
      this.hostId = null;
      this.path = null;
      this.parent = null;
      this.entries = [];
      this.selected = new Set();
      this.cursor = -1;
      this.sort = { key: 'name', dir: 1 };
      this.filter = '';
      this.loading = false;
      this.error = null;
      this.history = [];
      this.future = [];
      this.typeAhead = '';
      this.typeAheadAt = 0;
      this.build();
    }

    get isLocal() { return this.side === 'local'; }
    get label() { return this.isLocal ? '本机' : '服务器'; }

    // ---------- 骨架 ----------
    build() {
      this.el.className = `pane ${this.side}`;
      this.el.tabIndex = 0;

      this.crumbs = h('div', { class: 'crumbs', ondblclick: () => this.editPath() });
      this.head = h('div', { class: 'pane-head' },
        h('div', { class: 'pane-label' }, iconEl(this.isLocal ? 'home' : 'server', 13), this.label),
        h('button', { class: 'btn icon ghost', title: '后退', onclick: () => this.back(), html: icon('chevL', 15) }),
        h('button', { class: 'btn icon ghost', title: '上一级 (⌘↑)', onclick: () => this.up(), html: icon('chevU', 15) }),
        this.crumbs,
        h('button', { class: 'btn icon ghost', title: '新建文件夹 (⇧⌘N)', onclick: () => this.newFolder(), html: icon('folderPlus', 15) }),
        h('button', { class: 'btn icon ghost', title: '搜索 (⌘F)', onclick: () => this.toggleFilter(), html: icon('search', 15) }),
        h('button', { class: 'btn icon ghost', title: '刷新 (⌘R)', onclick: () => this.refresh(), html: icon('refresh', 15) }));

      this.filterInput = h('input', {
        placeholder: '按名称过滤…',
        oninput: (e) => { this.filter = e.target.value; this.renderList(); },
        onkeydown: (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); this.toggleFilter(false); }
          if (e.key === 'Enter') { e.preventDefault(); this.el.focus(); this.cursor = 0; this.selectOnly(0); }
        },
      });
      this.filterBar = h('div', { class: 'pane-filter', hidden: true },
        iconEl('search', 13), this.filterInput,
        h('button', { class: 'btn icon ghost', onclick: () => this.toggleFilter(false), html: icon('x', 13) }));

      const col = (key, text, right) => h('button', {
        class: right ? 'r' : '',
        onclick: () => this.setSort(key),
        dataset: { key },
      }, h('span', { text }), h('span', { class: 'arrow' }));
      this.cols = h('div', { class: 'cols' }, col('name', '名称'), col('size', '大小', true), col('mtime', '修改时间', true));

      this.list = h('div', { class: 'pane-body' });
      this.foot = h('div', { class: 'pane-foot' });

      this.el.append(this.head, this.filterBar, this.cols, this.list, this.foot);
      this.wireEvents();
      this.renderCols();
      this.render();
    }

    wireEvents() {
      this.el.addEventListener('focusin', () => this.app.setFocusedPane(this));
      this.el.addEventListener('mousedown', () => this.app.setFocusedPane(this), true);
      this.el.addEventListener('keydown', (e) => this.onKey(e));

      this.list.addEventListener('mousedown', (e) => {
        if (e.target === this.list) this.clearSelection();
      });
      this.list.addEventListener('contextmenu', (e) => {
        if (e.target === this.list) {
          e.preventDefault();
          this.bgContextMenu(e.clientX, e.clientY);
        }
      });

      // 从 Finder 或对面面板拖进来
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      this.list.addEventListener('dragover', (e) => {
        if (!this.canDrop(e)) return;
        stop(e);
        e.dataTransfer.dropEffect = 'copy';
        this.list.classList.add('drop');
      });
      this.list.addEventListener('dragleave', (e) => {
        if (e.target === this.list) this.list.classList.remove('drop');
      });
      this.list.addEventListener('drop', (e) => {
        this.list.classList.remove('drop');
        if (!this.canDrop(e)) return;
        stop(e);
        this.handleDrop(e, this.path);
      });
    }

    canDrop(e) {
      const types = [...(e.dataTransfer?.types || [])];
      if (types.includes('Files')) return true;
      if (types.includes('application/x-ferry')) return !!this.path;
      return false;
    }

    async handleDrop(e, destDir) {
      const raw = e.dataTransfer.getData('application/x-ferry');
      if (raw) {
        try {
          const payload = JSON.parse(raw);
          if (payload.side !== this.side) return this.app.transferFrom(payload, this, destDir);
          return; // 同一侧的拖动暂不处理（将来可以做服务器内移动）
        } catch { /* 数据坏了，忽略 */ }
      }
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      const paths = files.map((f) => window.ferry.pathForFile(f)).filter(Boolean);
      if (!paths.length) return toast('读不到拖入文件的路径', 'error');
      if (this.isLocal) return toast('本机目录内的复制请用 Finder', 'info');
      const sources = await Promise.all(paths.map(async (p) => ({
        path: p, name: posix.basename(p), kind: (await window.ferry.local.stat(p))?.isDir ? 'dir' : 'file',
      })));
      this.app.startTransfer({ direction: 'upload', hostId: this.hostId, sources, destDir: destDir || this.path });
    }

    // ---------- 数据 ----------
    get io() {
      if (this.isLocal) {
        const L = window.ferry.local;
        return {
          list: (p) => L.list(p),
          mkdir: (p) => L.mkdir(p),
          rename: (a, b) => L.rename(a, b),
          remove: (p) => L.trash(p),
          stat: (p) => L.stat(p),
        };
      }
      const S = window.ferry.ssh;
      const id = this.hostId;
      return {
        list: (p) => S.list(id, p),
        mkdir: (p) => S.mkdir(id, p),
        rename: (a, b) => S.rename(id, a, b),
        remove: (p) => S.remove(id, p),
        stat: (p) => S.stat ? S.stat(id, p) : null,
      };
    }

    async attachHost(hostId, startPath) {
      this.hostId = hostId;
      this.path = null;
      this.entries = [];
      this.history = [];
      this.error = null;
      if (!hostId) {
        this.render();
        return;
      }
      await this.navigate(startPath || '~', { replace: true });
    }

    async detach() {
      this.hostId = null;
      this.path = null;
      this.entries = [];
      this.selected.clear();
      this.error = null;
      this.render();
    }

    async navigate(target, { replace = false, keepSelection = null } = {}) {
      if (!this.isLocal && !this.hostId) return;
      this.loading = true;
      this.error = null;
      this.renderCrumbs();
      this.renderList();
      try {
        const res = await this.io.list(target);
        if (!replace && this.path && this.path !== res.path) {
          this.history.push(this.path);
          this.future = [];
        }
        this.path = res.path;
        this.parent = res.parent;
        this.entries = res.entries;
        this.selected = new Set(keepSelection || []);
        this.cursor = -1;
        this.filter = '';
        this.filterInput.value = '';
        this.filterBar.hidden = true;
        this.loading = false;
        this.render();
        this.app.onPaneNavigated(this);
      } catch (err) {
        this.loading = false;
        this.error = err.message || String(err);
        this.render();
        toast(`${this.label}：${this.error}`, 'error');
      }
    }

    refresh() {
      if (!this.path) return;
      return this.navigate(this.path, { replace: true, keepSelection: [...this.selected] });
    }

    up() {
      if (this.parent) this.navigate(this.parent);
    }

    back() {
      const prev = this.history.pop();
      if (!prev) return;
      this.future.push(this.path);
      this.navigate(prev, { replace: true });
    }

    // ---------- 排序 / 过滤 ----------
    setSort(key) {
      if (this.sort.key === key) this.sort.dir *= -1;
      else this.sort = { key, dir: key === 'name' ? 1 : -1 };
      this.renderCols();
      this.renderList();
    }

    visible() {
      const q = this.filter.trim().toLowerCase();
      const showHidden = this.app.settings.showHidden;
      let list = this.entries.filter((e) => {
        if (!showHidden && e.name.startsWith('.')) return false;
        if (q && !e.name.toLowerCase().includes(q)) return false;
        return true;
      });
      const { key, dir } = this.sort;
      const isDir = (e) => e.kind === 'dir' || e.linkTo === 'dir';
      list = list.sort((a, b) => {
        if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
        let r = 0;
        if (key === 'size') r = (a.size || 0) - (b.size || 0);
        else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
        else r = F.naturalCmp(a.name, b.name);
        return (r || F.naturalCmp(a.name, b.name)) * dir;
      });
      return list;
    }

    toggleFilter(force) {
      const show = force === undefined ? this.filterBar.hidden : force;
      this.filterBar.hidden = !show;
      if (show) this.filterInput.focus();
      else {
        this.filter = '';
        this.filterInput.value = '';
        this.renderList();
        this.el.focus();
      }
    }

    // ---------- 选择 ----------
    selectedEntries() {
      return this.entries.filter((e) => this.selected.has(e.name));
    }

    clearSelection() {
      this.selected.clear();
      this.cursor = -1;
      this.renderList();
      this.app.onSelectionChanged();
    }

    selectOnly(index) {
      const list = this.visible();
      const e = list[index];
      if (!e) return;
      this.selected = new Set([e.name]);
      this.cursor = index;
      this.renderList();
      this.scrollToCursor();
      this.app.onSelectionChanged();
    }

    extendTo(index) {
      const list = this.visible();
      const from = this.cursor < 0 ? index : this.cursor;
      const [a, b] = from <= index ? [from, index] : [index, from];
      this.selected = new Set(list.slice(a, b + 1).map((e) => e.name));
      this.cursor = index;
      this.renderList();
      this.scrollToCursor();
      this.app.onSelectionChanged();
    }

    toggleAt(index) {
      const list = this.visible();
      const e = list[index];
      if (!e) return;
      if (this.selected.has(e.name)) this.selected.delete(e.name);
      else this.selected.add(e.name);
      this.cursor = index;
      this.renderList();
      this.app.onSelectionChanged();
    }

    scrollToCursor() {
      const row = this.list.querySelector('.ent.cursor');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }

    // ---------- 操作 ----------
    async enter(entry) {
      if (entry.kind === 'dir' || entry.linkTo === 'dir') return this.navigate(entry.path);
      if (this.isLocal) return window.ferry.local.open(entry.path);
      return this.app.transferSelection('download');
    }

    async newFolder() {
      if (!this.path) return;
      const name = await promptText({
        title: '新建文件夹',
        desc: `在 ${this.path}`,
        label: '名称',
        value: '未命名文件夹',
        ok: '创建',
      });
      if (!name) return;
      try {
        await this.io.mkdir(posix.join(this.path, name));
        await this.refresh();
        this.selected = new Set([name]);
        this.renderList();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    beginRename(entry) {
      const row = this.list.querySelector(`.ent[data-name="${CSS.escape(entry.name)}"]`);
      if (!row) return;
      const nameEl = row.querySelector('.ent-name');
      const input = h('input', { class: 'rename', value: entry.name, spellcheck: 'false' });
      nameEl.replaceWith(input);
      const stem = entry.name.lastIndexOf('.');
      input.focus();
      input.setSelectionRange(0, stem > 0 ? stem : entry.name.length);

      let settled = false;
      const finish = async (commit) => {
        if (settled) return;
        settled = true;
        const next = input.value.trim();
        if (!commit || !next || next === entry.name) return this.renderList();
        if (/[/\\]/.test(next)) { toast('名称里不能有斜杠', 'error'); return this.renderList(); }
        try {
          await this.io.rename(entry.path, posix.join(this.path, next));
          await this.refresh();
          this.selected = new Set([next]);
          this.renderList();
        } catch (err) {
          toast(err.message, 'error');
          this.renderList();
        }
      };
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); settled = true; this.renderList(); }
      });
    }

    async deleteSelected() {
      const items = this.selectedEntries();
      if (!items.length) return;
      const names = items.map((e) => e.name);
      const detail = names.length > 1
        ? h('div', { class: 'list-box' }, names.slice(0, 50).map((n) => h('div', { class: 'list-row truncate', text: n })))
        : null;

      if (this.app.settings.confirmDelete || !this.isLocal) {
        const ok = await confirm({
          title: names.length === 1 ? `删除「${names[0]}」？` : `删除 ${names.length} 个项目？`,
          desc: this.isLocal ? '会移到「废纸篓」，可以还原。' : '服务器上的删除<b>不可恢复</b>，目录会被递归删除。',
          ok: this.isLocal ? '移到废纸篓' : '永久删除',
          danger: !this.isLocal,
          detail,
        });
        if (!ok) return;
      }

      let failed = 0;
      for (const e of items) {
        try {
          await this.io.remove(e.path);
        } catch (err) {
          failed += 1;
          toast(`${e.name}：${err.message}`, 'error');
        }
      }
      this.selected.clear();
      await this.refresh();
      if (!failed) toast(this.isLocal ? '已移到废纸篓' : '已从服务器删除', 'ok', 2000);
    }

    async editPath() {
      if (!this.path) return;
      const input = h('input', { value: this.path, spellcheck: 'false' });
      clear(this.crumbs);
      this.crumbs.classList.add('editing');
      this.crumbs.append(input);
      input.focus();
      input.select();
      const done = (commit) => {
        const v = input.value.trim();
        this.crumbs.classList.remove('editing');
        if (commit && v && v !== this.path) this.navigate(v);
        else this.renderCrumbs();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(false));
    }

    // ---------- 键盘 ----------
    onKey(e) {
      if (e.target.tagName === 'INPUT') return;
      const list = this.visible();
      const meta = e.metaKey;

      if (meta && e.key === 'ArrowUp') { e.preventDefault(); return this.up(); }
      if (meta && e.key === 'ArrowDown') {
        e.preventDefault();
        const sel = this.selectedEntries();
        if (sel.length === 1) return this.enter(sel[0]);
        return;
      }
      if (meta && e.key === '[') { e.preventDefault(); return this.back(); }
      if (meta && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        this.selected = new Set(list.map((x) => x.name));
        this.renderList();
        return this.app.onSelectionChanged();
      }

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          const next = Math.min(list.length - 1, this.cursor + 1);
          if (e.shiftKey) this.extendTo(next); else this.selectOnly(next);
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          const prev = this.cursor <= 0 ? 0 : this.cursor - 1;
          if (e.shiftKey) this.extendTo(prev); else this.selectOnly(prev);
          return;
        }
        case 'Home': e.preventDefault(); return this.selectOnly(0);
        case 'End': e.preventDefault(); return this.selectOnly(list.length - 1);
        case 'PageDown': e.preventDefault(); return this.selectOnly(Math.min(list.length - 1, this.cursor + 12));
        case 'PageUp': e.preventDefault(); return this.selectOnly(Math.max(0, this.cursor - 12));
        case 'Enter': {
          e.preventDefault();
          const sel = this.selectedEntries();
          if (sel.length === 1) this.beginRename(sel[0]);
          return;
        }
        case ' ': {
          e.preventDefault();
          const sel = this.selectedEntries();
          if (sel.length === 1) this.showInfo(sel[0]);
          return;
        }
        case 'Backspace': {
          if (meta) { e.preventDefault(); this.deleteSelected(); }
          return;
        }
        case 'Tab': {
          e.preventDefault();
          this.app.focusOther(this);
          return;
        }
        default: break;
      }

      // 输入字母跳转
      if (!meta && !e.ctrlKey && !e.altKey && e.key.length === 1 && /\S/.test(e.key)) {
        const now = Date.now();
        this.typeAhead = now - this.typeAheadAt < 900 ? this.typeAhead + e.key : e.key;
        this.typeAheadAt = now;
        const q = this.typeAhead.toLowerCase();
        const i = list.findIndex((x) => x.name.toLowerCase().startsWith(q));
        if (i >= 0) this.selectOnly(i);
      }
    }

    async showInfo(entry) {
      const lines = [
        ['名称', entry.name],
        ['位置', this.path],
        ['类型', entry.kind === 'dir' ? '文件夹' : entry.kind === 'link' ? `符号链接 → ${entry.linkTo || '?'}` : '文件'],
        ['大小', entry.kind === 'dir' ? '—' : `${bytes(entry.size)}（${entry.size.toLocaleString()} 字节）`],
        ['修改时间', when(entry.mtime)],
        ['权限', F.modeStr(entry.mode)],
      ];
      if (!this.isLocal && entry.uid !== undefined) lines.push(['属主', `uid ${entry.uid} / gid ${entry.gid}`]);
      await F.openSheet({
        title: entry.name,
        body: h('div', { class: 'list-box' }, lines.map(([k, v]) => h('div', { class: 'list-row' },
          h('span', { style: { width: '72px', color: 'var(--text-2)', flex: 'none' }, text: k }),
          h('span', { class: 'truncate mono', style: { userSelect: 'text' }, text: String(v) })))),
        actions: [{ label: '关闭', value: true, kind: 'primary' }],
      });
    }

    // ---------- 右键 ----------
    rowContextMenu(x, y, entry) {
      if (!this.selected.has(entry.name)) {
        const idx = this.visible().findIndex((e) => e.name === entry.name);
        this.selectOnly(idx);
      }
      const sel = this.selectedEntries();
      const one = sel.length === 1;
      const other = this.app.otherPane(this);
      const canXfer = !!(other && other.path && (this.isLocal ? this.app.currentHostId : true));

      contextMenu(x, y, [
        (entry.kind === 'dir' || entry.linkTo === 'dir')
          ? { label: '打开', icon: 'chevR', action: () => this.enter(entry) }
          : this.isLocal
            ? { label: '用默认程序打开', icon: 'chevR', action: () => window.ferry.local.open(entry.path) }
            : null,
        canXfer ? {
          label: this.isLocal ? `上传到服务器${one ? '' : `（${sel.length} 项）`}` : `下载到本机${one ? '' : `（${sel.length} 项）`}`,
          icon: this.isLocal ? 'arrowR' : 'arrowL',
          shortcut: this.isLocal ? '⌘→' : '⌘←',
          action: () => this.app.transferSelection(this.isLocal ? 'upload' : 'download'),
        } : null,
        'sep',
        { label: '重命名', icon: 'pencil', shortcut: '↩', disabled: !one, action: () => this.beginRename(entry) },
        { label: this.isLocal ? '移到废纸篓' : '删除', icon: 'trash', shortcut: '⌘⌫', action: () => this.deleteSelected() },
        'sep',
        { label: '拷贝路径', icon: 'doc', disabled: !one, action: () => { navigator.clipboard.writeText(entry.path); toast('路径已拷贝', 'ok', 1600); } },
        this.isLocal && one ? { label: '在 Finder 中显示', icon: 'eye', action: () => window.ferry.local.reveal(entry.path) } : null,
        { label: '显示简介', icon: 'info', shortcut: '空格', disabled: !one, action: () => this.showInfo(entry) },
        'sep',
        { label: '新建文件夹', icon: 'folderPlus', shortcut: '⇧⌘N', action: () => this.newFolder() },
        { label: '刷新', icon: 'refresh', shortcut: '⌘R', action: () => this.refresh() },
      ]);
    }

    bgContextMenu(x, y) {
      contextMenu(x, y, [
        { label: '新建文件夹', icon: 'folderPlus', shortcut: '⇧⌘N', disabled: !this.path, action: () => this.newFolder() },
        { label: '刷新', icon: 'refresh', shortcut: '⌘R', disabled: !this.path, action: () => this.refresh() },
        { label: '上一级', icon: 'chevU', shortcut: '⌘↑', disabled: !this.parent, action: () => this.up() },
        'sep',
        { label: this.app.settings.showHidden ? '隐藏“点文件”' : '显示隐藏文件', icon: 'eye', shortcut: '⇧⌘.', action: () => this.app.toggleHidden() },
        { label: '拷贝当前路径', icon: 'doc', disabled: !this.path, action: () => { navigator.clipboard.writeText(this.path); toast('路径已拷贝', 'ok', 1600); } },
        this.isLocal ? { label: '在 Finder 中打开', icon: 'eye', disabled: !this.path, action: () => window.ferry.local.reveal(this.path) } : null,
      ]);
    }

    // ---------- 渲染 ----------
    render() {
      this.renderCrumbs();
      this.renderList();
      this.renderFoot();
    }

    renderCols() {
      for (const b of this.cols.children) {
        const on = b.dataset.key === this.sort.key;
        b.classList.toggle('sorted', on);
        b.querySelector('.arrow').innerHTML = on ? icon(this.sort.dir > 0 ? 'chevU' : 'chevD', 10) : '';
      }
    }

    renderCrumbs() {
      const c = clear(this.crumbs);
      c.classList.remove('editing');
      if (!this.path) {
        c.append(h('span', { class: 'crumb', text: this.loading ? '连接中…' : this.isLocal ? '' : '未连接' }));
        return;
      }
      const abs = this.path;
      const parts = abs.split('/').filter(Boolean);
      const frag = [h('button', { class: 'crumb', text: '/', onclick: () => this.navigate('/') })];
      let acc = '';
      parts.forEach((p, i) => {
        acc += `/${p}`;
        const target = acc;
        if (i > 0) frag.push(h('span', { class: 'crumb-sep', text: '›' }));
        frag.push(h('button', { class: 'crumb truncate', text: p, title: target, onclick: () => this.navigate(target) }));
      });
      c.append(...frag);
      c.title = `${abs}\n双击可直接输入路径`;
      c.scrollLeft = 9999;
    }

    renderList() {
      const body = clear(this.list);

      if (!this.isLocal && !this.hostId) {
        body.append(h('div', { class: 'pane-empty' },
          iconEl('server', 26, ''),
          h('div', { style: { marginTop: '10px' }, text: '左侧选一台主机开始' }),
          h('div', { style: { marginTop: '4px', fontSize: '11.5px' }, text: '⌘N 添加主机 · ⌘K 快速切换' })));
        return;
      }
      if (this.error) {
        body.append(h('div', { class: 'pane-empty' },
          iconEl('warn', 24),
          h('div', { style: { marginTop: '10px', color: 'var(--red)' }, text: this.error }),
          h('button', { class: 'btn', style: { marginTop: '12px' }, text: '重试', onclick: () => this.refresh() })));
        return;
      }
      if (this.loading && !this.entries.length) {
        body.append(h('div', { class: 'pane-empty' }, h('span', { html: icon('refresh', 20, 'spin') }), h('div', { style: { marginTop: '10px' }, text: '读取中…' })));
        return;
      }

      const list = this.visible();
      if (!list.length) {
        const hiddenCount = this.entries.filter((e) => e.name.startsWith('.')).length;
        body.append(h('div', { class: 'pane-empty' },
          h('div', { text: this.filter ? '没有匹配的项目' : '空文件夹' }),
          !this.filter && hiddenCount && !this.app.settings.showHidden
            ? h('div', { style: { marginTop: '6px', fontSize: '11.5px' }, text: `有 ${hiddenCount} 个隐藏项目 · ⇧⌘. 显示` })
            : null));
        return;
      }

      const frag = document.createDocumentFragment();
      list.forEach((e, i) => {
        const isDir = e.kind === 'dir' || e.linkTo === 'dir';
        const row = h('div', {
          class: `ent${this.selected.has(e.name) ? ' sel' : ''}${i === this.cursor ? ' cursor' : ''}${isDir ? ' is-dir' : ''}${e.broken ? ' dim' : ''}`,
          dataset: { name: e.name, i },
          draggable: 'true',
          title: e.name,
        },
        h('div', { class: 'ent-main' },
          h('span', { class: 'ent-ico', html: icon(ICON_FOR(e), 15) }),
          h('span', { class: 'ent-name truncate', text: e.name })),
        h('span', { class: 'ent-meta num', text: isDir ? '—' : bytes(e.size) }),
        h('span', { class: 'ent-meta num', text: when(e.mtime) }));

        row.addEventListener('mousedown', (ev) => {
          if (ev.button === 2) return;
          if (ev.metaKey) this.toggleAt(i);
          else if (ev.shiftKey) this.extendTo(i);
          else if (!this.selected.has(e.name)) this.selectOnly(i);
          else { this.cursor = i; }
        });
        row.addEventListener('click', (ev) => {
          if (!ev.metaKey && !ev.shiftKey && this.selected.size > 1 && this.selected.has(e.name)) this.selectOnly(i);
        });
        row.addEventListener('dblclick', () => this.enter(e));
        row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.rowContextMenu(ev.clientX, ev.clientY, e); });

        row.addEventListener('dragstart', (ev) => {
          if (!this.selected.has(e.name)) this.selectOnly(i);
          const sel = this.selectedEntries();
          ev.dataTransfer.effectAllowed = 'copy';
          ev.dataTransfer.setData('application/x-ferry', JSON.stringify({
            side: this.side,
            hostId: this.hostId,
            dir: this.path,
            items: sel.map((x) => ({ path: x.path, name: x.name, kind: x.kind, linkTo: x.linkTo, size: x.size })),
          }));
          const ghost = h('div', { class: 'drag-ghost', text: sel.length === 1 ? sel[0].name : `${sel.length} 个项目` });
          document.body.append(ghost);
          ev.dataTransfer.setDragImage(ghost, 12, 12);
          setTimeout(() => ghost.remove(), 0);
        });

        // 拖到文件夹上直接传到那个文件夹里
        if (isDir) {
          row.addEventListener('dragover', (ev) => {
            if (!this.canDrop(ev)) return;
            ev.preventDefault();
            ev.stopPropagation();
            ev.dataTransfer.dropEffect = 'copy';
            row.classList.add('sel');
          });
          row.addEventListener('dragleave', () => { if (!this.selected.has(e.name)) row.classList.remove('sel'); });
          row.addEventListener('drop', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            row.classList.remove('sel');
            this.handleDrop(ev, e.path);
          });
        }

        frag.append(row);
      });
      body.append(frag);
      this.renderFoot();
    }

    renderFoot() {
      const f = clear(this.foot);
      if (!this.path) return;
      const list = this.visible();
      const sel = this.selectedEntries();
      const selSize = sel.reduce((a, e) => a + (e.kind === 'dir' ? 0 : e.size || 0), 0);
      const total = list.reduce((a, e) => a + (e.kind === 'dir' ? 0 : e.size || 0), 0);
      f.append(h('span', { text: `${list.length} 项` }));
      if (this.filter) f.append(h('span', { text: `（已过滤，共 ${this.entries.length}）` }));
      f.append(h('span', { class: 'spacer' }));
      if (sel.length) f.append(h('span', { text: `已选 ${sel.length} 项 · ${bytes(selSize)}` }));
      else f.append(h('span', { text: bytes(total) }));
    }
  }

  F.Pane = Pane;

})();
