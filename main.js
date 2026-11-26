// Unofficial desktop wrapper for Muse (https://muse.ai/)
// Features: persistent login, window-state memory, tray icon, global hotkey,
// optional start-with-Windows, single instance, external links in default browser,
// multiple accounts (up to 10), each with its own window and persistent
// session, all open at the same time (v3.6). Also: shortcut list popup and
// auto-update via GitHub Releases when running the packaged installer build.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  globalShortcut,
  shell,
  nativeImage,
  session,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Settings you may want to change -------------------------------------
const START_URL = 'https://muse.ai/';
const HOTKEY = 'Control+Alt+M'; // show/hide the window from anywhere
// Hosts that stay inside the app (login flows etc.). Everything else opens
// in your default browser.
const INTERNAL_HOSTS = [
  'muse.ai',
  'meta.com',
  'facebook.com',
  'instagram.com',
  'whatsapp.com',
  'fbcdn.net',
];
// Sign-in hosts for connector OAuth flows. These open in-app even when the
// site does not mark the window as a popup.
const AUTH_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'github.com',
];

// Accounts. Each account keeps its own persistent session (cookies / login)
// and its own window; all windows can be open at the same time. The list is
// stored in accounts.json in userData and can hold up to MAX_ACCOUNTS entries.
// 'main' uses the default session so the login that already exists is
// preserved; every other account gets its own partition.
const MAX_ACCOUNTS = 10;
let accounts = [
  { id: 'main', label: 'メイン', partition: null },
  { id: 'sub', label: 'サブ', partition: 'persist:muse-sub' },
];
// ---------------------------------------------------------------------------

// Needed for Windows toast notifications to show up with the right name/icon.
// Keep in sync with "appId" in package.json.
app.setAppUserModelId('local.kekenium.muse-desktop');

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const ACCOUNT_FILE = path.join(app.getPath('userData'), 'account-state.json');
const ACCOUNTS_FILE = path.join(app.getPath('userData'), 'accounts.json');

const windows = {};
let lastActiveAccountId = 'main';
let openAccounts = ['main'];
let windowStates = {};
let buildTrayMenu = () => Menu.buildFromTemplate([]);

function accountFor(id) {
  return accounts.find((a) => a.id === id) || accounts[0];
}

function accountIndex(id) {
  return accounts.findIndex((a) => a.id === id);
}

// Hotkey digit for the account at position i (1-based): 1..9, then 0 for 10th.
function acceleratorForIndex(i) {
  return `Control+Shift+${(i + 1) % 10}`;
}

