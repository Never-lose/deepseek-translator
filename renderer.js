const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const DB_PATH = path.join(USER_DATA_PATH, 'words.json');
const container = document.getElementById('app-container');

let isPinned = false; 
let isDarkMode = false;

function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            // 确保 Xiaomi 的默认配置存在
            return { 
                engine: "google", 
                mimoUrl: "https://api.xiaomimimo.com/v1", 
                mimoModel: "mimo-v2-flash",
                mimoEnableCodeMode: true,
                mimoEnableCodeExplain: true,
                ...data 
            };
        }
    } catch (e) {}
    return { engine: "google", apiKey: "" };
}

// ... (Theme, DB, Speak, EventListeners 保持不变) ...
const initConfig = getConfig();
isDarkMode = initConfig.darkMode || false;
applyTheme(isDarkMode);

ipcRenderer.on('theme-changed', (event, dark) => { isDarkMode = dark; applyTheme(dark); });
function applyTheme(dark) { if (dark) document.body.classList.add('dark-mode'); else document.body.classList.remove('dark-mode'); }
function readDb() { try { if (!fs.existsSync(DB_PATH)) return {}; return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch (e) { return {}; } }
function saveDb(data) { try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {} }
function speak(text) { if(!text) return; window.speechSynthesis.cancel(); const msg = new SpeechSynthesisUtterance(text); msg.lang = 'en-US'; window.speechSynthesis.speak(msg); }
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') ipcRenderer.send('hide-window'); });

ipcRenderer.on('ocr-loading', () => { renderPopup("🔍", `<div style="text-align:center;padding:40px;color:#999;font-size:14px;">正在提取文字...</div>`, "", false); });
ipcRenderer.on('ocr-error', (event, msg) => { renderPopup("Error", `<div style="color:#ff5252;padding:10px;text-align:center;">${msg}</div>`, "", false); });

// 🚀 核心翻译逻辑更新
ipcRenderer.on('start-translation', async (event, text) => {
    const config = getConfig();
    const engine = config.engine || 'google';

    let processedText = text.replace(/([^\n])\n([^\n])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    const wordCount = processedText.split(' ').length;
    const isSentence = wordCount > 3 || processedText.length > 30;

    if ((engine === 'deepseek' && !config.apiKey) || (engine === 'xiaomi' && !config.mimoKey)) {
        renderPopup("Key Missing", `<div style="padding:20px;text-align:center;">请先在设置中配置 API Key</div>`, "", false);
        return;
    }

    let engineName = engine === 'xiaomi' ? 'Xiaomi' : (engine === 'deepseek' ? 'DeepSeek' : 'Google');
    renderPopup(isSentence ? "Translating..." : "Searching...", 
        `<div style="color:#999;font-size:13px;padding:30px 0;text-align:center;">正在使用 ${engineName} 思考...</div>`, "", isSentence);
    
    // 🧠 智能判断：根据不同引擎读取不同的配置
    let enableCodeMode = true;
    let enableCodeExplain = true;

    if (engine === 'deepseek') {
        enableCodeMode = config.enableCodeMode;
        enableCodeExplain = config.enableCodeExplain;
    } else if (engine === 'xiaomi') {
        enableCodeMode = config.mimoEnableCodeMode;
        enableCodeExplain = config.mimoEnableCodeExplain;
    }

    // 判断是否启用代码解释模式 (非Google引擎 + 开启了编程模式 + 开启了解释 + 是句子)
    const isCodeExplainMode = (engine !== 'google' && enableCodeMode && enableCodeExplain);

    if (isSentence) {
        let result = "";
        if (engine === 'google') result = await callGoogleTranslate(processedText);
        else if (engine === 'xiaomi') result = await callXiaomiMimo(processedText, config, isCodeExplainMode);
        else result = await translateSentence(processedText, config.apiKey, isCodeExplainMode);
        
        renderSentenceResult(processedText, result, isCodeExplainMode);
    } else {
        const cleanRegex = /^[^\w\u4e00-\u9fa5#+]+|[^\w\u4e00-\u9fa5#+]+$/g;
        let cleanText = processedText.replace(cleanRegex, '');
        if (!cleanText) cleanText = processedText;
        
        const lowerWord = cleanText.toLowerCase();
        const db = readDb();
        let history = db[lowerWord];
        
        if (history && history.general) {
            history.count++; history.lastTime = Date.now();
            db[lowerWord] = history; 
            saveDb(db);
            ipcRenderer.send('data-updated');
            renderFinal(cleanText, history.general, history.coding, history.phonetic, history.count, true, engine);
            return;
        }

        let parsedData = {};
        if (engine === 'google') {
            const googleRaw = await callGoogleTranslate(cleanText);
            parsedData = parseGoogleResult(googleRaw, cleanText);
        } else if (engine === 'xiaomi') {
            const raw = await callXiaomiMimoWord(cleanText, config, enableCodeMode); // 传参控制
            if (raw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:#ff5252">${raw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(raw); 
        } else {
            const dsRaw = await translateWord(cleanText, config.apiKey, enableCodeMode); // 传参控制
            if (dsRaw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:#ff5252">${dsRaw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(dsRaw);
        }

        const { general, coding, phonetic } = parsedData;
        db[lowerWord] = { count: 1, lastTime: Date.now(), general, coding, phonetic };
        saveDb(db);
        ipcRenderer.send('data-updated');
        renderFinal(cleanText, general, coding, phonetic, 1, false, engine);
    }
});

async function translateWord(text, key, enableCodeMode) {
    let prompt = enableCodeMode 
        ? `解释单词 "${text}"。严格按格式输出：\n[音标]\n::通用:: [中文含义]\n::编程:: [编程含义]`
        : `解释单词 "${text}"。严格按格式输出：\n[音标]\n::通用:: [中文含义]`;
    return await callDeepSeek(prompt, key);
}
async function translateSentence(text, key, isCodeExplainMode) {
    let prompt = isCodeExplainMode 
        ? `分析以下内容。如果是代码，解释逻辑；如果是自然语言，直接翻译成中文。\n内容：${text}`
        : `将以下内容直接翻译成中文：\n${text}`;
    return await callDeepSeek(prompt, key);
}
async function callDeepSeek(prompt, key) {
    try {
        const resp = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], stream: false })
        });
        const data = await resp.json();
        if (data.error) return `❌ API: ${data.error.message}`;
        return data.choices?.[0]?.message?.content || "❌ 无返回";
    } catch (e) { return `❌ 网络错误: ${e.message}`; }
}

async function callXiaomiMimo(text, config, isCodeExplainMode) {
    let prompt = isCodeExplainMode 
        ? `分析以下内容。如果是代码，解释逻辑；如果是自然语言，直接翻译成中文。\n内容：${text}`
        : `将以下内容直接翻译成中文：\n${text}`;
    return await callXiaomiApi(prompt, config);
}

// 适配了 codeMode 的参数
async function callXiaomiMimoWord(text, config, enableCodeMode) {
    let prompt = enableCodeMode
        ? `请解释单词 "${text}"。严格遵循格式输出：\n[音标]\n::通用:: [中文含义]\n::编程:: [编程含义]`
        : `请解释单词 "${text}"。严格遵循格式输出：\n[音标]\n::通用:: [中文含义]`;
    return await callXiaomiApi(prompt, config);
}

async function callXiaomiApi(prompt, config) {
    try {
        let baseUrl = config.mimoUrl.replace(/\/$/, ""); 
        const url = `${baseUrl}/chat/completions`;
        const resp = await fetch(url, {
            method: "POST", 
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.mimoKey}` },
            body: JSON.stringify({ model: config.mimoModel || "mimo-v2-flash", messages: [{ role: "user", content: prompt }], stream: false })
        });
        const data = await resp.json();
        if (data.error) return `❌ Xiaomi API Error: ${data.error.message}`;
        return data.choices?.[0]?.message?.content || "❌ 无返回";
    } catch (e) { return `❌ 网络错误: ${e.message}`; }
}

function parseDeepSeekResult(raw) {
    const phMatch = raw.match(/\[([^\]]+)\]/);
    const phonetic = phMatch ? `[${phMatch[1]}]` : "";
    let clean = raw.replace(phonetic, "").trim();
    const genMatch = clean.match(/::通用::\s*([\s\S]*?)(?=(::编程::|$))/);
    const codMatch = clean.match(/::编程::\s*([\s\S]*?)(?=$)/);
    let gen = genMatch ? genMatch[1].trim() : (clean || "解析失败");
    let cod = codMatch ? codMatch[1].trim() : "无";
    gen = gen.replace(/\[.*?\]/g, "").trim();
    return { general: gen, coding: cod, phonetic };
}

// ... (Google Logic & Render Logic 保持不变，请直接使用之前发给你的代码，它们不需要改动) ...
// (为了确保代码完整性，这里简略展示，实际上你需要保留上一版 renderer.js 中后半部分关于 renderFinal 和 renderPopup 的所有内容)

async function callGoogleTranslate(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Google请求失败");
        return await resp.json();
    } catch (e) { return `❌ Google翻译失败: ${e.message}`; }
}
function parseGoogleResult(json, originalText) {
    try {
        let translation = "";
        if (json[0]) json[0].forEach(item => { if(item[0]) translation += item[0]; });
        let dictMeanings = [];
        if (json[1]) {
            json[1].forEach(typeGroup => {
                const pos = typeGroup[0];
                const words = typeGroup[1].slice(0, 5).join('; ');
                dictMeanings.push(`<b>[${pos}]</b> ${words}`);
            });
        }
        const general = dictMeanings.length > 0 ? dictMeanings.join('<br>') : translation;
        let phonetic = "";
        try {
            if (json[0]) for (let i = 0; i < json[0].length; i++) if (Array.isArray(json[0][i])) for (let j = 1; j < json[0][i].length; j++) if (typeof json[0][i][j] === 'string' && json[0][i][j].match(/^[\/\[].*[\/\]]$/)) { phonetic = json[0][i][j]; break; }
        } catch(e) {}
        return { general, coding: "无", phonetic };
    } catch (e) { return { general: "解析错误", coding: "无", phonetic: "" }; }
}

function renderSentenceResult(origin, trans, isCodeExplain) {
    if (typeof trans !== 'string') { try { trans = trans[0][0][0]; } catch(e) {} }
    const badgeHtml = isCodeExplain 
        ? `<span class="ds-tag tag-coding">代码解析</span>` 
        : `<span class="ds-tag tag-general">机器翻译</span>`;
    
    const html = `
        <div class="ds-section">
            <div class="ds-section-header">${badgeHtml}</div>
            <div class="ds-text" style="white-space: pre-wrap;">${trans}</div>
        </div>`;
    renderPopup("Translation", html, "", true);
}

function renderFinal(word, gen, cod, pho, count, cache, engine) {
    let html = "";
    if(gen) {
        html += `
        <div class="ds-section">
            <div class="ds-section-header"><span class="ds-tag tag-general">通用含义</span></div>
            <div class="ds-text">${gen}</div>
        </div>`;
    }
    if(cod && cod !== "无") {
        html += `
        <div class="ds-section">
            <div class="ds-section-header"><span class="ds-tag tag-coding">编程含义</span></div>
            <div class="ds-coding-block">${cod}</div>
        </div>`;
    }
    
    let engineLabel = "Google";
    let badgeColor = "#aaa";
    if (engine === 'deepseek') { engineLabel = "DeepSeek V3"; badgeColor = "#2196F3"; }
    else if (engine === 'xiaomi') { engineLabel = "Xiaomi MIMO"; badgeColor = "#ff6700"; } 

    let sourceBadge = `<span style="font-size:10px; color:${badgeColor}; border:1px solid ${badgeColor}33; padding:1px 4px; border-radius:3px; margin-right:5px;">${engineLabel}</span>`;
    let countHtml = count > 1 ? ` · 复习 ${count} 次` : ` · 首次查询`;
    renderPopup(word, html, pho, false, sourceBadge + countHtml);
}

function renderPopup(title, content, phonetic, isSentence, footerText = "") {
    const titleClass = isSentence ? "ds-word-title-small" : "ds-word-title";
    const phoneticHtml = (phonetic && !isSentence) ? `<span class="ds-phonetic-row">${phonetic}</span>` : '';
    const speakBtnId = isSentence ? "btn-read-sentence" : "btn-read-word";
    const pinClass = isPinned ? "icon-btn pinned" : "icon-btn";
    
    container.innerHTML = `
    <div class="my-ds-popup">
        <div class="ds-header">
            <div class="header-top-row">
                <div class="${titleClass}" title="${title}">${title}</div>
                <div id="${speakBtnId}" class="icon-btn" title="朗读">🔊</div>
            </div>
            ${phoneticHtml}
        </div>
        
        <div class="ds-content">${content}</div>
        
        <div class="ds-footer">
            <div class="footer-left">${footerText}</div>
            <div class="footer-icons">
                <div id="pin-btn" class="${pinClass}" title="${isPinned ? '取消固定' : '固定窗口'}">📌</div>
                <div id="settings-btn" class="icon-btn" title="设置">⚙️</div>
                <div id="stats-btn" class="icon-btn" title="复习本">📊</div>
                <div id="close-btn" class="icon-btn icon-close" title="关闭">✕</div>
            </div>
        </div>
    </div>`;
    
    document.getElementById('close-btn').addEventListener('click', () => ipcRenderer.send('hide-window'));
    document.getElementById('stats-btn').addEventListener('click', () => ipcRenderer.send('open-dashboard'));
    document.getElementById('settings-btn').addEventListener('click', () => ipcRenderer.send('open-settings'));
    
    document.getElementById('pin-btn').addEventListener('click', (e) => {
        isPinned = !isPinned; 
        const btn = e.target;
        if (isPinned) { btn.classList.add('pinned'); btn.title = "取消固定"; } else { btn.classList.remove('pinned'); btn.title = "固定窗口"; }
        ipcRenderer.send('toggle-pin', isPinned);
    });

    const speakBtn = document.getElementById(speakBtnId);
    if(speakBtn) {
        speakBtn.addEventListener('click', () => {
            if(!isSentence) speak(title);
        });
    }

    setTimeout(() => {
        const header = document.querySelector('.ds-header');
        const footer = document.querySelector('.ds-footer');
        const content = document.querySelector('.ds-content');
        if(header && footer && content) {
            const total = header.offsetHeight + content.scrollHeight + footer.offsetHeight + 50; 
            const MAX_HEIGHT = 650; 
            const finalHeight = Math.min(total, MAX_HEIGHT);
            ipcRenderer.send('resize-main-window', finalHeight); 
        }
    }, 20);
}