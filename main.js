const { app, BrowserWindow, clipboard, screen, globalShortcut, ipcMain, desktopCapturer, Tray, Menu, nativeImage, dialog } = require('electron');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js');
const os = require('os');

// 🛡️ 崩溃日志
const crashLogPath = path.join(os.homedir(), 'Desktop', 'deepseek_crash_log.txt');
function logError(msg) {
    try { fs.appendFileSync(crashLogPath, `[${new Date().toLocaleTimeString()}] ${msg}\n`); } catch(e){}
}
process.on('uncaughtException', (error) => {
    logError(`💥 致命崩溃: ${error.stack || error}`);
});

let mainWindow, dashboardWindow, screenshotWindow, settingsWindow;
let isPinned = false; 
let tray = null;
let ocrWorker = null; 
let lastShotBounds = null;

// 单例锁
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
    return { engine: "google", apiKey: "", shortcutTranslate: "Ctrl+Q", shortcutOcr: "Ctrl+Alt+Q", autoLaunch: false, enableCodeMode: true, enableCodeExplain: true, darkMode: false };
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 340, height: 200, 
        frame: false, 
        alwaysOnTop: true, 
        resizable: false, 
        skipTaskbar: true,
        transparent: true, 
        backgroundColor: '#00000000', 
        hasShadow: false, 
        movable: true, // 允许拖动
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
        show: false
    });
    mainWindow.loadFile('index.html');
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
    if (mainWindow) mainWindow.setAlwaysOnTop(true, 'screen-saver');
});

ipcMain.on('save-dark-mode', (event, isDark) => {
    const config = loadConfig();
    config.darkMode = isDark;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('theme-changed', isDark);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('theme-changed', isDark);
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send('theme-changed', isDark);
});

ipcMain.on('data-updated', () => { if (dashboardWindow) dashboardWindow.webContents.send('refresh-data'); });

// 窗口智能伸缩
ipcMain.on('resize-main-window', (event, contentHeight) => {
    if (mainWindow) {
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
        const workArea = display.workArea;

        const width = 340;
        const newHeight = parseInt(contentHeight);

        // 以当前位置为中心伸缩
        const currentCenterY = bounds.y + (bounds.height / 2);
        let newY = Math.round(currentCenterY - (newHeight / 2));

        if (newY < workArea.y) newY = workArea.y + 10; 
        if (newY + newHeight > workArea.y + workArea.height) {
            newY = workArea.y + workArea.height - newHeight - 10; 
        }

        mainWindow.setBounds({ x: bounds.x, y: newY, width, height: newHeight });
    }
});

function createDashboardWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) { dashboardWindow.focus(); return; }
    dashboardWindow = new BrowserWindow({
        width: 900, height: 600, title: "单词统计", autoHideMenuBar: true, 
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    dashboardWindow.loadFile('dashboard.html');
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

function createSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 400, 
        height: 580, // 限制初始高度
        title: "设置", 
        autoHideMenuBar: true, 
        resizable: false, 
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : null,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile('settings.html');
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.on('resize-settings-window', (event, contentHeight) => {
    if (settingsWindow) settingsWindow.setContentSize(400, contentHeight);
});

function triggerCopy() {
    const psCommand = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c');`;
    const ps = spawn('powershell', ['-NoProfile', '-Command', psCommand]);
    ps.on('error', () => {
        const vbsPath = path.join(__dirname, 'copy.vbs');
        execFile('cscript', ['//Nologo', vbsPath], () => {});
    });
}

// 💎 核心补全：开机自启逻辑
function updateAutoLaunch(isEnabled) {
    // 只有打包后的 exe 才真正执行注册表操作，避免开发时每次都弹窗
    if (!app.isPackaged) {
        console.log('Dev Mode: Auto launch set to', isEnabled);
        return;
    }
    
    app.setLoginItemSettings({
        openAtLogin: isEnabled,
        openAsHidden: false, // 设为 false 确保托盘能出来
        path: app.getPath('exe')
    });
}

function applyConfig() {
    globalShortcut.unregisterAll();
    const config = loadConfig();
    
    // 💎 应用开机自启配置
    updateAutoLaunch(config.autoLaunch);

    try {
        globalShortcut.register(config.shortcutTranslate, () => {
            clipboard.clear();
            triggerCopy();
            let attempts = 0;
            const checkTimer = setInterval(() => {
                attempts++;
                const text = clipboard.readText().trim();
                if (text && text.length > 0) { clearInterval(checkTimer); showWindowAndTranslate(text); }
                if (attempts >= 20) clearInterval(checkTimer);
            }, 50);
        });
        globalShortcut.register(config.shortcutOcr, () => startScreenshot());
    } catch (e) {}
}

app.whenReady().then(async () => { 
    createMainWindow(); 
    createTray(); 
    applyConfig();
    setTimeout(() => initOcrEngine(), 1000);
});

ipcMain.on('settings-updated', () => { applyConfig(); if (mainWindow) mainWindow.webContents.send('config-updated'); });

async function startScreenshot() {
  try {
    // 如果上一次截图窗口还没关，先关掉，避免叠层/焦点异常
    if (screenshotWindow) {
      try { screenshotWindow.close(); } catch (e) {}
      screenshotWindow = null;
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // 先拿当前鼠标所在显示器
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

    // 当前显示器的“真实像素尺寸”
    const displayPixelW = Math.floor(currentDisplay.bounds.width * currentDisplay.scaleFactor);
    const displayPixelH = Math.floor(currentDisplay.bounds.height * currentDisplay.scaleFactor);

    /**
     * 关键修复点：
     * 某些电脑上 desktopCapturer 返回的 display_id 和 screen 模块的 display.id 映射会互换，
     * 导致“主屏拿到副屏画面、副屏拿到主屏画面”。
     *
     * 这里用一个短暂显示的“洋红色探针”在鼠标位置打点：
     * - 抓一张小缩略图
     * - 在每个 source 的缩略图中，去鼠标对应位置采样像素颜色
     * - 哪个 source 在该点命中洋红色，就说明它才是真正的当前屏幕
     */
    let preferredSourceId = null;

    if (screen.getAllDisplays().length > 1) {
      const MARKER_SIZE = 22; // 探针方块大小（DIP，不是像素）
      const markerHtml = `<!doctype html><html><body style="margin:0;background:#ff00ff;"></body></html>`;
      let markerWin = null;

      try {
        markerWin = new BrowserWindow({
          x: Math.round(cursorPoint.x - MARKER_SIZE / 2),
          y: Math.round(cursorPoint.y - MARKER_SIZE / 2),
          width: MARKER_SIZE,
          height: MARKER_SIZE,
          frame: false,
          transparent: false,
          backgroundColor: '#ff00ff',
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: false,
          movable: false,
          focusable: false,
          hasShadow: false,
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        });

        // 不要挡鼠标事件（即使极端情况下探针没及时消失，也不影响操作）
        markerWin.setIgnoreMouseEvents(true);
        markerWin.setAlwaysOnTop(true, 'screen-saver');

        await markerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markerHtml));

        // showInactive 更不抢焦点；没有这个方法就用 show()
        if (typeof markerWin.showInactive === 'function') markerWin.showInactive();
        else markerWin.show();

        // 等一小会儿，确保探针真的画到屏幕上了
        await sleep(80);

        // 抓一张“小缩略图”即可（用来探测，不用高清）
        const probeSources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 420, height: 420 },
        });

        // 鼠标在当前显示器内的相对位置（先 DIP -> 再转像素）
        const localDipX = cursorPoint.x - currentDisplay.bounds.x;
        const localDipY = cursorPoint.y - currentDisplay.bounds.y;
        const localPxX = Math.round(localDipX * currentDisplay.scaleFactor);
        const localPxY = Math.round(localDipY * currentDisplay.scaleFactor);

        // 判断是否“洋红色像素”：R/B 高、G 低（BGRA 或 RGBA 都能判）
        const isMarkerPixel = (buf, idx) => {
          const c0 = buf[idx];
          const c1 = buf[idx + 1];
          const c2 = buf[idx + 2];
          return c1 < 80 && c0 > 220 && c2 > 220;
        };

        for (const s of probeSources) {
          const thumb = s.thumbnail;
          const { width: tw, height: th } = thumb.getSize();
          if (!tw || !th) continue;

          // 把“当前显示器的鼠标像素坐标”映射到这个缩略图坐标
          let tx = Math.round((localPxX / displayPixelW) * tw);
          let ty = Math.round((localPxY / displayPixelH) * th);
          tx = Math.max(0, Math.min(tw - 1, tx));
          ty = Math.max(0, Math.min(th - 1, ty));

          const buf = thumb.toBitmap();

          // 采样 3x3，避免缩放插值导致“中心点刚好没命中”
          let hits = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = Math.max(0, Math.min(tw - 1, tx + dx));
              const y = Math.max(0, Math.min(th - 1, ty + dy));
              const idx = (y * tw + x) * 4;
              if (isMarkerPixel(buf, idx)) hits++;
            }
          }

          if (hits >= 3) {
            preferredSourceId = s.id; // ✅ 找到了真正对应当前屏幕的 source
            break;
          }
        }
      } catch (e) {
        // 探针探测失败就忽略，走后备逻辑
      } finally {
        // 关掉探针，避免出现在最终截图里
        if (markerWin && !markerWin.isDestroyed()) {
          try { markerWin.hide(); } catch (e) {}
          try { markerWin.close(); } catch (e) {}
        }
        await sleep(80);
      }
    }

    // 现在抓最终“高清图”（仍然只需要当前屏幕像素大小）
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: displayPixelW, height: displayPixelH },
    });

    let targetSource = null;

    // ✅ 优先用探针锁定到的 source.id（最可靠，解决你说的互换问题）
    if (preferredSourceId) {
      targetSource = sources.find(s => s.id === preferredSourceId) || null;
    }

    // 后备：保留你原来的 display_id 匹配（探针失败时才用）
    if (!targetSource) {
      const curU32 = currentDisplay.id >>> 0;
      targetSource =
        sources.find(s => {
          const sid = Number(s.display_id);
          return !Number.isNaN(sid) && ((sid >>> 0) === curU32);
        }) ||
        sources.find(s => s.display_id === String(curU32) || s.display_id === String(currentDisplay.id)) ||
        sources[0];
    }

    // 把截图 dataURL 准备好（用 thumbnail，而不是 getUserMedia）
    const imageDataURL = targetSource.thumbnail.toDataURL();

    // 创建截图窗口（覆盖当前显示器）
    screenshotWindow = new BrowserWindow({
      x: currentDisplay.bounds.x,
      y: currentDisplay.bounds.y,
      width: currentDisplay.bounds.width,
      height: currentDisplay.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      enableLargerThanScreen: true,
      hasShadow: false,
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    // 记录本次截图应该覆盖的区域（ready 时再贴一遍）
    lastShotBounds = { ...currentDisplay.bounds };

    screenshotWindow.setAlwaysOnTop(true, 'screen-saver');
    screenshotWindow.moveTop();
    screenshotWindow.setBounds(lastShotBounds, false);

    screenshotWindow.loadFile('screenshot.html');

    screenshotWindow.webContents.once('did-finish-load', () => {
      screenshotWindow.webContents.send('SET_SOURCE', {
        imageDataURL,
        display: {
          id: currentDisplay.id,
          bounds: currentDisplay.bounds,
          scaleFactor: currentDisplay.scaleFactor
        },
        sourceId: targetSource.id
      });
    });

  } catch (e) {
    console.error("启动截图失败:", e);
    if (mainWindow) mainWindow.webContents.send('ocr-error', "截图错误: " + e.message);
  }
}


ipcMain.on('screenshot-ready', () => {
  if (!screenshotWindow) return;

  // ✅ ready 时再贴一次，解决“切主副屏/混合 DPI”导致的覆盖不全
  if (lastShotBounds) screenshotWindow.setBounds(lastShotBounds, false);

  // ✅ 再把层级顶到最高，压过主任务栏（修复双任务栏/露底）
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
    } catch (err) { 
        mainWindow.webContents.send('ocr-error', err.message);
    }
});

function showWindowAndTranslate(text, isOcr = false) {
    if (text.length > 3000) return;
    
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const workArea = display.workArea;
    const width = 340;
    const height = 180; 

    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = Math.round(workArea.y + (workArea.height - height) / 2);

    mainWindow.setBounds({ x, y, width, height });
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus(); 
    
    if(!isOcr && text) mainWindow.webContents.send('start-translation', text);
}

ipcMain.on('open-dashboard', () => { createDashboardWindow(); mainWindow.hide(); });
ipcMain.on('open-settings', () => { createSettingsWindow(); mainWindow.hide(); });
ipcMain.on('hide-window', () => mainWindow.hide());
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ocrWorker) ocrWorker.terminate(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });