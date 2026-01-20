const { app, BrowserWindow, clipboard, screen, globalShortcut, ipcMain, desktopCapturer, Tray, Menu, nativeImage, dialog, shell, net } = require('electron');

app.disableHardwareAcceleration();

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const os = require('os');

// 系统路径定义
const SYSTEM32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
const POWERSHELL_EXE = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const isPackaged = app.isPackaged;
const RESOURCE_PATH = isPackaged ? process.resourcesPath : __dirname;

// 🛡️ 崩溃日志
const crashLogPath = path.join(os.homedir(), 'Desktop', 'deepseek_crash_log.txt');
function logError(msg) {
    try { fs.appendFileSync(crashLogPath, `[${new Date().toLocaleTimeString()}] ${msg}\n`); } catch(e){}
}
process.on('uncaughtException', (error) => {
    logError(`💥 致命崩溃: ${error.stack || error}`);
});

// 🔄 自动更新逻辑
let lastCheckTime = 0;
let isChecking = false;
let hasIgnoredUpdate = false; 

function checkUpdate() {
    if (hasIgnoredUpdate) return;
    const now = Date.now();
    if (isChecking) return;
    if (now - lastCheckTime < 1000 * 60 * 30) return; // 30分钟冷却

    isChecking = true;
    lastCheckTime = now;

    // GitHub API 地址
    const updateUrl = 'https://api.github.com/repos/Never-lose/deepseek-translator/releases/latest';
    const request = net.request(updateUrl);
    
    request.on('response', (response) => {
        let body = '';
        response.on('data', (chunk) => body += chunk);
        
        response.on('end', () => {
            isChecking = false;
            if (response.statusCode === 200) {
                try {
                    const data = JSON.parse(body);
                    const latestVersion = data.tag_name.replace('v', '');
                    const currentVersion = app.getVersion();

                    if (latestVersion > currentVersion) {
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '发现新版本',
                            message: `🎉 发现新版本 v${latestVersion}，是否去下载？`,
                            detail: `当前版本: v${currentVersion}\n\n更新内容:\n${data.body}`,
                            buttons: ['🚀 去下载', '🙈 本次不再提醒'], 
                            defaultId: 0,
                            cancelId: 1 
                        }).then(({ response }) => {
                            if (response === 0) {
                                shell.openExternal(data.html_url);
                            } else {
                                hasIgnoredUpdate = true; 
                            }
                        });
                    }
                } catch (e) { console.error("版本解析失败"); }
            }
        });
    });
    
    request.on('error', () => { isChecking = false; });
    request.end();
}

//  剪贴板复制触发
function triggerCopy() {
    // 优先尝试 PowerShell
    const ps = spawn(POWERSHELL_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')`
    ], { cwd: os.tmpdir() });

    ps.on('error', () => runVbsFallback());
    ps.on('close', (code) => { if (code !== 0) runVbsFallback(); });

    // 失败回退 VBS
    const runVbsFallback = () => {
        const vbsPath = path.join(RESOURCE_PATH, 'copy.vbs');
        if (fs.existsSync(vbsPath)) {
            execFile('cscript', ['//Nologo', vbsPath], { cwd: RESOURCE_PATH }, () => {});
        }
    };
}

let mainWindow, dashboardWindow, screenshotWindow, settingsWindow;
let isPinned = true; 
let tray = null;
let ocrWorker = null; 
let lastShotBounds = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); } else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

const USER_DATA_PATH = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const SAFE_MODEL_DIR = path.join(USER_DATA_PATH, 'tessdata_safe');
const SAFE_MODEL_FILE = path.join(SAFE_MODEL_DIR, 'eng.traineddata');
const ICON_PATH = path.join(__dirname, 'build', 'icon.ico'); 

function findAndCopyModel() {
    if (fs.existsSync(SAFE_MODEL_FILE)) return true;
    const potentialPaths = [
        path.join(process.resourcesPath, 'tessdata', 'eng.traineddata'),
        path.join(__dirname, 'tessdata', 'eng.traineddata'),
        path.join(process.cwd(), 'tessdata', 'eng.traineddata')
    ];
    let foundPath = potentialPaths.find(p => fs.existsSync(p));
    if (!foundPath) return false;
    try {
        if (!fs.existsSync(SAFE_MODEL_DIR)) fs.mkdirSync(SAFE_MODEL_DIR, { recursive: true });
        fs.copyFileSync(foundPath, SAFE_MODEL_FILE);
        return true;
    } catch (e) { return false; }
}

async function initOcrEngine() {
    if (ocrWorker) return; 
    if (!findAndCopyModel()) return; 
    try {
        ocrWorker = await Tesseract.createWorker('eng', 1, {
            langPath: SAFE_MODEL_DIR, cachePath: SAFE_MODEL_DIR, gzip: false, logger: m => {} 
        });
    } catch (e) {}
}

if (!fs.existsSync(USER_DATA_PATH)) { fs.mkdirSync(USER_DATA_PATH, { recursive: true }); }
ipcMain.on('get-user-data-path', (event) => { event.returnValue = USER_DATA_PATH; });

function loadConfig() {
    try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) {}
    return { engine: "google", apiKey: "", shortcutTranslate: "Ctrl+Q", shortcutOcr: "Ctrl+Alt+Q", autoLaunch: false, theme: "light" };
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 340, height: 200, 
        frame: false, 
        alwaysOnTop: true, 
        resizable: false, 
        skipTaskbar: true,
        transparent: true, 
        backgroundColor: '#00000000', // 全透明背景
        hasShadow: false, 
        movable: true,
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
        show: false
    });
    
    
    // mainWindow.setContentProtection(true); 

    mainWindow.loadFile('index.html');
    mainWindow.setAlwaysOnTop(isPinned, 'screen-saver');
    mainWindow.webContents.on('render-process-gone', () => { mainWindow = null; createMainWindow(); });
}

function createTray() {
    try {
        const image = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : null;
        if(image) {
            tray = new Tray(image);
            tray.setToolTip('AI 翻译助手');
            const contextMenu = Menu.buildFromTemplate([
                { label: '📊 打开单词复习本', click: () => createDashboardWindow() },
                { label: '⚙️ 设置', click: () => createSettingsWindow() },
                { type: 'separator' }, 
                { label: '❌ 退出程序', click: () => { if (tray) tray.destroy(); app.quit(); } }
            ]);
            tray.setContextMenu(contextMenu);
            tray.on('click', () => createSettingsWindow());
        }
    } catch (e) {}
}

ipcMain.on('toggle-pin', (event, pinned) => {
    isPinned = pinned;
    try {
        const config = loadConfig();
        config.isPinned = pinned;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {}
    if (mainWindow) mainWindow.setAlwaysOnTop(pinned, 'screen-saver');
});

ipcMain.on('save-theme', (event, theme) => {
    const config = loadConfig();
    config.theme = theme;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    [mainWindow, settingsWindow, dashboardWindow].forEach(win => {
        if (win && !win.isDestroyed()) win.webContents.send('theme-changed', theme);
    });
});

ipcMain.on('data-updated', () => { if (dashboardWindow) dashboardWindow.webContents.send('refresh-data'); });

ipcMain.on('resize-main-window', (event, contentHeight) => {
    if (mainWindow) {
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
        const workArea = display.workArea;
        const width = 340;
        const newHeight = parseInt(contentHeight);
        const currentCenterY = bounds.y + (bounds.height / 2);
        let newY = Math.round(currentCenterY - (newHeight / 2));
        if (newY < workArea.y) newY = workArea.y + 10; 
        if (newY + newHeight > workArea.y + workArea.height) newY = workArea.y + workArea.height - newHeight - 10; 
        mainWindow.setBounds({ x: bounds.x, y: newY, width, height: newHeight });
    }
});

function createDashboardWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.focus(); return; }
    dashboardWindow = new BrowserWindow({
        width: 1200, height: 800, title: "单词统计", autoHideMenuBar: true,
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        show: false 
    });
    dashboardWindow.maximize(); 
    dashboardWindow.loadFile('dashboard.html');
    dashboardWindow.once('ready-to-show', () => { dashboardWindow.show(); });
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 400, height: 580, title: "设置", autoHideMenuBar: true, resizable: false, 
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile('settings.html');
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.on('resize-settings-window', (event, contentHeight) => {
    if (settingsWindow) settingsWindow.setContentSize(400, contentHeight);
});

