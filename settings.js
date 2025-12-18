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
    mimoEnableCodeMode: true,
    mimoEnableCodeExplain: true,
    shortcutTranslate: "Ctrl+Q",
    shortcutOcr: "Ctrl+Alt+Q",
    autoLaunch: false,
    enableCodeMode: true,
    enableCodeExplain: true,
    darkMode: false
};

const apiKeyInput = document.getElementById('apiKey');
const mimoKeyInput = document.getElementById('mimoKey');
const translateInput = document.getElementById('shortcutTranslate');
const ocrInput = document.getElementById('shortcutOcr');
const autoLaunchCheckbox = document.getElementById('autoLaunch');
const btnSave = document.getElementById('btnSave');
const darkModeCheckbox = document.getElementById('darkMode');

const codeModeCheckbox = document.getElementById('enableCodeMode');
const codeExplainCheckbox = document.getElementById('enableCodeExplain');
const codeExplainGroup = document.getElementById('codeExplainGroup');

const mimoCodeModeCheckbox = document.getElementById('mimoEnableCodeMode');
const mimoCodeExplainCheckbox = document.getElementById('mimoEnableCodeExplain');
const mimoCodeExplainGroup = document.getElementById('mimoCodeExplainGroup');

const cardGoogle = document.getElementById('card-google');
const cardDeepseek = document.getElementById('card-deepseek');
const cardXiaomi = document.getElementById('card-xiaomi');

const deepseekSettings = document.getElementById('deepseek-settings');
const xiaomiSettings = document.getElementById('xiaomi-settings');

let currentEngine = "google";

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            return { ...DEFAULT_CONFIG, ...data };
        }
    } catch (e) {}
    return DEFAULT_CONFIG;
}

const config = loadConfig();

apiKeyInput.value = config.apiKey || "";
mimoKeyInput.value = config.mimoKey || "";
translateInput.value = config.shortcutTranslate;
ocrInput.value = config.shortcutOcr;
autoLaunchCheckbox.checked = config.autoLaunch;
darkModeCheckbox.checked = config.darkMode;

codeModeCheckbox.checked = config.enableCodeMode;
codeExplainCheckbox.checked = config.enableCodeExplain;

mimoCodeModeCheckbox.checked = config.mimoEnableCodeMode !== undefined ? config.mimoEnableCodeMode : true;
mimoCodeExplainCheckbox.checked = config.mimoEnableCodeExplain !== undefined ? config.mimoEnableCodeExplain : true;

applyTheme(config.darkMode);

darkModeCheckbox.addEventListener('change', () => {
    const isDark = darkModeCheckbox.checked;
    applyTheme(isDark);
    ipcRenderer.send('save-dark-mode', isDark);
});

ipcRenderer.on('theme-changed', (event, isDark) => {
    darkModeCheckbox.checked = isDark;
    applyTheme(isDark);
});

function applyTheme(dark) {
    if (dark) document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');
}

function updateDeepSeekSub() {
    if (codeModeCheckbox.checked) codeExplainGroup.classList.add('visible');
    else codeExplainGroup.classList.remove('visible');
    requestResize();
}
function updateXiaomiSub() {
    if (mimoCodeModeCheckbox.checked) mimoCodeExplainGroup.classList.add('visible');
    else mimoCodeExplainGroup.classList.remove('visible');
    requestResize();
}

codeModeCheckbox.addEventListener('change', updateDeepSeekSub);
mimoCodeModeCheckbox.addEventListener('change', updateXiaomiSub);

updateDeepSeekSub();
updateXiaomiSub();

// 💎 核心修复：限制设置窗口的最大高度
function requestResize() {
    setTimeout(() => {
        const contentHeight = document.body.scrollHeight + 20; 
        // 限制最大高度 580px，防止撑爆屏幕
        const MAX_HEIGHT = 580; 
        const targetHeight = Math.min(contentHeight, MAX_HEIGHT);
        ipcRenderer.send('resize-settings-window', targetHeight);
    }, 100);
}

window.selectEngine = function(engine) {
    currentEngine = engine;
    cardGoogle.classList.remove('active');
    cardDeepseek.classList.remove('active');
    cardXiaomi.classList.remove('active');
    deepseekSettings.classList.remove('visible');
    xiaomiSettings.classList.remove('visible');

    if (engine === 'google') cardGoogle.classList.add('active');
    else if (engine === 'deepseek') {
        cardDeepseek.classList.add('active');
        deepseekSettings.classList.add('visible');
    } else if (engine === 'xiaomi') {
        cardXiaomi.classList.add('active');
        xiaomiSettings.classList.add('visible');
    }
    requestResize();
}
selectEngine(config.engine || 'google');

function recordShortcut(inputElement) {
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

btnSave.addEventListener('click', () => {
    const newConfig = {
        ...loadConfig(),
        engine: currentEngine,
        apiKey: apiKeyInput.value.trim(),
        mimoKey: mimoKeyInput.value.trim(),
        mimoModel: "mimo-v2-flash",
        mimoUrl: "https://api.xiaomimimo.com/v1",
        shortcutTranslate: translateInput.value,
        shortcutOcr: ocrInput.value,
        autoLaunch: autoLaunchCheckbox.checked,
        enableCodeMode: codeModeCheckbox.checked,
        enableCodeExplain: codeExplainCheckbox.checked,
        mimoEnableCodeMode: mimoCodeModeCheckbox.checked,
        mimoEnableCodeExplain: mimoCodeExplainCheckbox.checked
    };

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        ipcRenderer.send('settings-updated');
        const btn = document.getElementById('btnSave');
        const originalText = btn.innerText;
        btn.innerText = "✅ 已保存";
        btn.style.background = "#4CAF50";
        setTimeout(() => { btn.innerText = originalText; btn.style.background = ""; }, 1500);
    } catch (e) {
        alert('❌ 保存失败: ' + e.message);
    }
});

const observer = new ResizeObserver(() => requestResize());
observer.observe(document.body);