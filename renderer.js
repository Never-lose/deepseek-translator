const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const DB_PATH = path.join(USER_DATA_PATH, 'words.json');
const container = document.getElementById('app-container');

let isPinned = true; 
let isDarkMode = false;

function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            return { engine: "google", enableCodeMode: true, enableCodeExplain: true, darkMode: false, ...data };
        }
    } catch (e) {}
    return { engine: "google", apiKey: "", enableCodeMode: true, enableCodeExplain: true, darkMode: false };
}

const initConfig = getConfig();
isDarkMode = initConfig.darkMode || false;
applyTheme(isDarkMode);

ipcRenderer.on('theme-changed', (event, dark) => {
    isDarkMode = dark;
    applyTheme(dark);
});

function applyTheme(dark) {
    if (dark) document.body.classList.add('dark-mode');
    else document.body.classList.remove('dark-mode');
}

function readDb() {
    try {
        if (!fs.existsSync(DB_PATH)) return {};
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    } catch (e) { return {}; }
}
function saveDb(data) { try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) {} }

function speak(text) {
    window.speechSynthesis.cancel();
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'en-US'; 
    window.speechSynthesis.speak(msg);
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send('hide-window');
});

ipcRenderer.on('ocr-loading', () => {
    window.scrollTo(0, 0);
    renderPopup("🔍 识别中...", `<div style="text-align:center;padding:40px;color:#999;font-size:13px;">正在提取文字...</div>`, "", false);
});
ipcRenderer.on('ocr-error', (event, msg) => {
    renderPopup("错误", `<div style="color:#ff5252;padding:10px">${msg}</div>`, "", false);
});

ipcRenderer.on('start-translation', async (event, text) => {
    window.scrollTo(0, 0);
    const config = getConfig();
    const engine = config.engine || 'google';

    let processedText = text.replace(/([^\n])\n([^\n])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    const wordCount = processedText.split(' ').length;
    const isSentence = wordCount > 3 || processedText.length > 30;

    if (engine === 'deepseek' && (!config.apiKey || config.apiKey.startsWith("sk-xxxx"))) {
        renderPopup("未配置 Key", `<div style="padding:20px;text-align:center;">请先去设置配置 API Key</div>`, "", false);
        return;
    }

    if (isSentence) {
        const isCodeExplainMode = (engine === 'deepseek' && config.enableCodeMode && config.enableCodeExplain);
        const title = isCodeExplainMode ? "⏳ 分析中..." : "⏳ 翻译中...";
        renderPopup(title, `<div style="color:#999;font-size:12px;margin-bottom:10px">原文: ${processedText.substring(0, 60)}...</div>`, "", true);
        
        let result = "";
        if (engine === 'google') result = await callGoogleTranslate(processedText);
        else result = await translateSentence(processedText, config.apiKey, isCodeExplainMode);
        
        renderSentenceResult(processedText, result, isCodeExplainMode);
    } else {
        const cleanRegex = /^[^\w\u4e00-\u9fa5#+]+|[^\w\u4e00-\u9fa5#+]+$/g;
        let cleanText = processedText.replace(cleanRegex, '');
        if (!cleanText) cleanText = processedText;
        
        const lowerWord = cleanText.toLowerCase();
        const db = readDb();
        let history = db[lowerWord] || { count: 0, general: "", coding: "", phonetic: "" };
        
        if (history.general) {
            history.count++; history.lastTime = Date.now();
            db[lowerWord] = history; 
            saveDb(db);
            ipcRenderer.send('data-updated');
            renderFinal(cleanText, history.general, history.coding, history.phonetic, history.count, true, engine);
            return;
        }

        renderPopup(cleanText, "⏳ 查询中...", `正在使用 ${engine === 'google' ? 'Google' : 'DeepSeek'} 翻译...`, false);
        
        let parsedData = {};
        if (engine === 'google') {
            const googleRaw = await callGoogleTranslate(cleanText);
            parsedData = parseGoogleResult(googleRaw, cleanText);
        } else {
            const dsRaw = await translateWord(cleanText, config.apiKey, config.enableCodeMode);
            if (dsRaw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:red">${dsRaw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(dsRaw);
        }

        if (parsedData.general && (parsedData.general.includes('❌') || parsedData.general.includes('失败'))) {
            renderPopup(cleanText, `<div style="color:red">${parsedData.general}</div>`, "", false);
            return;
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
    let prompt = "";
    if (isCodeExplainMode) {
        prompt = `请分析以下内容。
        1. 如果它是编程代码（一行或多行），请简要解释这段代码的逻辑功能（不要逐字翻译）。
        2. 如果它是自然语言（英语句子），请直接翻译成中文。
        内容：${text}`;
    } else {
        prompt = `请将以下内容直接翻译成中文（不要废话）：\n${text}`;
    }
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
function parseDeepSeekResult(raw) {
    const ph = raw.match(/(\[.*?\]|\/.*\/)/);
    const phonetic = ph ? ph[0] : "";
    let clean = raw.replace(phonetic, "").trim();
    const gen = clean.match(/::通用::\s*(.*?)(\n|$)/);
    const cod = clean.match(/::编程::\s*(.*?)(\n|$)/);
    return { general: gen ? gen[1] : (clean || "解析失败"), coding: cod ? cod[1] : "无", phonetic };
}
async function callGoogleTranslate(text) {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("Google请求失败");
        return await resp.json();
    } catch (e) { return `❌ Google翻译失败: ${e.message}`; }
}
function parseGoogleResult(json, originalText) {
    if (typeof json === 'string' && json.startsWith('❌')) return { general: json, coding: "无", phonetic: "" };
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
            if (json[0]) {
                for (let i = 0; i < json[0].length; i++) {
                    const item = json[0][i];
                    if (Array.isArray(item)) {
                        for (let j = 1; j < item.length; j++) {
                            const val = item[j];
                            if (typeof val === 'string') {
                                if (val !== originalText && (val.startsWith('[') || val.startsWith('/') || /^[a-zəæɪʊɒʌθðʃʒŋːˌˈ]+$/.test(val))) {
                                    if (!val.startsWith('[')) phonetic = `[${val}]`;
                                    else phonetic = val;
                                    break; 
                                }
                            }
                        }
                    }
                    if (phonetic) break;
                }
            }
        } catch(e) {}
        return { general: general, coding: "无", phonetic: phonetic };
    } catch (e) { return { general: "解析错误", coding: "无", phonetic: "" }; }
}

function renderSentenceResult(origin, trans, isCodeExplain) {
    if (typeof trans !== 'string') { try { trans = trans[0][0][0]; } catch(e) {} }
    const badgeHtml = isCodeExplain ? `<span class="ds-tag tag-coding">代码解析</span>` : `<span class="ds-tag tag-general">译文</span>`;
    const html = `<div class="ds-section">${badgeHtml}<div class="ds-text" style="font-size:15px; margin-top:5px; white-space: pre-wrap;">${trans}</div></div>`;
    renderPopup(origin, html, "", true);
}

function renderFinal(word, gen, cod, pho, count, cache, engine) {
    let html = "";
    if(gen) html += `<div class="ds-section"><span class="ds-tag tag-general">通用</span><div class="ds-text">${gen}</div></div>`;
    if(cod && cod !== "无") html += `<div class="ds-section"><span class="ds-tag tag-coding">编程</span><div class="ds-code-box">${cod}</div></div>`;
    
    let sourceBadge = engine === 'google' 
        ? `<span style="font-size:10px; color:#aaa; border:1px solid #eee; padding:1px 4px; border-radius:3px; margin-right:5px;">Google</span>` 
        : `<span style="font-size:10px; color:#2196F3; border:1px solid #bbdefb; padding:1px 4px; border-radius:3px; margin-right:5px;">DeepSeek</span>`;

    let countHtml = cache ? `⚡ 已复习 ${count} 次` : `🌱 第 1 次查询`;
    if (count > 10) countHtml = `🔥 烂熟于心 (${count}次)`;
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
            <div class="header-top">
                <div class="${titleClass}" title="${title}">${title}</div>
                <div id="${speakBtnId}" class="btn-speak-header" title="朗读">🔊</div>
            </div>
            ${phoneticHtml}
        </div>
        <div class="ds-content">${content}</div>
        <div class="ds-footer">
            <div class="footer-left">${footerText ? `<span>${footerText}</span>` : ''}</div>
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
    if(speakBtn) speakBtn.addEventListener('click', () => speak(title));

    // 💎 核心修改：等待渲染完成后，告诉主进程新的高度
    setTimeout(() => {
        const height = document.body.scrollHeight;
        // 加一点点余量，确保不出现滚动条
        ipcRenderer.send('resize-main-window', height + 2); 
    }, 10);
}