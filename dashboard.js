const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'words.json');

document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupControls();
});

// 朗读函数
function speak(text) {
    window.speechSynthesis.cancel();
    const msg = new SpeechSynthesisUtterance(text);
    msg.lang = 'en-US'; 
    window.speechSynthesis.speak(msg);
}

try {
    fs.watch(DB_PATH, (eventType, filename) => {
        if (filename) loadData();
    });
} catch (e) { console.log(e); }

function setupControls() {
    // 遮罩控制
    document.getElementById('btnHideAll').addEventListener('click', () => {
        document.querySelectorAll('.meaning-box, .code-meaning').forEach(el => {
            if (el.textContent.trim() !== '无' && el.textContent.trim() !== '') {
                el.classList.add('masked');
            }
        });
    });
    document.getElementById('btnShowAll').addEventListener('click', () => {
        document.querySelectorAll('.masked').forEach(el => el.classList.remove('masked'));
    });

    // --- 📤 导出功能 ---
    document.getElementById('btnExport').addEventListener('click', () => {
        try {
            if (!fs.existsSync(DB_PATH)) {
                alert('暂无数据可导出');
                return;
            }
            const data = fs.readFileSync(DB_PATH, 'utf-8');
            // 创建一个 Blob 对象
            const blob = new Blob([data], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            // 创建临时下载链接
            const a = document.createElement('a');
            a.href = url;
            // 文件名带上日期，如: words_backup_2024-05-20.json
            const dateStr = new Date().toISOString().split('T')[0];
            a.download = `words_backup_${dateStr}.json`;
            a.click();
            
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('导出失败: ' + e.message);
        }
    });

    // --- 📥 导入功能 ---
    const fileInput = document.getElementById('fileInput');
    const btnImport = document.getElementById('btnImport');

    // 点击按钮触发文件选择
    btnImport.addEventListener('click', () => {
        if(confirm("⚠️ 警告：导入备份将会【覆盖】当前所有数据！\n建议先导出备份当前数据。\n\n确定要继续吗？")) {
            fileInput.click();
        }
    });

    // 监听文件选择变化
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                // 校验一下是不是合法的 JSON
                const json = JSON.parse(event.target.result);
                if (typeof json !== 'object') throw new Error("格式不对");

                // 写入文件
                fs.writeFileSync(DB_PATH, JSON.stringify(json, null, 2), 'utf-8');
                loadData(); // 刷新界面
                alert('✅ 数据恢复成功！');
            } catch (err) {
                alert('❌ 导入失败：文件格式错误，请确保是本软件导出的 json 文件。');
            }
            // 清空 input，防止选同一个文件不触发 change
            fileInput.value = '';
        };
        reader.readAsText(file);
    });
}

function loadData() {
    const tbody = document.getElementById('word-list');
    const totalCount = document.getElementById('total-count');
    let db = {};
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, 'utf-8');
            db = JSON.parse(data);
        }
    } catch (e) { console.error(e); }
    
    let words = Object.keys(db).map(key => ({
        word: key,
        ...db[key]
    }));
    words.sort((a, b) => b.count - a.count);
    totalCount.textContent = words.length;
    tbody.innerHTML = '';
    
    if (words.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:50px;color:#ccc">暂无记录</td></tr>';
        return;
    }

    words.forEach((item, index) => {
        const general = item.general || '...';
        const coding = item.coding || '无';
        const phonetic = item.phonetic || ''; 

        let badgeClass = 'bg-new';
        let badgeText = '🌱';
        if (item.count > 10) { badgeClass = 'bg-hot'; badgeText = '🔥'; }
        else if (item.count > 3) { badgeClass = 'bg-warm'; badgeText = '📈'; }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="color:#999">${index + 1}</td>
            <td class="word-cell">
                ${item.word} 
                <span class="btn-speak" title="朗读">🔊</span>
            </td>
            <td class="phonetic-cell">${phonetic}</td>
            <td><div class="meaning-box">${general}</div></td>
            <td><div class="code-meaning">${coding}</div></td>
            <td style="text-align:center"><span class="count-badge ${badgeClass}">${badgeText} ${item.count}</span></td>
            <td style="text-align:right"><button class="btn-delete">🗑️</button></td>
        `;
        
        // 绑定朗读事件
        tr.querySelector('.btn-speak').addEventListener('click', (e) => {
            e.stopPropagation(); // 防止触发遮罩
            speak(item.word);
        });

        tr.querySelector('.btn-delete').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确定删除 "${item.word}" 的记录?`)) {
                try {
                    let currentDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
                    delete currentDb[item.word];
                    fs.writeFileSync(DB_PATH, JSON.stringify(currentDb, null, 2), 'utf-8');
                    loadData();
                } catch (e) {}
            }
        });
        tbody.appendChild(tr);
    });
    
    tbody.addEventListener('click', (e) => {
        const maskedElement = e.target.closest('.masked');
        if (maskedElement) maskedElement.classList.remove('masked');
    });
}