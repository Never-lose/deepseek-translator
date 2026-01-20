const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');

const DEFAULT_CONFIG = {
    engine: "google",
    apiKey: "",
    mimoKey: "",
    mimoModel: "mimo-v2-flash",
    mimoUrl: "https://api.xiaomimimo.com/v1",
    shortcutTranslate: "Ctrl+Q",
    shortcutOcr: "Ctrl+Alt+Q",
    autoLaunch: false,
    theme: "light",
    // 核心模式配置
    codeModeType: "always", 
    mimoCodeModeType: "always",
    enableCodeExplain: true,
    mimoEnableCodeExplain: true,
    // 兼容旧版字段
    enableCodeMode: true,
    mimoEnableCodeMode: true
};

// 基础元素获取
const apiKeyInput = document.getElementById('apiKey');
const mimoKeyInput = document.getElementById('mimoKey');
const translateInput = document.getElementById('shortcutTranslate');
const ocrInput = document.getElementById('shortcutOcr');
// 🔴 修复点1：允许这个元素不存在，后续使用时会检查
const autoLaunchCheckbox = document.getElementById('autoLaunch');
const btnSave = document.getElementById('btnSave');
const themeSelect = document.getElementById('themeSelect');


// DeepSeek 专属元素 (带 ds 前缀)
const dsCodeAlways = document.getElementById('dsCodeAlways');
const dsCodeSmart = document.getElementById('dsCodeSmart');
const dsCodeExplainCheckbox = document.getElementById('dsEnableCodeExplain');
const dsCodeExplainGroup = document.getElementById('dsCodeExplainGroup');

// Xiaomi 专属元素 (带 mi 前缀)
const miCodeAlways = document.getElementById('miCodeAlways');
const miCodeSmart = document.getElementById('miCodeSmart');
const miCodeExplainCheckbox = document.getElementById('miEnableCodeExplain');
const miCodeExplainGroup = document.getElementById('miCodeExplainGroup');

// 引擎选择元素
const cardGoogle = document.getElementById('card-google');
const cardDeepseek = document.getElementById('card-deepseek');
const cardXiaomi = document.getElementById('card-xiaomi');
const deepseekSettings = document.getElementById('deepseek-settings');
const xiaomiSettings = document.getElementById('xiaomi-settings');

let currentEngine = "google";

// --- 配置加载与回显 ---
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            return { ...DEFAULT_CONFIG, ...data };
        }
    } catch (e) { console.error("加载配置失败", e); }
    return DEFAULT_CONFIG;
}

function initSettings() {
    const config = loadConfig();
    
    // 1. 基础信息回显
    if(apiKeyInput) apiKeyInput.value = config.apiKey || "";
    if(mimoKeyInput) mimoKeyInput.value = config.mimoKey || "";
    if(translateInput) translateInput.value = config.shortcutTranslate;
    if(ocrInput) ocrInput.value = config.shortcutOcr;
    
    // 🔴 修复点2：只有当 HTML 里存在这个勾选框时，才去设置它的状态
    if (autoLaunchCheckbox) {
        autoLaunchCheckbox.checked = config.autoLaunch;
    }

    if (config.theme && themeSelect) {
        themeSelect.value = config.theme;
    } else if (themeSelect) {
        // 如果是旧用户只有 darkMode，帮他转成 theme
        themeSelect.value = config.darkMode ? "dark" : "light";
    }
    if(themeSelect) applyTheme(themeSelect.value);

    // 2. DeepSeek 模式回显
    if(dsCodeSmart && dsCodeAlways) {
        if (config.codeModeType === 'smart') dsCodeSmart.checked = true;
        else dsCodeAlways.checked = true;
    }
    if(dsCodeExplainCheckbox) dsCodeExplainCheckbox.checked = config.enableCodeExplain !== undefined ? config.enableCodeExplain : true;

    // 3. Xiaomi 模式回显
    if(miCodeSmart && miCodeAlways) {
        if (config.mimoCodeModeType === 'smart') miCodeSmart.checked = true;
        else miCodeAlways.checked = true;
    }
    if(miCodeExplainCheckbox) miCodeExplainCheckbox.checked = config.mimoEnableCodeExplain !== undefined ? config.mimoEnableCodeExplain : true;

    selectEngine(config.engine || 'google');
    
    // 更新子选项显隐
    updateDeepSeekSub();
    updateXiaomiSub();
}

// --- 交互逻辑 ---
function applyTheme(theme) {
    document.body.classList.remove('dark-mode', 'transparent-mode');
    if (theme === 'dark') {
        document.body.classList.add('dark-mode');
    } else if (theme === 'transparent') {
        document.body.classList.add('dark-mode', 'transparent-mode');
    }
}

