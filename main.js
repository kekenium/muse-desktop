// Unofficial desktop wrapper for Muse (https://muse.ai/)
// Features: persistent login, window-state memory, tray icon, global hotkey,
// optional start-with-Windows, single instance, external links in default browser,
// dual windows: main and sub accounts can be open at the same time, each in
// its own window with its own persistent session (v3.5).

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

// Accounts. Each account keeps its own persistent session (cookies / login)
// and its own window; both windows can be open at the same time. 'main' uses
// the default session so the login that already exists is preserved; 'sub'
// gets its own partition.
const ACCOUNTS = [
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

const windows = { main: null, sub: null };
let lastActiveAccountId = 'main';
let openAccounts = ['main'];
let windowStates = {};
let buildTrayMenu = () => Menu.buildFromTemplate([]);

function accountFor(id) {
  return ACCOUNTS.find((a) => a.id === id) || ACCOUNTS[0];
}

function loadAccountState() {
  try {
    const s = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (Array.isArray(s.open)) {
      const valid = s.open.filter((id) => ACCOUNTS.some((a) => a.id === id));
      if (valid.length) openAccounts = valid;
    } else if (ACCOUNTS.some((a) => a.id === s.current)) {
      // v3.4 format: { current: '<id>' }
      openAccounts = [s.current];
    }
    if (ACCOUNTS.some((a) => a.id === s.lastActive)) lastActiveAccountId = s.lastActive;
    else if (ACCOUNTS.some((a) => a.id === s.current)) lastActiveAccountId = s.current;
  } catch {
    /* no saved state yet: defaults (main only) */
  }
  if (!openAccounts.includes(lastActiveAccountId)) lastActiveAccountId = openAccounts[0];
}

function saveAccountState() {
  const open = ACCOUNTS.map((a) => a.id).filter((id) => {
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
    if (s && (s.main || s.sub)) {
      windowStates = s;
    } else if (s && typeof s.width === 'number') {
      // v3.4 format: flat bounds for the single window -> main's bounds.
      windowStates = { main: s };
    }
  } catch {
    windowStates = {};
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
    b.x = base.x + 40;
    b.y = base.y + 40;
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

function createAppMenu() {
  const template = [
    {
      label: 'アカウント',
      submenu: ACCOUNTS.map((a, i) => ({
        label: `${a.label}を開く`,
        accelerator: `Control+Shift+${i + 1}`,
        click: () => showWindow(a.id),
      })),
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

  // Links: keep trusted hosts in-app, send everything else to the browser.
  // Popups inherit the account's session so login flows stay in-account.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
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
  });

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
      ...ACCOUNTS.map((a) => ({
        label: `${a.label}を開く`,
        click: () => showWindow(a.id),
      })),
      {
        label: '再読み込み',
        click: () => {
          const w = focusedOrActiveWindow();
          if (w) w.webContents.reload();
        },
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
    dbg('app ready (v3.5 dual window)');
    loadAccountState();
    loadWindowStates();
    setupSession(session.defaultSession);
    for (const a of ACCOUNTS) {
      if (a.partition) setupSession(session.fromPartition(a.partition));
    }
    // Restore the windows that were open last time (main only by default).
    for (const id of openAccounts) createWindow(id);
    if (windows[lastActiveAccountId]) showWindow(lastActiveAccountId);
    createTray();
    createAppMenu();

    if (!globalShortcut.register(HOTKEY, toggleWindow)) {
      console.warn(`Could not register hotkey ${HOTKEY} (already in use?)`);
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    for (const a of ACCOUNTS) saveWindowState(a.id);
    saveAccountState();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Stay alive in the tray when all windows are hidden/closed.
  app.on('window-all-closed', () => {});
}
