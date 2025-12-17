const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');

const DEFAULT_CONFIG = {
    engine: "google",
    apiKey: "",
    shortcutTranslate: "Ctrl+Q",
    shortcutOcr: "Ctrl+Alt+Q",
    autoLaunch: false,
    enableCodeMode: true,
    enableCodeExplain: true,
    darkMode: false // 默认关闭
};

const apiKeyInput = document.getElementById('apiKey');
const translateInput = document.getElementById('shortcutTranslate');
const ocrInput = document.getElementById('shortcutOcr');
const autoLaunchCheckbox = document.getElementById('autoLaunch');
const btnSave = document.getElementById('btnSave');

// DeepSeek 相关
const codeModeCheckbox = document.getElementById('enableCodeMode');
const codeExplainCheckbox = document.getElementById('enableCodeExplain');
const codeExplainGroup = document.getElementById('codeExplainGroup');

// 🆕 暗黑模式开关
const darkModeCheckbox = document.getElementById('darkMode');

const cardGoogle = document.getElementById('card-google');
const cardDeepseek = document.getElementById('card-deepseek');
const deepseekSettings = document.getElementById('deepseek-settings');
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
// 初始化各控件
apiKeyInput.value = config.apiKey;
translateInput.value = config.shortcutTranslate;
ocrInput.value = config.shortcutOcr;
autoLaunchCheckbox.checked = config.autoLaunch;
codeModeCheckbox.checked = config.enableCodeMode;
codeExplainCheckbox.checked = config.enableCodeExplain;
darkModeCheckbox.checked = config.darkMode;

// 初始化主题 (设置窗口自己也要变色)
applyTheme(config.darkMode);

// 监听主题开关
darkModeCheckbox.addEventListener('change', () => {
    const isDark = darkModeCheckbox.checked;
    applyTheme(isDark);
    // 📢 告诉主进程：主题变了，快通知大家！
    ipcRenderer.send('save-dark-mode', isDark);
});

// 监听外界发来的主题变化 (防止多窗口不同步)
ipcRenderer.on('theme-changed', (event, isDark) => {
    darkModeCheckbox.checked = isDark;
    applyTheme(isDark);
});

function applyTheme(dark) {
    if (dark) document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');
}

function updateSubSettings() {
    if (codeModeCheckbox.checked) {
        codeExplainGroup.classList.add('visible');
    } else {
        codeExplainGroup.classList.remove('visible');
    }
    setTimeout(() => {
        const height = document.body.scrollHeight;
        ipcRenderer.send('resize-settings-window', height);
    }, 50);
}
codeModeCheckbox.addEventListener('change', updateSubSettings);
updateSubSettings();


window.selectEngine = function(engine) {
    currentEngine = engine;
    if (engine === 'google') {
        cardGoogle.classList.add('active');
        cardDeepseek.classList.remove('active');
        deepseekSettings.style.display = 'none'; 
        setTimeout(() => ipcRenderer.send('resize-settings-window', document.body.scrollHeight), 50);
    } else {
        cardDeepseek.classList.add('active');
        cardGoogle.classList.remove('active');
        deepseekSettings.style.display = 'block'; 
        setTimeout(() => ipcRenderer.send('resize-settings-window', document.body.scrollHeight), 50);
    }
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
        if (e.metaKey) keys.push('Super');
        let key = e.key.toUpperCase();
        if (key === ' ') key = 'Space';
        keys.push(key);
        inputElement.value = keys.join('+');
    });
}
recordShortcut(translateInput);
recordShortcut(ocrInput);

btnSave.addEventListener('click', () => {
    // 这里其实不需要手动保存 darkMode 了，因为 checkbox change 时已经实时保存了
    // 但为了统一，这里只保存其他配置
    const newConfig = {
        ...loadConfig(), // 读取最新配置（含darkMode）
        engine: currentEngine,
        apiKey: apiKeyInput.value.trim(),
        shortcutTranslate: translateInput.value,
        shortcutOcr: ocrInput.value,
        autoLaunch: autoLaunchCheckbox.checked,
        enableCodeMode: codeModeCheckbox.checked,
        enableCodeExplain: codeExplainCheckbox.checked
    };

    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
        ipcRenderer.send('settings-updated');
        alert('✅ 设置已保存！');
    } catch (e) {
        alert('❌ 保存失败: ' + e.message);
    }
});

const observer = new ResizeObserver(() => {
    const height = document.body.scrollHeight;
    ipcRenderer.send('resize-settings-window', height);
});
observer.observe(document.body);