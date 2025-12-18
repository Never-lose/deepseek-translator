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
    // 先拿当前鼠标所在显示器
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

    // ✅ 按“像素分辨率”请求缩略图（其实就是截图），清晰度直接拉满
    const thumbW = Math.floor(currentDisplay.bounds.width * currentDisplay.scaleFactor);
    const thumbH = Math.floor(currentDisplay.bounds.height * currentDisplay.scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbW, height: thumbH },
    });

    // ✅ 显示器 id 在 Windows 上可能出现 signed/unsigned 差异：统一按 uint32 比较更稳
    const curU32 = currentDisplay.id >>> 0;

    let targetSource =
      sources.find(s => {
        const sid = Number(s.display_id);
        return !Number.isNaN(sid) && ((sid >>> 0) === curU32);
      }) ||
      sources.find(s => s.display_id === String(curU32) || s.display_id === String(currentDisplay.id)) ||
      sources[0];

    // 先把截图 dataURL 准备好（用 thumbnail，而不是 getUserMedia）
    const imageDataURL = targetSource.thumbnail.toDataURL();

    // ✅ 创建窗口建议 show:false，等背景画好再 show（你现在已有 screenshot-ready 来 show）
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
    // 记录本次截图应该覆盖的区域（很关键：ready 时再贴一遍）
    lastShotBounds = { ...currentDisplay.bounds };


    screenshotWindow.setAlwaysOnTop(true, 'screen-saver');
    screenshotWindow.moveTop();


    screenshotWindow.setBounds(lastShotBounds, false);


    screenshotWindow.loadFile('screenshot.html');

    screenshotWindow.webContents.on('did-finish-load', () => {
      // ✅ 不再传 sourceId 字符串，而是把截图图传过去
      screenshotWindow.webContents.send('SET_SOURCE', {
        imageDataURL,
        // 下面这些是可选：你要做更严谨的缩放/调试就用
        display: {
          id: currentDisplay.id,
          bounds: currentDisplay.bounds,
          scaleFactor: currentDisplay.scaleFactor
        },
        // 备用：如果你想保留旧方案可用
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