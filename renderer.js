const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
function hasChinese(text) {
    return /[\u4e00-\u9fa5]/.test(text);
}
const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const DB_PATH = path.join(USER_DATA_PATH, 'words.json');
const container = document.getElementById('app-container');
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
const initConfig = getConfig();
let isPinned = true; // 默认设为 true，实现每次打开默认置顶
let isDarkMode = initConfig.darkMode || false;



// ... (Theme, DB, Speak, EventListeners 保持不变) ...

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



ipcRenderer.on('start-translation', async (event, text) => {
    isPinned = true;
    const config = getConfig();
    const engine = config.engine || 'google';

    // 1. 文本预处理：去除多余换行和空格
    let processedText = text.replace(/([^\n])\n([^\n])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    const isTargetEn = hasChinese(processedText);
    const targetLangCode = isTargetEn ? 'en' : 'zh-CN';
    const targetLangName = isTargetEn ? '英文' : '中文';

    // 判断是单词还是句子
    const wordCount = processedText.split(' ').length;
    const isSentence = wordCount > 3 || processedText.length > 30;

    // 检查 Key 是否配置
    if ((engine === 'deepseek' && !config.apiKey) || (engine === 'xiaomi' && !config.mimoKey)) {
        renderPopup("Key Missing", `<div style="padding:20px;text-align:center;">请先在设置中配置 API Key</div>`, "", false);
        return;
    }

    // --- 核心模式判断逻辑 ---
    // 获取当前引擎对应的模式字符串 ("always" 或 "smart")
    const mode = engine === 'xiaomi' ? (config.mimoCodeModeType || 'always') : (config.codeModeType || 'always');
    // 获取当前引擎对应的解释开关
    const enableExplain = engine === 'xiaomi' ? config.mimoEnableCodeExplain : config.enableCodeExplain;

    let engineName = engine === 'xiaomi' ? 'Xiaomi' : (engine === 'deepseek' ? 'DeepSeek' : 'Google');
    
    // 初始化弹窗显示加载中
    renderPopup(isSentence ? "Translating..." : "Searching...", 
        `<div style="color:#999;font-size:13px;padding:30px 0;text-align:center;">正在使用 ${engineName} 思考...</div>`, "", isSentence);

    // --- 分支处理：长句/段落翻译 ---
    if (isSentence) {
        renderSentenceResult(processedText, "正在思考...", true);

        if (engine === 'google') {
            const result = await callGoogleTranslate(processedText, targetLangCode);
            renderSentenceResult(processedText, result, false);
        } else {
            // 🚀 准备流式请求参数
            const url = engine === 'xiaomi' ? `${config.mimoUrl.replace(/\/$/, "")}/chat/completions` : "https://api.deepseek.com/chat/completions";
            const key = engine === 'xiaomi' ? config.mimoKey : config.apiKey;
            const model = engine === 'xiaomi' ? config.mimoModel : "deepseek-chat";
            
            let prompt = "";
            if (mode === 'always') {
                prompt = enableExplain 
                    ? `[指令] 你是技术专家。请翻译并详细解释逻辑。回复必须以 [TECH] 开头。\n[内容] ${processedText}`
                    : `[指令] 你是程序员。请按编程语境翻译。回复必须以 [TECH] 开头。\n[内容] ${processedText}`;
            } else {
                // 🧠 核心改进：引入强制标签控制
                prompt = `你是翻译专家。请根据内容性质选择回复格式：
1. 如果内容涉及代码、API或编程术语：回复必须以 [TECH] 开头，先翻译再提供简要技术分析。
2. 如果内容是日常对话或非技术描述：回复必须以 [GENERAL] 开头，仅输出翻译结果，禁止任何额外解释。
内容：${processedText}`;
            }

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
                    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true })
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let fullText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\n');
                    for (const line of lines) {
                        if (line.trim().startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                            try {
                                const json = JSON.parse(line.trim().slice(6));
                                const content = json.choices[0].delta.content || "";
                                if (content) {
                                    fullText += content;
                                    // 实时更新 Markdown 渲染
                                    renderSentenceResult(processedText, fullText, mode === 'always');
                                }
                            } catch (e) { }
                        }
                    }
                }
            } catch (err) {
                renderSentenceResult(processedText, "❌ 翻译出错: " + err.message, false);
            }
        }
    } 
    // --- 分支处理：单词/短语查询 ---
    else {
        const cleanText = processedText.replace(/^[^\w\u4e00-\u9fa5#+]+|[^\w\u4e00-\u9fa5#+]+$/g, '') || processedText;
        const lowerWord = cleanText.toLowerCase();
        const db = readDb();
        
        // 1. 检查本地数据库缓存
        let history = db[lowerWord];
        if (history && history.general) {
            history.count++; 
            history.lastTime = Date.now();
            db[lowerWord] = history; 
            saveDb(db);
            ipcRenderer.send('data-updated');
            renderFinal(cleanText, history.general, history.coding, history.phonetic, history.count, true, engine);
            return;
        }

        // 2. 缓存未命中，调用接口
        let parsedData = {};
        if (engine === 'google') {
            const googleRaw = await callGoogleTranslate(cleanText, targetLangCode);
            parsedData = parseGoogleResult(googleRaw, cleanText);
        } else if (engine === 'xiaomi') {
            // 修正：这里传入 mode 字符串 ("always"/"smart")
            const raw = await callXiaomiMimoWord(cleanText, config, mode, targetLangName);
            if (raw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:#ff5252">${raw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(raw); 
        } else {
            // 修正：这里传入 mode 字符串 ("always"/"smart")
            const dsRaw = await translateWord(cleanText, config.apiKey, mode, targetLangName);
            if (dsRaw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:#ff5252">${dsRaw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(dsRaw);
        }

        // 3. 保存到本地数据库并渲染
        const { general, coding, phonetic } = parsedData;
        db[lowerWord] = { count: 1, lastTime: Date.now(), general, coding, phonetic };
        saveDb(db);
        ipcRenderer.send('data-updated');
        renderFinal(cleanText, general, coding, phonetic, 1, false, engine);
    }
});


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

async function callDeepSeekStream(prompt, key, onChunk) {
    try {
        const resp = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ 
                model: "deepseek-chat", 
                messages: [{ role: "user", content: prompt }], 
                stream: true // 🚀 核心：开启流式
            })
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.trim().startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.trim().slice(6));
                        const content = data.choices[0].delta.content || "";
                        fullText += content;
                        // 🚀 实时回调更新 UI
                        onChunk(fullText); 
                    } catch (e) { continue; }
                }
            }
        }
        return fullText;
    } catch (e) { return `❌ 错误: ${e.message}`; }
}

