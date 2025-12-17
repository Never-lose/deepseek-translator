const { app, BrowserWindow, clipboard, screen, globalShortcut, ipcMain, desktopCapturer, Tray, Menu, nativeImage, dialog } = require('electron');
const { execFile } = require('child_process');
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
    dialog.showErrorBox("程序崩溃", `错误信息已保存到桌面日志。\n${error.message}`);
});

let mainWindow, dashboardWindow, screenshotWindow, settingsWindow;
let isPinned = true; 
let tray = null;
let ocrWorker = null; 

// 🛑 单例锁
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

// 路径猎人
function findAndCopyModel() {
    if (fs.existsSync(SAFE_MODEL_FILE)) return true;
    const potentialPaths = [
        path.join(process.resourcesPath, 'tessdata', 'eng.traineddata'),
        path.join(__dirname, 'tessdata', 'eng.traineddata'),
        path.join(app.getAppPath(), '..', 'tessdata', 'eng.traineddata'),
        path.join(process.cwd(), 'tessdata', 'eng.traineddata')
    ];
    let foundPath = null;
    for (const p of potentialPaths) {
        if (fs.existsSync(p)) { foundPath = p; break; }
    }
    if (!foundPath) return false;
    try {
        if (!fs.existsSync(SAFE_MODEL_DIR)) fs.mkdirSync(SAFE_MODEL_DIR, { recursive: true });
        fs.copyFileSync(foundPath, SAFE_MODEL_FILE);
        return true;
    } catch (e) { return false; }
}

async function initOcrEngine() {
    if (ocrWorker) return; 
    const ready = findAndCopyModel();
    if (!ready) return; 
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
    const { x, y } = screen.getCursorScreenPoint();
    mainWindow = new BrowserWindow({
        width: 320, height: 150, x: x, y: y,
        frame: false, 
        alwaysOnTop: true, 
        resizable: false, 
        skipTaskbar: true,
        // 💎 关键修改：开启透明背景！
        transparent: true, 
        backgroundColor: '#00000000', // 彻底透明
        icon: ICON_PATH,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        show: false
    });
    mainWindow.loadFile('index.html');
    // 去掉了 blur 隐藏逻辑，实现常驻
}

function createTray() {
    try {
        const image = nativeImage.createFromPath(ICON_PATH);
        tray = new Tray(image);
        tray.setToolTip('DeepSeek 翻译助手');
        const contextMenu = Menu.buildFromTemplate([
            { label: '📊 打开单词复习本', click: () => { createDashboardWindow(); } },
            { label: '⚙️ 设置', click: () => { createSettingsWindow(); } },
            { type: 'separator' }, 
            { label: '❌ 退出程序', click: () => { if (tray) tray.destroy(); app.quit(); } }
        ]);
        tray.setContextMenu(contextMenu);
        tray.on('click', () => createSettingsWindow());
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
    if(mainWindow) mainWindow.webContents.send('theme-changed', isDark);
    if(settingsWindow) settingsWindow.webContents.send('theme-changed', isDark);
    if(dashboardWindow) dashboardWindow.webContents.send('theme-changed', isDark);
});

// 核心联动：转发数据刷新信号
ipcMain.on('data-updated', () => {
    if (dashboardWindow) dashboardWindow.webContents.send('refresh-data');
});

ipcMain.on('resize-main-window', (event, contentHeight) => {
    if (mainWindow) {
        const bounds = mainWindow.getBounds();
        const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
        const workArea = display.workArea; 
        mainWindow.setSize(320, contentHeight);
        let newY = bounds.y;
        // 智能避让任务栏
        if (bounds.y + contentHeight > workArea.y + workArea.height) {
            newY = workArea.y + workArea.height - contentHeight - 10; 
            mainWindow.setPosition(bounds.x, newY);
        }
    }
});