function updateAutoLaunch(isEnabled) {
    if (!app.isPackaged) return;
    app.setLoginItemSettings({ openAtLogin: isEnabled, openAsHidden: false, path: app.getPath('exe') });
}

function applyConfig() {
    globalShortcut.unregisterAll();
    const config = loadConfig();
    updateAutoLaunch(config.autoLaunch);

    if (config.shortcutTranslate) {
        globalShortcut.register(config.shortcutTranslate, () => {
            clipboard.clear();
            triggerCopy();
            let attempts = 0;
            const checkTimer = setInterval(() => {
                attempts++;
                const text = clipboard.readText().trim();
                if (text && text.length > 0) { 
                    clearInterval(checkTimer); 
                    showWindowAndTranslate(text); 
                }
                if (attempts >= 40) clearInterval(checkTimer); 
            }, 50);
        });
    }
    if (config.shortcutOcr) {
        globalShortcut.register(config.shortcutOcr, () => startScreenshot());
    }
}

app.whenReady().then(async () => { 
    createMainWindow(); 
    createTray(); 
    applyConfig();
    setTimeout(() => checkUpdate(), 30000);
    setTimeout(() => initOcrEngine(), 1000);
});

ipcMain.on('settings-updated', () => { 
    applyConfig(); 
    if (mainWindow) mainWindow.webContents.send('config-updated'); 
});

async function startScreenshot() {
  try {
    if (screenshotWindow) { try { screenshotWindow.close(); } catch (e) {} screenshotWindow = null; }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const displayPixelW = Math.floor(currentDisplay.bounds.width * currentDisplay.scaleFactor);
    const displayPixelH = Math.floor(currentDisplay.bounds.height * currentDisplay.scaleFactor);
    let preferredSourceId = null;

    if (screen.getAllDisplays().length > 1) {
      const MARKER_SIZE = 22; 
      const markerHtml = `<!doctype html><html><body style="margin:0;background:#ff00ff;"></body></html>`;
      let markerWin = null;
      try {
        markerWin = new BrowserWindow({
          x: Math.round(cursorPoint.x - MARKER_SIZE / 2),
          y: Math.round(cursorPoint.y - MARKER_SIZE / 2),
          width: MARKER_SIZE, height: MARKER_SIZE,
          frame: false, transparent: false, backgroundColor: '#ff00ff',
          alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, focusable: false, hasShadow: false, show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        markerWin.setIgnoreMouseEvents(true);
        markerWin.setAlwaysOnTop(true, 'screen-saver');
        await markerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markerHtml));
        if (typeof markerWin.showInactive === 'function') markerWin.showInactive(); else markerWin.show();
        await sleep(80);
        const probeSources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 420, height: 420 } });
        const localDipX = cursorPoint.x - currentDisplay.bounds.x;
        const localDipY = cursorPoint.y - currentDisplay.bounds.y;
        const localPxX = Math.round(localDipX * currentDisplay.scaleFactor);
        const localPxY = Math.round(localDipY * currentDisplay.scaleFactor);
        const isMarkerPixel = (buf, idx) => {
          const c0 = buf[idx]; const c1 = buf[idx + 1]; const c2 = buf[idx + 2];
          return c1 < 80 && c0 > 220 && c2 > 220;
        };
        for (const s of probeSources) {
          const thumb = s.thumbnail;
          const { width: tw, height: th } = thumb.getSize();
          if (!tw || !th) continue;
          let tx = Math.round((localPxX / displayPixelW) * tw);
          let ty = Math.round((localPxY / displayPixelH) * th);
          tx = Math.max(0, Math.min(tw - 1, tx)); ty = Math.max(0, Math.min(th - 1, ty));
          const buf = thumb.toBitmap();
          let hits = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = Math.max(0, Math.min(tw - 1, tx + dx));
              const y = Math.max(0, Math.min(th - 1, ty + dy));
              const idx = (y * tw + x) * 4;
              if (isMarkerPixel(buf, idx)) hits++;
            }
          }
          if (hits >= 3) { preferredSourceId = s.id; break; }
        }
      } catch (e) { } finally {
        if (markerWin && !markerWin.isDestroyed()) { try { markerWin.hide(); markerWin.close(); } catch (e) {} }
        await sleep(80);
      }
    }

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: displayPixelW, height: displayPixelH } });
    let targetSource = sources.find(s => s.id === preferredSourceId) || sources.find(s => s.display_id === String(currentDisplay.id)) || sources.find(s => s.display_id === String(currentDisplay.id >>> 0)) || sources[0];
    const imageDataURL = targetSource.thumbnail.toDataURL();

    screenshotWindow = new BrowserWindow({
      x: currentDisplay.bounds.x, y: currentDisplay.bounds.y,
      width: currentDisplay.bounds.width, height: currentDisplay.bounds.height,
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, enableLargerThanScreen: true, hasShadow: false, show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    lastShotBounds = { ...currentDisplay.bounds };
    screenshotWindow.setAlwaysOnTop(true, 'screen-saver');
    screenshotWindow.moveTop();
    screenshotWindow.setBounds(lastShotBounds, false);
    screenshotWindow.loadFile('screenshot.html');
    screenshotWindow.webContents.once('did-finish-load', () => {
      screenshotWindow.webContents.send('SET_SOURCE', { imageDataURL, display: { id: currentDisplay.id, bounds: currentDisplay.bounds, scaleFactor: currentDisplay.scaleFactor }, sourceId: targetSource.id });
    });
  } catch (e) { 
      if (mainWindow) mainWindow.webContents.send('ocr-error', "截图错误: " + e.message); 
  }
}

ipcMain.on('screenshot-ready', () => {
  if (!screenshotWindow) return;
  if (lastShotBounds) screenshotWindow.setBounds(lastShotBounds, false);
  screenshotWindow.setAlwaysOnTop(true, 'screen-saver');
  screenshotWindow.moveTop();
  screenshotWindow.show();
  screenshotWindow.focus();
});

ipcMain.on('close-screenshot', () => { if (screenshotWindow) { screenshotWindow.close(); screenshotWindow = null; } });
ipcMain.on('screenshot-captured', async (event, dataURL) => {
    if (screenshotWindow) { screenshotWindow.close(); screenshotWindow = null; }
    showWindowAndTranslate("", true); 
    mainWindow.webContents.send('ocr-loading');
    if (!ocrWorker) await initOcrEngine();
    if (!ocrWorker) { mainWindow.webContents.send('ocr-error', "引擎启动失败"); return; }
    const base64Data = dataURL.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');
    try {
        const { data: { text } } = await ocrWorker.recognize(imageBuffer);
        const cleanText = text.trim();
        if (!cleanText) mainWindow.webContents.send('ocr-error', "未识别到文字");
        else mainWindow.webContents.send('start-translation', cleanText);
    } catch (err) { mainWindow.webContents.send('ocr-error', err.message); }
});

function showWindowAndTranslate(text, isOcr = false) {
    if (text.length > 3000) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;
    const width = 340; const height = 180; 
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + (workArea.height - height) / 2);
    isPinned = true;
    mainWindow.setBounds({ x, y, width, height });
    mainWindow.setAlwaysOnTop(isPinned, 'screen-saver');
    mainWindow.show();
    mainWindow.focus(); 
    if(!isOcr && text) mainWindow.webContents.send('start-translation', text);
    checkUpdate();
}

ipcMain.on('open-dashboard', () => { createDashboardWindow();  });
ipcMain.on('open-settings', () => { createSettingsWindow();  });
ipcMain.on('hide-window', () => mainWindow.hide());
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrWorker) ocrWorker.terminate(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });