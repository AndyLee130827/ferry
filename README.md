# Ferry

在 Mac 和你管理的若干台服务器之间，用 SSH/SFTP 搬文件。

左边是你的 Mac，右边是服务器，中间拖一下就传过去了。支持密钥免密登录，主机在侧栏里增删改。

![Ferry](assets/icon.png)

## 跑起来

```bash
npm install          # 若 Electron 二进制下载被墙，见下方「安装卡住怎么办」
npm start
```

## 它能做什么

**主机管理**
- 侧栏增删改主机，拖动排序，`⌘1`–`⌘9` 直接切换，`⌘K` 搜索切换
- 三种登录方式：**密钥文件**（默认）、**ssh-agent**、**密码**
- 加密私钥的口令、密码都存进 **macOS 登录钥匙串**，配置文件里不留明文
- 一键从 `~/.ssh/config` 导入已有主机（支持 `Include`，自动跳过通配条目）
- 每台主机可设默认的远端目录和本地目录，连上就直接到位

**主机密钥校验**
- 自己解析 `~/.ssh/known_hosts`，包括 `|1|` 哈希条目、`[host]:port` 写法、逗号分隔的多主机行
- 首次连接弹出指纹确认；指纹变更（同算法）会弹**红色警告**并要求二次确认
- `@revoked` 标记的密钥直接拒绝

**文件传输**
- 双栏文件管理器：面包屑导航、排序、过滤、多选、重命名、新建文件夹、删除
- 传输方式随便挑：面板间拖拽、拖到侧栏某台主机上、`⌘→` / `⌘←`、右键菜单
- 从 Finder 直接拖文件到右侧面板 = 上传
- 目录递归传输，底层走 `fastGet`/`fastPut` 流水线，比逐块读写快得多
- 并发可调（默认 3），每个并发任务独占一条 SFTP 通道
- 同名冲突时可选**覆盖 / 跳过 / 两者都留**
- 传输面板带实时速度、进度、剩余时间，可暂停、取消、重试失败项
- 默认保留源文件的修改时间

**其它**
- 浅色 / 深色跟随系统，也可手动固定
- 服务器信息面板（系统、磁盘占用、负载）
- 远端删除是递归的，并且**一定会**二次确认（本地删除走废纸篓，可还原）

## 快捷键

| 键 | 作用 |
|---|---|
| `⌘N` | 添加主机 |
| `⌘E` | 编辑当前主机 |
| `⌘K` | 快速切换主机 |
| `⌘1`…`⌘9` | 切到第 N 台主机 |
| `⇧⌘C` | 连接 / 断开 |
| `⌘→` / `⌘←` | 上传 / 下载选中项 |
| `Tab` | 切换左右面板 |
| `↩` | 重命名 |
| `⌘↓` | 打开 |
| `空格` | 显示简介 |
| `⌘↑` | 上一级目录 |
| `⌘[` | 后退 |
| `⌘F` | 过滤当前目录 |
| `⇧⌘.` | 显示 / 隐藏「点文件」 |
| `⌘R` | 刷新 |
| `⌘⌫` | 删除 |
| `⌘T` | 传输面板 |
| `⌘P` | 暂停 / 继续队列 |
| `⇧⌘K` | 清除已完成 |

双击面包屑可以直接敲路径跳转。

## 打包成 .app

```bash
npm run dist          # Apple Silicon
npm run dist:x64      # Intel
```

产物在 `~/Ferry-release/`：`Ferry.app` 和一个 `.dmg`。

> 为什么不输出到项目目录里？因为这个项目放在 exFAT 盘上，而 exFAT 存不了符号链接和可执行位，`.app` 内部两者都要，就地打包必然失败。如果你把项目挪到主盘（APFS），去掉脚本里的 `-c.directories.output=...` 即可。

打出来的包没有签名，首次打开要右键 →「打开」，或执行：

```bash
xattr -dr com.apple.quarantine /Applications/Ferry.app
```

如果 `electron-builder` 下载 Electron 时被代理污染（表现为下载到的 zip 大小不对、解包后 `Contents/MacOS` 是空的），把一份完好的 zip 放进缓存再打：

```bash
cp electron-v33.4.11-darwin-arm64.zip ~/Library/Caches/electron/
```

## 安装卡住怎么办

`npm install` 的最后一步是下载 ~95MB 的 Electron 二进制，在国内经常连不上 GitHub。两个办法：

```bash
# 方法一：走镜像
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

```bash
# 方法二：手动放进去
npm install --ignore-scripts
V=$(node -p "require('./node_modules/electron/package.json').version")
curl -L -o /tmp/electron.zip \
  "https://npmmirror.com/mirrors/electron/$V/electron-v$V-darwin-arm64.zip"
mkdir -p node_modules/electron/dist
unzip -q /tmp/electron.zip -d node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

## 代码结构

```
electron/                主进程
  main.js                窗口、菜单、全部 IPC
  preload.js             contextBridge 暴露给界面的 API
  ssh.js                 SSH 连接管理 + SFTP 通道池
  transfer.js            传输队列：递归展开、并发调度、进度、取消
  store.js               主机与设置的持久化
  keychain.js            macOS 钥匙串读写（security 命令）
  known-hosts.js         known_hosts 解析与指纹校验
  ssh-config.js          ~/.ssh/config 解析
  local.js               本机文件操作
renderer/                界面（无框架，原生 DOM）
  index.html
  css/app.css
  js/util.js             DOM 助手、图标、格式化
  js/ui.js               提示条、模态、右键菜单、口令/指纹弹窗
  js/pane.js             文件面板（双栏各一个实例）
  js/hosts.js            侧栏与主机编辑器
  js/queue.js            传输面板
  js/app.js              总装：主机、面板、队列、菜单、快捷键
```

## 一些设计上的取舍

**为什么取消传输要特殊处理。** `fastPut` / `fastGet` 没有中断接口，关掉 SFTP 通道之后它的回调可能再也不来。所以每个并发任务独占一条通道，取消时销毁该通道并**立即**结算这个任务——通道没了，字节流确实停了，不必等一个可能永远不来的回调。这也是通道池存在的原因之一。

**为什么钥匙串里存的是 `v1:<base64>`。** `security find-generic-password -w` 在值含非 ASCII 字节时会输出十六进制而不是原文，而纯 ASCII 的密码又可能恰好全是十六进制字符，无法区分。加一个 `v1:` 前缀让存储值永远是 ASCII，读取时无歧义。

**为什么自己解析 known_hosts。** 调 `ssh-keygen -F` 要为每次连接起一个进程，而且拿不到结构化结果。自己解析反而更简单，也能区分「没见过这台主机」和「指纹变了」——后者是需要红色警告的。

**符号链接。** 列目录时对软链额外 `stat` 一次，用来判断它指向文件还是目录；上传时跟随软链（和 `scp -r` 行为一致）。

## 不支持的

- **ProxyJump / 跳板机**：从 `~/.ssh/config` 导入时会在备注里标出来，但连接本身不走跳板。需要的话先在本地建隧道。
- **断点续传**：取消后重试是从头开始的。
- **服务器之间直传**：所有传输都经过本机。

## 开发

```bash
npm run dev     # 带 DevTools
```