function createDashboardWindow() {
    if (dashboardWindow) { dashboardWindow.focus(); return; }
    dashboardWindow = new BrowserWindow({
        width: 900, height: 600, title: "单词统计", autoHideMenuBar: true, icon: ICON_PATH,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    dashboardWindow.loadFile('dashboard.html');
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
}

function createSettingsWindow() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 400, height: 600, title: "设置", autoHideMenuBar: true, resizable: false, icon: ICON_PATH,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile('settings.html');
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

ipcMain.on('resize-settings-window', (event, contentHeight) => {
    if (settingsWindow) settingsWindow.setContentSize(400, contentHeight);
});

function triggerCopy() {
    const vbsPath = path.join(__dirname, 'copy.vbs');
    execFile('cscript', ['//Nologo', vbsPath], (error) => {});
}

function updateAutoLaunch(shouldLaunch) {
    app.setLoginItemSettings({ openAtLogin: shouldLaunch, openAsHidden: false, path: app.getPath('exe') });
}

function applyConfig() {
    globalShortcut.unregisterAll();
    const config = loadConfig();
    updateAutoLaunch(config.autoLaunch || false);
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
    } catch (e) {}
    try {
        globalShortcut.register(config.shortcutOcr, () => { startScreenshot(); });
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
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const primaryDisplay = screen.getPrimaryDisplay();
    const allDisplays = screen.getAllDisplays();
    let targetSource;
    if (currentDisplay.id === primaryDisplay.id) {
        targetSource = sources.find(s => s.id === 'screen:0:0') || sources[0];
    } else {
        const otherDisplays = allDisplays.filter(d => d.id !== primaryDisplay.id).sort((a, b) => a.bounds.x - b.bounds.x);
        const primarySource = sources.find(s => s.id === 'screen:0:0') || sources[0];
        const otherSources = sources.filter(s => s.id !== primarySource.id);
        const index = otherDisplays.findIndex(d => d.id === currentDisplay.id);
        targetSource = otherSources[index] || otherSources[0];
    }
    if (!targetSource) targetSource = sources[0];

    screenshotWindow = new BrowserWindow({
        x: currentDisplay.bounds.x, y: currentDisplay.bounds.y,
        width: currentDisplay.bounds.width, height: currentDisplay.bounds.height,
        fullscreen: true, frame: false, transparent: true, alwaysOnTop: true, 
        skipTaskbar: true, resizable: false, movable: false, enableLargerThanScreen: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    screenshotWindow.loadFile('screenshot.html');
    screenshotWindow.webContents.on('did-finish-load', () => {
        screenshotWindow.webContents.send('SET_SOURCE', targetSource.id);
    });
}
ipcMain.on('screenshot-ready', () => { if (screenshotWindow) { screenshotWindow.show(); screenshotWindow.focus(); } });
ipcMain.on('close-screenshot', () => { if (screenshotWindow) { screenshotWindow.close(); screenshotWindow = null; } });

ipcMain.on('screenshot-captured', async (event, dataURL) => {
    if (screenshotWindow) { screenshotWindow.close(); screenshotWindow = null; }
    showWindowAndSendEvent('ocr-loading');
    if (!ocrWorker) await initOcrEngine();
    if (!ocrWorker) {
         mainWindow.webContents.send('ocr-error', "引擎启动失败");
         return;
    }
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

function showWindowAndTranslate(text) {
    if (text.length > 3000) return;
    showWindowAndSendEvent('start-translation', text);
}
function showWindowAndSendEvent(eventName, arg) {
    const { x, y } = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint({ x, y });
    const workArea = display.workArea; 
    let currentH = mainWindow.getBounds().height || 200; 
    let newX = x + 20; 
    let newY = y + 20;
    if (newX + 320 > workArea.x + workArea.width) newX = x - 320;
    if (newY + currentH > workArea.y + workArea.height) newY = y - currentH;
    mainWindow.setPosition(newX, newY);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.focus(); 
    mainWindow.webContents.send(eventName, arg);
}
ipcMain.on('open-dashboard', () => { createDashboardWindow(); mainWindow.hide(); });
ipcMain.on('open-settings', () => { createSettingsWindow(); mainWindow.hide(); });
ipcMain.on('hide-window', () => mainWindow.hide());
app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (ocrWorker) ocrWorker.terminate(); 
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });