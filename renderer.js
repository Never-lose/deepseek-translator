const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// 判断是否包含中文 (保留作为辅助)
function hasChinese(text) {
    return /[\u4e00-\u9fa5]/.test(text);
}

const USER_DATA_PATH = ipcRenderer.sendSync('get-user-data-path');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const DB_PATH = path.join(USER_DATA_PATH, 'words.json');
const container = document.getElementById('app-container');

// 读取配置
function getConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            return { 
                engine: "google", 
                mimoUrl: "https://api.xiaomimimo.com/v1", 
                mimoModel: "mimo-v2-flash",
                mimoEnableCodeMode: true,
                mimoEnableCodeExplain: true,
                theme: "light",
                ...data 
            };
        }
    } catch (e) {}
    return { engine: "google", apiKey: "" };
}

const initConfig = getConfig();
let isPinned = true;

// --- 🎨 主题切换逻辑 ---
function applyTheme(theme) {
    document.body.classList.remove('dark-mode', 'transparent-mode');
    if (theme === 'dark' || theme === 'transparent') {
        document.body.classList.add('dark-mode');
        if (theme === 'transparent') {
            document.body.classList.add('transparent-mode');
        }
    }
}

// 初始化主题
let currentTheme = initConfig.theme || (initConfig.darkMode ? 'dark' : 'light');
applyTheme(currentTheme);

ipcRenderer.on('theme-changed', (event, theme) => {
    currentTheme = theme;
    applyTheme(theme);
});

// --- 💾 数据库读写 (原子写入) ---
function readDb() { 
    try { 
        if (!fs.existsSync(DB_PATH)) return {}; 
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); 
    } catch (e) { return {}; } 
}

function saveDb(data) { 
    try { 
        const tempPath = DB_PATH + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
        fs.renameSync(tempPath, DB_PATH);
    } catch (e) { 
        console.error("保存失败:", e);
    } 
}

function speak(text) { 
    if(!text) return; 
    window.speechSynthesis.cancel(); 
    const msg = new SpeechSynthesisUtterance(text); 
    msg.lang = 'en-US'; 
    window.speechSynthesis.speak(msg); 
}

document.addEventListener('keydown', (event) => { 
    if (event.key === 'Escape') ipcRenderer.send('hide-window'); 
});

// --- OCR 事件 ---
ipcRenderer.on('ocr-loading', () => { 
    renderPopup("🔍", `<div style="text-align:center;padding:40px;color:#999;font-size:14px;">正在提取文字...</div>`, "", false); 
});

ipcRenderer.on('ocr-error', (event, msg) => { 
    renderPopup("Error", `<div style="color:#ff5252;padding:10px;text-align:center;">${msg}</div>`, "", false); 
});

// --- 🚀 核心翻译逻辑 ---
ipcRenderer.on('start-translation', async (event, text) => {
    isPinned = true;
    const config = getConfig();
    const engine = config.engine || 'google';

    let processedText = text.replace(/([^\n])\n([^\n])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    
    // 👇👇👇 智能语种检测 (Smart Detection) 👇👇👇
    const chineseMatches = processedText.match(/[\u4e00-\u9fa5]/g) || [];
    const englishMatches = processedText.match(/[a-zA-Z]+/g) || []; 
    const chineseCount = chineseMatches.length;
    const englishCount = englishMatches.length;

    // 只有中文确实比英文多时，才认为是“汉译英”
    const isSourceChinese = chineseCount > 0 && (chineseCount > englishCount);
    
    const targetLangCode = isSourceChinese ? 'en' : 'zh-CN';
    const targetLangName = isSourceChinese ? '英文' : '中文';
    // 👆👆👆 智能检测结束 👆👆👆

    const wordCount = processedText.split(' ').length;
    const isSentence = wordCount > 3 || processedText.length > 30;

    // 检查 Key
    if ((engine === 'deepseek' && !config.apiKey) || (engine === 'xiaomi' && !config.mimoKey)) {
        renderPopup("Key Missing", `<div style="padding:20px;text-align:center;">请先在设置中配置 API Key</div>`, "", false);
        return;
    }

    const mode = engine === 'xiaomi' ? (config.mimoCodeModeType || 'always') : (config.codeModeType || 'always');
    const enableExplain = engine === 'xiaomi' ? config.mimoEnableCodeExplain : config.enableCodeExplain;
    let engineName = engine === 'xiaomi' ? 'Xiaomi' : (engine === 'deepseek' ? 'DeepSeek' : 'Google');
    
    // 显示 Loading
    renderPopup(isSentence ? "Translating..." : "Searching...", 
        `<div style="color:#999;font-size:13px;padding:30px 0;text-align:center;">正在使用 ${engineName} 思考...</div>`, "", isSentence);

    if (isSentence) {
        // --- 长句翻译模式 ---
        renderSentenceResult(processedText, "正在思考...", true);

        if (engine === 'google') {
            const result = await callGoogleTranslate(processedText, targetLangCode);
            renderSentenceResult(processedText, result, false);
        } else {
            const url = engine === 'xiaomi' ? `${config.mimoUrl.replace(/\/$/, "")}/chat/completions` : "https://api.deepseek.com/chat/completions";
            const key = engine === 'xiaomi' ? config.mimoKey : config.apiKey;
            const model = engine === 'xiaomi' ? config.mimoModel : (config.deepseekModel || "deepseek-chat");
            
            // 👇👇👇 核心升级：超级智能提示词 (Super Smart Prompt) 👇👇👇
            const explainLang = "中文"; // 无论翻成什么，解释总结永远用中文

            let prompt = "";
            
            if (mode === 'always') {
                // 【强制模式】开启：不做区分，全部进行深度处理
                prompt = `[指令] 你是学术与技术翻译专家。请执行以下操作：
1. **翻译**：将内容精准翻译为【${targetLangName}】。
2. **提炼与分析**（务必用${explainLang}）：
   - 若是文本：请列出 3-5 个【💡 核心要点】(Key Points) 并简要总结。
   - 若是代码：请解释代码逻辑与关键实现。
3. **格式**：使用 Markdown 排版。回复必须以 [TECH] 开头。
[内容] ${processedText}`;
            } else {
                // 【智能模式】：区分对待
                prompt = `[指令] 你是智能翻译助手。请先分析内容性质，再决定策略：

【情况1：需要深度处理】(符合以下任一条件)
- 内容是 **学术论文、长篇文章、技术文档**
- 内容是 **程序代码、错误日志、API文档**
> 行动：
  1. 翻译为【${targetLangName}】。
  2. 紧接着用${explainLang}输出【💡 核心要点总结】或【代码逻辑解析】。
  3. 回复必须以 [TECH] 开头。

【情况2：仅需简单翻译】(日常对话、短语、简单句)
> 行动：仅输出【${targetLangName}】翻译结果，不加任何解释。
> 回复必须以 [GENERAL] 开头。

[目标语言] ${targetLangName}
[内容] ${processedText}`;
            }
            // 👆👆👆 升级结束 👆👆👆

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
    else {
        // --- 单词查询模式 (保持不变) ---
        const cleanText = processedText.replace(/^[^\w\u4e00-\u9fa5#+]+|[^\w\u4e00-\u9fa5#+]+$/g, '') || processedText;
        const lowerWord = cleanText.toLowerCase();
        const db = readDb();
        
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

        let parsedData = {};
        if (engine === 'google') {
            const googleRaw = await callGoogleTranslate(cleanText, targetLangCode);
            parsedData = parseGoogleResult(googleRaw, cleanText);
        } else if (engine === 'xiaomi') {
            const raw = await callXiaomiMimoWord(cleanText, config, mode, targetLangName);
            if (raw.startsWith('❌')) { renderPopup(cleanText, `<div style="color:#ff5252">${raw}</div>`, "", false); return; }
            parsedData = parseDeepSeekResult(raw); 
        } else {
            const dsRaw = await translateWord(cleanText, config.apiKey, mode, targetLangName);
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

// --- 辅助函数 ---

async function translateWord(text, key, mode, targetLangName = "中文") {
    let prompt = "";
    if (mode === 'always') {
        prompt = `解释单词 "${text}"。必须包含编程含义。严格按格式输出：\n[音标]\n::通用:: [${targetLangName}含义]\n::编程:: [编程含义]`;
    } else {
        prompt = `解释单词 "${text}"。如果该单词在编程中有特定用途，请在 ::编程:: 块中说明，否则 ::编程:: 块请填“无”。
格式：
[音标]
::通用:: [${targetLangName}含义]
::编程:: [编程含义]`;
    }
    return await callDeepSeek(prompt, key);
}

async function callXiaomiMimoWord(text, config, mode, targetLangName = "中文") {
    let prompt = "";
    if (mode === 'always') {
        prompt = `解释单词 "${text}"。必须包含编程含义。严格遵循格式：\n[音标]\n::通用:: [${targetLangName}含义]\n::编程:: [编程含义]`;
    } else {
        prompt = `智能解释单词 "${text}"。判断其是否具有编程语境下的含义。格式：\n[音标]\n::通用:: [${targetLangName}含义]\n::编程:: [编程含义或填“无”]`;
    }
    return await callXiaomiApi(prompt, config);
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
    let isTech = isCodeExplainForce;

    // 智能标签判断
    let tagText = "机器翻译";
    let tagClass = "tag-general";

    if (trans.startsWith('[TECH]')) {
        isTech = true;
        displayTrans = trans.replace('[TECH]', '').trim();
        // 进一步判断是 代码解析 还是 重点总结
        if (displayTrans.includes("核心要点") || displayTrans.includes("Key Points")) {
             tagText = "深度总结"; // 如果是论文
        } else {
             tagText = "代码解析"; // 如果是代码
        }
        tagClass = "tag-coding";
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

    const badgeHtml = `<span class="ds-tag ${tagClass}">${tagText}</span>`;
    
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