function updateDeepSeekSub() {
    // 🔴 修复点3：增加判空保护，防止元素不存在报错
    if (!dsCodeAlways || !dsCodeExplainGroup) return;

    // 只有“始终开启”时才显示“逻辑解释”
    if (dsCodeAlways.checked) dsCodeExplainGroup.classList.add('visible');
    else dsCodeExplainGroup.classList.remove('visible');
    requestResize();
}

function updateXiaomiSub() {
    if (!miCodeAlways || !miCodeExplainGroup) return;

    if (miCodeAlways.checked) miCodeExplainGroup.classList.add('visible');
    else miCodeExplainGroup.classList.remove('visible');
    requestResize();
}

function requestResize() {
    setTimeout(() => {
        const contentHeight = document.body.scrollHeight + 20; 
        const MAX_HEIGHT = 600; 
        const targetHeight = Math.min(contentHeight, MAX_HEIGHT);
        ipcRenderer.send('resize-settings-window', targetHeight);
    }, 50);
}

// --- 事件监听 ---
if(dsCodeAlways) dsCodeAlways.addEventListener('change', updateDeepSeekSub);
if(dsCodeSmart) dsCodeSmart.addEventListener('change', updateDeepSeekSub);
if(miCodeAlways) miCodeAlways.addEventListener('change', updateXiaomiSub);
if(miCodeSmart) miCodeSmart.addEventListener('change', updateXiaomiSub);

if(themeSelect) {
    themeSelect.addEventListener('change', () => {
        const theme = themeSelect.value;
        applyTheme(theme);
        ipcRenderer.send('save-theme', theme); // 发送新信号
    });
}

window.selectEngine = function(engine) {
    currentEngine = engine;
    [cardGoogle, cardDeepseek, cardXiaomi].forEach(c => { if(c) c.classList.remove('active') });
    [deepseekSettings, xiaomiSettings].forEach(s => { if(s) s.classList.remove('visible') });

    if (engine === 'google' && cardGoogle) cardGoogle.classList.add('active');
    else if (engine === 'deepseek' && cardDeepseek) {
        cardDeepseek.classList.add('active');
        if(deepseekSettings) deepseekSettings.classList.add('visible');
    } else if (engine === 'xiaomi' && cardXiaomi) {
        cardXiaomi.classList.add('active');
        if(xiaomiSettings) xiaomiSettings.classList.add('visible');
    }
    requestResize();
}

function recordShortcut(inputElement) {
    if(!inputElement) return;
    inputElement.addEventListener('keydown', (e) => {
        e.preventDefault();
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
        const keys = [];
        if (e.ctrlKey) keys.push('Ctrl');
        if (e.altKey) keys.push('Alt');
        if (e.shiftKey) keys.push('Shift');
        let key = e.key.toUpperCase();
        if (key === ' ') key = 'Space';
        keys.push(key);
        inputElement.value = keys.join('+');
    });
}
recordShortcut(translateInput);
recordShortcut(ocrInput);

// --- 保存逻辑 ---
if(btnSave) {
    btnSave.addEventListener('click', () => {
        const newConfig = {
            ...loadConfig(),
            engine: currentEngine,
            apiKey: apiKeyInput ? apiKeyInput.value.trim() : "",
            mimoKey: mimoKeyInput ? mimoKeyInput.value.trim() : "",
            shortcutTranslate: translateInput ? translateInput.value : "Ctrl+Q",
            shortcutOcr: ocrInput ? ocrInput.value : "Ctrl+Alt+Q",
            // 🔴 修复点4：保存时也检查元素是否存在
            autoLaunch: autoLaunchCheckbox ? autoLaunchCheckbox.checked : false,
            theme: themeSelect ? themeSelect.value : "light",

            // 核心模式保存
            codeModeType: (dsCodeAlways && dsCodeAlways.checked) ? "always" : "smart",
            mimoCodeModeType: (miCodeAlways && miCodeAlways.checked) ? "always" : "smart",
            
            // 兼容旧版布尔值逻辑
            enableCodeMode: (dsCodeAlways && dsCodeAlways.checked), 
            mimoEnableCodeMode: (miCodeAlways && miCodeAlways.checked),

            // 解释勾选框状态
            enableCodeExplain: dsCodeExplainCheckbox ? dsCodeExplainCheckbox.checked : true,
            mimoEnableCodeExplain: miCodeExplainCheckbox ? miCodeExplainCheckbox.checked : true
        };

        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
            ipcRenderer.send('settings-updated');
            
            const originalText = btnSave.innerText;
            btnSave.innerText = "✅ 已保存";
            btnSave.style.background = "#4CAF50";
            setTimeout(() => { 
                btnSave.innerText = originalText; 
                btnSave.style.background = ""; 
            }, 1500);
        } catch (e) {
            alert('❌ 保存失败: ' + e.message);
        }
    });
}

// 初始化
initSettings();

const observer = new ResizeObserver(() => requestResize());
observer.observe(document.body);