function loadAccounts() {
  try {
    const list = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (Array.isArray(list)) {
      const valid = list
        .filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string')
        .map((a) => ({
          id: a.id,
          label: a.label,
          partition: a.id === 'main' ? null : a.partition || `persist:muse-${a.id}`,
        }));
      if (valid.length && valid.some((a) => a.id === 'main')) {
        accounts = valid.slice(0, MAX_ACCOUNTS);
      }
    }
  } catch {
    /* no accounts.json yet: keep the built-in main + sub defaults */
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

function loadAccountState() {
  try {
    const s = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (Array.isArray(s.open)) {
      const valid = s.open.filter((id) => accounts.some((a) => a.id === id));
      if (valid.length) openAccounts = valid;
    } else if (accounts.some((a) => a.id === s.current)) {
      // v3.4 format: { current: '<id>' }
      openAccounts = [s.current];
    }
    if (accounts.some((a) => a.id === s.lastActive)) lastActiveAccountId = s.lastActive;
    else if (accounts.some((a) => a.id === s.current)) lastActiveAccountId = s.current;
  } catch {
    /* no saved state yet: defaults (main only) */
  }
  if (!openAccounts.includes(lastActiveAccountId)) lastActiveAccountId = openAccounts[0];
}

function saveAccountState() {
  const open = accounts
    .map((a) => a.id)
    .filter((id) => {
      const w = windows[id];
      return w && !w.isDestroyed();
    });
  try {
    fs.writeFileSync(
      ACCOUNT_FILE,
      JSON.stringify({ open: open.length ? open : openAccounts, lastActive: lastActiveAccountId })
    );
  } catch {
    /* ignore */
  }
}

let tray = null;
let isQuitting = false;
const lastNotifyByAccount = {};

// Debug log lives next to the exe so it can be inspected remotely.
const DEBUG_LOG = path.join(path.dirname(process.execPath), 'notify-debug.log');
function dbg(line) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

// Popup diagnostics (v3.6.2): mirror window-open decisions to the shared
// folder so they can be read over SSH while debugging connector sign-in.
const POPUP_LOG = 'C:\\Users\\Public\\Muse\\popup-debug.log';
function plog(line) {
  dbg(line);
  try {
    fs.appendFileSync(POPUP_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* ignore */
  }
}

// Show a native Windows toast for one account's window (rate-limited per
// account). Also flashes that window's taskbar button.
function notifyOnce(title, body, accountId) {
  const win = windows[accountId];
  const now = Date.now();
  if (now - (lastNotifyByAccount[accountId] || 0) < 15000) {
    dbg(`notify suppressed (rate limit): ${title}`);
    return;
  }
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) {
    dbg(`notify suppressed (window focused): ${title}`);
    return;
  }
  lastNotifyByAccount[accountId] = now;
  dbg(`notify SHOW: ${title} / ${body}`);
  try {
    const n = new Notification({ title, body, icon: ICON_PATH });
    n.on('click', () => showWindow(accountId));
    n.show();
  } catch (e) {
    dbg(`notify error: ${e && e.message}`);
  }
  win.flashFrame(true);
}

// Injected into the page (main world) after load:
// 1) Forwards site-created Notifications to the main process via console.
// 2) Watches for new chat content arriving while the page is hidden and
//    signals the main process once the stream settles.
const NOTIFY_HOOK_JS = `
(() => {
  if (window.__museNotifyHook) return;
  window.__museNotifyHook = true;
  try {
    const Orig = window.Notification;
    if (Orig && !Orig.__museWrapped) {
      const Wrapped = function (title, options) {
        try {
          console.log('__MUSE_SITE_NOTIFICATION__ ' + JSON.stringify({
            title: String(title || 'Muse'),
            body: (options && options.body) || '',
          }));
        } catch (e) {}
        return new Orig(title, options);
      };
      Wrapped.prototype = Orig.prototype;
      Wrapped.permission = Orig.permission;
      if (Orig.requestPermission) {
        Wrapped.requestPermission = Orig.requestPermission.bind(Orig);
      }
      Wrapped.__museWrapped = true;
      window.Notification = Wrapped;
    }
  } catch (e) {}
  let pendingNew = false;
  let settleTimer = null;
  let lastSignal = 0;
  const dirtyRoots = new Set();
  const collectPreview = () => {
    const all = [...dirtyRoots];
    dirtyRoots.clear();
    // Keep only innermost blocks (a block that contains another dirty block
    // is a container holding older history as well).
    const innermost = all.filter(
      (r) => !all.some((o) => o !== r && r.contains && r.contains(o))
    );
    const blocks = innermost
      .map((r) => ({ el: r, text: (r.textContent || '').replace(/\s+/g, ' ').trim() }))
      .filter((b) => b.text.length >= 10 && !/^メッセージ/.test(b.text))
      .sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
    // The newest message is last in document order.
    let text = blocks
      .slice(-3)
      .map((b) => b.text)
      .join(' ');
    text = text
      .replace(/(アシスタントメッセージ|自分|メッセージ)\s*[:：]?\s*/g, '')
      .replace(/\d+\s*m\s+/g, '')
      .trim();
    return text.slice(0, 120);
  };
  // Text of the last text-bearing leaf block in the page. A genuine new
  // arrival changes this tail; a re-render of older history does not.
  const currentTailText = () => {
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let last = '';
      let n;
      while ((n = walker.nextNode())) {
        if (SKIP_TAGS.has(n.tagName)) continue;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 10 && n.querySelectorAll('*').length <= 3) last = t;
      }
      return last;
    } catch (e) {
      return '';
    }
  };
  const hookStart = Date.now();
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG']);
  const observer = new MutationObserver((muts) => {
    let added = 0;
    for (const m of muts) {
      if (m.type === 'characterData') {
        const pe = m.target && m.target.parentElement;
        if (pe && !SKIP_TAGS.has(pe.tagName)) {
          added += 1;
          dirtyRoots.add(pe);
        }
      }
      if (m.addedNodes) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1 && SKIP_TAGS.has(n.tagName)) return;
          added += (n.textContent || '').length;
          if (n.nodeType === 1) dirtyRoots.add(n);
        });
      }
    }
    if (added < 20) return;
    pendingNew = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const now = Date.now();
      if (pendingNew && now - hookStart < 12000) {
        dirtyRoots.clear();
        pendingNew = false;
        return;
      }
      if (pendingNew && now - lastSignal > 20000) {
        const preview = collectPreview();
        const tail = currentTailText().slice(0, 30);
        if (preview && tail && (preview.includes(tail) || tail.includes(preview.slice(0, 30)))) {
          lastSignal = now;
          console.log('__MUSE_NEW_MESSAGE__ ' + JSON.stringify({ preview }));
        } else {
          console.log('__MUSE_SKIP_RERENDER__');
          dirtyRoots.clear();
        }
      } else {
        dirtyRoots.clear();
      }
      pendingNew = false;
    }, 5000);
  });
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  setInterval(() => {
    try {
      console.log('__MUSE_PING__ ' + JSON.stringify({
        hidden: document.hidden,
        vis: document.visibilityState,
        url: location.href.slice(0, 80),
      }));
    } catch (e) {}
  }, 10000);
  return 'hooked vis=' + document.visibilityState;
})();
`;

function hostMatches(hostname, base) {
  return hostname === base || hostname.endsWith('.' + base);
}

function isInternalUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'https:') return false;
    return INTERNAL_HOSTS.some((h) => hostMatches(hostname, h));
  } catch {
    return false;
  }
}

function loadWindowStates() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s === 'object') {
      if (typeof s.width === 'number') {
        // v3.4 format: flat bounds for the single window -> main's bounds.
        windowStates = { main: s };
      } else {
        windowStates = s;
      }
    }
  } catch {
    windowStates = {};
  }
}

function saveAllWindowStates() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(windowStates));
  } catch {
    /* ignore */
  }
}

function saveWindowState(accountId) {
  const win = windows[accountId];
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? win.getNormalBounds() : win.getBounds();
  windowStates[accountId] = { ...bounds, maximized };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(windowStates));
  } catch {
    /* ignore */
  }
}

function defaultBoundsFor(accountId) {
  const base = windowStates.main || { width: 1200, height: 820 };
  if (accountId === 'main') return { width: 1200, height: 820 };
  const b = { width: base.width || 1200, height: base.height || 820 };
  if (typeof base.x === 'number' && typeof base.y === 'number') {
    const offset = 40 * Math.max(1, accountIndex(accountId));
    b.x = base.x + offset;
    b.y = base.y + offset;
  }
  return b;
}

function showWindow(accountId) {
  const id = accountId || lastActiveAccountId;
  let win = windows[id];
  if (!win || win.isDestroyed()) {
    createWindow(id);
    win = windows[id];
  }
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  lastActiveAccountId = id;
}

function toggleWindow() {
  const id = windows[lastActiveAccountId] ? lastActiveAccountId : 'main';
  const win = windows[id];
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showWindow(id);
  }
}

function focusedOrActiveWindow() {
  const f = BrowserWindow.getFocusedWindow();
  if (f) return f;
  const w = windows[lastActiveAccountId];
  return w && !w.isDestroyed() ? w : null;
}

function rebuildMenus() {
  createAppMenu();
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// ---- Shortcut list popup ---------------------------------------------------
let shortcutWin = null;

function shortcutRowsHtml() {
  const rows = [
    ['Ctrl+Alt+M', 'ウィンドウの表示／非表示'],
    ...accounts.map((a, i) => [`Ctrl+Shift+${(i + 1) % 10}`, `${a.label}を開く`]),
    ['Alt+/', 'この一覧を開く／閉じる'],
    ['F5', '再読み込み'],
    ['F11', '全画面の切り替え'],
  ];
  return rows
    .map(
      ([k, v]) =>
        `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`
    )
    .join('');
}

function toggleShortcutPopup() {
  if (shortcutWin && !shortcutWin.isDestroyed()) {
    shortcutWin.close();
    return;
  }
  const html = `<!doctype html><meta charset="utf-8"><title>ショートカット一覧</title>
    <style>
      body{margin:0;background:#1d1d21;color:#eee;font-family:"Segoe UI","Yu Gothic UI",sans-serif;padding:14px 16px}
      h1{font-size:14px;margin:0 0 10px;font-weight:600}
      .row{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid #333}
      .row:last-child{border-bottom:0}
      .k{font-family:Consolas,monospace;font-size:12.5px;color:#ffd479;white-space:nowrap}
      .v{font-size:12.5px;opacity:.85;text-align:right}
      .hint{margin-top:10px;font-size:11px;opacity:.55}
    </style>
    <h1>ショートカット一覧</h1>
    ${shortcutRowsHtml()}
    <div class="hint">Escキー、または外側をクリックすると閉じます</div>`;
  shortcutWin = new BrowserWindow({
    width: 400,
    height: 190 + accounts.length * 30,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'ショートカット一覧',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  shortcutWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  shortcutWin.on('blur', () => {
    if (shortcutWin && !shortcutWin.isDestroyed()) shortcutWin.close();
  });
  shortcutWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && shortcutWin && !shortcutWin.isDestroyed()) {
      shortcutWin.close();
    }
  });
  shortcutWin.on('closed', () => {
    shortcutWin = null;
  });
}

// ---- Small text prompt (console-message bridge, no preload needed) --------
function promptForLabel(defaultLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const html = `<!doctype html><meta charset="utf-8"><title>アカウントを追加</title>
    <style>
      body{margin:0;background:#1d1d21;color:#eee;font-family:"Segoe UI","Yu Gothic UI",sans-serif;padding:16px}
      label{font-size:13px;display:block;margin-bottom:8px}
      input{width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border-radius:6px;border:1px solid #444;background:#26262b;color:#eee}
      .btns{margin-top:14px;display:flex;gap:8px;justify-content:flex-end}
      button{padding:7px 16px;font-size:13px;border-radius:6px;border:0;cursor:pointer}
      .ok{background:#e8e8e8;color:#111}
      .cancel{background:#3a3a40;color:#eee}
    </style>
    <label>新しいアカウントの表示名</label>
    <input id="t" type="text" maxlength="20" value="${defaultLabel.replace(/"/g, '&quot;')}">
    <div class="btns">
      <button class="cancel" onclick="send(null)">キャンセル</button>
      <button class="ok" onclick="send(document.getElementById('t').value)">追加</button>
    </div>
    <script>
      const send = (v) => console.log('__MUSE_PROMPT__ ' + JSON.stringify({ value: v }));
      const input = document.getElementById('t');
      input.focus(); input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') send(input.value);
        if (e.key === 'Escape') send(null);
      });
    </script>`;
    const win = new BrowserWindow({
      width: 380,
      height: 190,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: 'アカウントを追加',
      icon: ICON_PATH,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.on('console-message', (...args) => {
      let message = '';
      for (const a of args) {
        if (typeof a === 'string' && a.startsWith('__MUSE_PROMPT__')) message = a;
        else if (a && typeof a === 'object' && typeof a.message === 'string' && a.message.startsWith('__MUSE_PROMPT__')) message = a.message;
      }
      if (!message) return;
      try {
        const d = JSON.parse(message.slice(message.indexOf('{')));
        done(typeof d.value === 'string' ? d.value : null);
      } catch {
        done(null);
      }
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => done(null));
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

// ---- Account add / remove ---------------------------------------------------
async function addAccount() {
  if (accounts.length >= MAX_ACCOUNTS) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'アカウントを追加',
      message: `アカウントは最大${MAX_ACCOUNTS}個までです。`,
    });
    return;
  }
  const label = await promptForLabel(`アカウント${accounts.length + 1}`);
  if (label === null) return;
  const id = 'u' + Date.now().toString(36);
  const acc = {
    id,
    label: label.trim().slice(0, 20) || `アカウント${accounts.length + 1}`,
    partition: `persist:muse-${id}`,
  };
  accounts.push(acc);
  saveAccounts();
  setupSession(session.fromPartition(acc.partition));
  rebuildMenus();
  showWindow(id);
  dbg(`account added: ${id} (${acc.label})`);
}

async function removeAccount(id) {
  if (id === 'main') return;
  const acc = accountFor(id);
  const first = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['キャンセル', '削除する'],
    defaultId: 0,
    cancelId: 0,
    title: 'アカウントを削除',
    message: `「${acc.label}」をアカウント一覧から削除しますか？`,
    detail: '開いているウィンドウは閉じられます。',
  });
  if (first.response !== 1) return;
  const second = await dialog.showMessageBox({
    type: 'question',
    buttons: ['ログイン情報を残す', 'ログイン情報も消す'],
    defaultId: 0,
    cancelId: 0,
    title: 'ログイン情報の扱い',
    message: 'このアカウントのログイン情報（Cookieなど）を消しますか？',
    detail: '「残す」を選ぶと、同じ名前で再追加したときにログインが残っている場合があります。',
  });
  const win = windows[id];
  if (win && !win.isDestroyed()) win.destroy();
  if (second.response === 1 && acc.partition) {
    try {
      const ses = session.fromPartition(acc.partition);
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (e) {
      dbg(`clear session error (${id}): ` + (e && e.message));
    }
  }
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts();
  delete windowStates[id];
  saveAllWindowStates();
  openAccounts = openAccounts.filter((x) => x !== id);
  if (lastActiveAccountId === id) lastActiveAccountId = 'main';
  saveAccountState();
  rebuildMenus();
  dbg(`account removed: ${id}`);
}

// ---- Auto-update (GitHub Releases, packaged builds only) -------------------
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch {
  autoUpdater = null;
}
let manualUpdateCheck = false;

function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) {
    dbg('autoupdate: skipped (dev/asar build or electron-updater missing)');
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => dbg('autoupdate error: ' + (e && e.message)));
  autoUpdater.on('update-available', (info) => dbg('autoupdate available: ' + info.version));
  autoUpdater.on('update-not-available', () => {
    dbg('autoupdate: up to date');
    if (manualUpdateCheck) {
      manualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: '更新の確認',
        message: 'お使いのバージョンは最新です。',
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    dbg('autoupdate downloaded: ' + info.version);
    try {
      const n = new Notification({
        title: 'Muse Desktop の更新',
        body: `バージョン ${info.version} をダウンロードしました。クリックで再起動して更新します。押さなければ次回終了時に自動で更新されます。`,
        icon: ICON_PATH,
      });
      n.on('click', () => {
        isQuitting = true;
        autoUpdater.quitAndInstall();
      });
      n.show();
    } catch {
      /* ignore */
    }
  });
  const check = () =>
    autoUpdater.checkForUpdates().catch((e) => dbg('autoupdate check failed: ' + (e && e.message)));
  setTimeout(check, 10000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

function checkForUpdatesManually() {
  if (!autoUpdater || !app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      title: '更新の確認',
      message: '自動更新はインストーラー版でのみ使えます。',
    });
    return;
  }
  manualUpdateCheck = true;
  autoUpdater.checkForUpdates().catch((e) => {
    manualUpdateCheck = false;
    dbg('autoupdate manual check failed: ' + (e && e.message));
  });
}

function createAppMenu() {
  const template = [
    {
      label: 'アカウント',
      submenu: [
        ...accounts.map((a, i) => ({
          label: `${a.label}を開く`,
          accelerator: acceleratorForIndex(i),
          click: () => showWindow(a.id),
        })),
        { type: 'separator' },
        {
          label: 'アカウントを追加…',
          click: () => addAccount(),
        },
        {
          label: 'アカウントを削除',
          submenu: accounts
            .filter((a) => a.id !== 'main')
            .map((a) => ({
              label: `${a.label}を削除…`,
              click: () => removeAccount(a.id),
            })),
        },
      ],
    },
    {
      label: '表示',
      submenu: [
        {
          label: '再読み込み',
          accelerator: 'F5',
          click: () => {
            const w = focusedOrActiveWindow();
            if (w) w.webContents.reload();
          },
        },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'ショートカット一覧',
          accelerator: 'Alt+/',
          click: () => toggleShortcutPopup(),
        },
        {
          label: '更新を確認',
          click: () => checkForUpdatesManually(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(accountId) {
  const account = accountFor(accountId);
  const state = windowStates[accountId] || defaultBoundsFor(accountId);

  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    backgroundThrottling: false,
  };
  if (account.partition) webPreferences.partition = account.partition;

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 420,
    minHeight: 520,
    title: `Muse Desktop - ${account.label}`,
    backgroundColor: '#17171a', // matches Muse's theme color
    icon: ICON_PATH,
    autoHideMenuBar: true,
    webPreferences,
  });
  windows[accountId] = win;
  if (state.maximized) win.maximize();

  // Keep the account label visible in the title bar.
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(`${title} - ${account.label}`);
  });

  win.loadURL(START_URL);

  // Bridge from the injected page hook (see NOTIFY_HOOK_JS).
  // Electron versions differ in this event's argument shape, so parse flexibly.
  let lastPingLog = 0;
  win.webContents.on('console-message', (...args) => {
    let message = '';
    for (const a of args) {
      if (typeof a === 'string' && a.startsWith('__MUSE')) {
        message = a;
        break;
      }
      if (a && typeof a === 'object' && typeof a.message === 'string' && a.message.startsWith('__MUSE')) {
        message = a.message;
        break;
      }
    }
    if (!message) return;
    if (message === '__MUSE_SKIP_RERENDER__') {
      dbg(`signal(${account.id}): SKIP (re-render of old content)`);
    } else if (message.startsWith('__MUSE_NEW_MESSAGE__')) {
      let preview = '';
      try {
        preview = JSON.parse(message.slice(message.indexOf('{'))).preview || '';
      } catch {
        /* ignore */
      }
      dbg(`signal(${account.id}): NEW_MESSAGE preview=[` + preview + ']');
      notifyOnce(
        'Muse - ' + account.label,
        preview && preview.length >= 4 ? preview : '新しい返信が届きました',
        account.id
      );
    } else if (message.startsWith('__MUSE_SITE_NOTIFICATION__ ')) {
      dbg(`signal(${account.id}): SITE_NOTIFICATION`);
      try {
        const d = JSON.parse(message.slice(message.indexOf('{')));
        notifyOnce((d.title || 'Muse') + ' - ' + account.label, d.body || '', account.id);
      } catch {
        /* ignore */
      }
    } else if (message.startsWith('__MUSE_PING__ ')) {
      const now = Date.now();
      if (now - lastPingLog > 30000) {
        lastPingLog = now;
        dbg(`ping(${account.id}): ` + message.slice('__MUSE_PING__ '.length));
      }
    }
  });

  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript(NOTIFY_HOOK_JS)
      .then((v) => dbg(`inject(${account.id}) result: ` + v))
      .catch((e) => dbg(`inject(${account.id}) error: ` + (e && e.message)));
  });

  win.on('focus', () => {
    win.flashFrame(false);
    lastActiveAccountId = account.id;
  });

  // Links and popups. Connector sign-in starts with a window.open() call
  // (disposition "new-window") whose first hop is each provider's own
  // authorize domain, so host/feature allowlists miss it; denying it makes
  // Muse report that the link page could not be opened, and sending it to
  // the external browser breaks the sign-in handshake. Keep every
  // window.open() in-app with the account's session. Plain target=_blank
  // link clicks (foreground/background tab) still go to the browser.
  const handleWindowOpen = (details) => {
    const { url } = details;
    const features = details.features || [];
    const isWindowOpenCall = details.disposition === 'new-window';
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      /* ignore */
    }
    const isAuthHost = AUTH_HOSTS.some((h) => hostMatches(host, h));
    // Connector sign-in opens about:blank first (as a plain foreground-tab
    // open, no features) and navigates it to the provider afterwards.
    // Denying that placeholder makes Muse report the link could not be
    // opened, so blank opens always stay in-app.
    const isBlank = /^about:blank/i.test(url || '');
    plog(
      `open(${account.id}): url=${url} disposition=${details.disposition} features=[${features.join(',')}] ` +
        `internal=${isInternalUrl(url)} windowOpen=${isWindowOpenCall} authHost=${isAuthHost} blank=${isBlank}`
    );
    if (isInternalUrl(url) || isWindowOpenCall || features.length > 0 || isAuthHost || isBlank) {
      const popupPrefs = { contextIsolation: true, nodeIntegration: false, sandbox: true };
      if (account.partition) popupPrefs.partition = account.partition;
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 760,
          icon: ICON_PATH,
          autoHideMenuBar: true,
          webPreferences: popupPrefs,
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  };
  // Attach recursively so popups opened from inside a popup (multi-step
  // sign-in flows) get the same routing.
  const attachOpenHandler = (wc) => {
    wc.setWindowOpenHandler(handleWindowOpen);
    wc.on('did-create-window', (child) => {
      plog(`popup created (${account.id}): initial url=${child.webContents.getURL()}`);
      child.webContents.on('did-navigate', (_e, u) => plog(`popup navigate: ${u}`));
      child.webContents.on('did-fail-load', (_e, code, desc, u) =>
        plog(`popup fail-load: ${code} ${desc} ${u}`)
      );
      child.on('closed', () => plog(`popup closed (${account.id})`));
      attachOpenHandler(child.webContents);
    });
  };
  attachOpenHandler(win.webContents);

  win.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Simple offline / load-failure page with retry.
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted
    const html = `<!doctype html><meta charset="utf-8"><title>Muse</title>
      <body style="margin:0;height:100vh;display:grid;place-items:center;background:#17171a;color:#eee;font-family:Segoe UI,sans-serif">
      <div style="text-align:center"><h2>Museに接続できません</h2><p style="opacity:.7">${desc}</p>
      <button onclick="location.href='${START_URL}'" style="padding:8px 20px;font-size:15px;border-radius:8px;border:0;cursor:pointer">再読み込み</button></div>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  win.on('close', (event) => {
    saveWindowState(account.id);
    if (!isQuitting) {
      event.preventDefault();
      win.hide(); // keep running in the tray
    }
  });

  win.on('closed', () => {
    if (windows[account.id] === win) windows[account.id] = null;
  });

  saveAccountState();
}

function createTray() {
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Muse Desktop');

  buildTrayMenu = () =>
    Menu.buildFromTemplate([
      { label: 'Museを開く', click: () => showWindow() },
      { type: 'separator' },
      { label: 'アカウント', enabled: false },
      ...accounts.map((a) => ({
        label: `${a.label}を開く`,
        click: () => showWindow(a.id),
      })),
      {
        label: 'アカウントを追加…',
        click: () => addAccount(),
      },
      {
        label: '再読み込み',
        click: () => {
          const w = focusedOrActiveWindow();
          if (w) w.webContents.reload();
        },
      },
      {
        label: 'ショートカット一覧',
        click: () => toggleShortcutPopup(),
      },
      {
        label: '通知テスト',
        click: () => {
          lastNotifyByAccount[lastActiveAccountId] = 0;
          try {
            const n = new Notification({
              title: 'Muse Desktop',
              body: '通知テストです。これが見えれば通知の表示経路は正常です。',
              icon: ICON_PATH,
            });
            n.on('click', () => showWindow());
            n.show();
          } catch {
            /* ignore */
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Windows起動時に自動起動',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      { label: `バージョン ${app.getVersion()}`, enabled: false },
      {
        label: '終了',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
}

function setupSession(ses) {

  // Present as plain Chrome so the site doesn't treat us as an unsupported embed.
  const ua = ses
    .getUserAgent()
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(new RegExp('\\s' + app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\/[\\d.]+'), '');
  ses.setUserAgent(ua);

  // Allow only what Muse legitimately needs (voice mode, notifications, clipboard),
  // and only for muse.ai itself.
  const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    let host = '';
    try {
      host = new URL(details.requestingUrl || wc.getURL()).hostname;
    } catch {
      /* ignore */
    }
    callback(allowed.has(permission) && hostMatches(host, 'muse.ai'));
  });
}

// ---- App lifecycle ---------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    dbg('app ready (v3.6.3 multi-account)');
    loadAccounts();
    saveAccounts();
    loadAccountState();
    loadWindowStates();
    setupSession(session.defaultSession);
    for (const a of accounts) {
      if (a.partition) setupSession(session.fromPartition(a.partition));
    }
    // Restore the windows that were open last time (main only by default).
    for (const id of openAccounts) createWindow(id);
    if (windows[lastActiveAccountId]) showWindow(lastActiveAccountId);
    createTray();
    createAppMenu();
    setupAutoUpdate();

    if (!globalShortcut.register(HOTKEY, toggleWindow)) {
      console.warn(`Could not register hotkey ${HOTKEY} (already in use?)`);
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    for (const a of accounts) saveWindowState(a.id);
    saveAccountState();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Stay alive in the tray when all windows are hidden/closed.
  app.on('window-all-closed', () => {});
}