// DeepSeek 单词查询
async function translateWord(text, key, mode, targetLangName = "中文") {
    let prompt = "";
    if (mode === 'always') {
        prompt = `解释单词 "${text}"。必须包含编程含义。严格按格式输出：\n[音标]\n::通用:: [含义]\n::编程:: [编程含义]`;
    } else {
        // 智能识别模式：让 AI 判断是否有编程含义
        prompt = `解释单词 "${text}"。如果该单词在编程中有特定用途，请在 ::编程:: 块中说明，否则 ::编程:: 块请填“无”。
格式：
[音标]
::通用:: [${targetLangName}含义]
::编程:: [编程含义]`;
    }
    return await callDeepSeek(prompt, key);
}

// Xiaomi 单词查询 (统一为一个函数)
async function callXiaomiMimoWord(text, config, mode, targetLangName = "中文") {
    let prompt = "";
    if (mode === 'always') {
        prompt = `解释单词 "${text}"。必须包含编程含义。严格遵循格式：\n[音标]\n::通用:: [${targetLangName}含义]\n::编程:: [编程含义]`;
    } else {
        prompt = `智能解释单词 "${text}"。判断其是否具有编程语境下的含义。格式：\n[音标]\n::通用:: [${targetLangName}含义]\n::编程:: [编程含义或填“无”]`;
    }
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


async function callGoogleTranslate(text, targetLang = 'zh-CN') {
    try {
        // 将 tl=zh-CN 改为 tl=${targetLang}
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
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



function renderSentenceResult(origin, trans, isCodeExplainForce) {
    let htmlContent = "";
    let displayTrans = trans;
    // 🔍 智能识别 AI 返回的标签
    let isTech = isCodeExplainForce; // 默认跟随传入值

    if (trans.startsWith('[TECH]')) {
        isTech = true;
        displayTrans = trans.replace('[TECH]', '').trim();
    } else if (trans.startsWith('[GENERAL]')) {
        isTech = false;
        displayTrans = trans.replace('[GENERAL]', '').trim();
    }

    try {
        if (typeof marked !== 'undefined') {
            marked.setOptions({ breaks: true, gfm: true });
            htmlContent = marked.parse(displayTrans);
        } else {
            htmlContent = displayTrans;
        }
    } catch (e) { htmlContent = displayTrans; }

    // 根据识别结果显示标签
    const badgeHtml = isTech 
        ? `<span class="ds-tag tag-coding">代码解析</span>` 
        : `<span class="ds-tag tag-general">机器翻译</span>`;
    
    const html = `
        <div class="ds-section">
            <div class="ds-section-header">${badgeHtml}</div>
            <div class="ds-text markdown-body">${htmlContent}</div>
        </div>`;

    const contentArea = document.querySelector('.ds-content');
    const currentTitle = document.querySelector('.ds-word-title-small');
    
    if (contentArea && currentTitle && currentTitle.innerText === "Translation") {
        contentArea.innerHTML = html;
        adjustWindowHeight(); 
    } else {
        renderPopup("Translation", html, "", true);
    }
}

// 辅助函数：动态调整窗口高度
function adjustWindowHeight() {
    setTimeout(() => {
        const header = document.querySelector('.ds-header');
        const footer = document.querySelector('.ds-footer');
        const content = document.querySelector('.ds-content');
        if(header && footer && content) {
            const total = header.offsetHeight + content.scrollHeight + footer.offsetHeight + 40; 
            ipcRenderer.send('resize-main-window', Math.min(total, 650)); 
        }
    }, 10);
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