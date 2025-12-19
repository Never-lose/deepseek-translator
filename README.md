# 🚀 AI 翻译助手 (AI Translator)

![Electron](https://img.shields.io/badge/Electron-v33.0.0-blue?logo=electron)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Status](https://img.shields.io/badge/status-Stable-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

> \> **“不仅是翻译，更是你的 AI 编程副驾。”**
>
>  >  > 一款基于 Electron + **多核 AI 模型 (DeepSeek / Xiaomi / Google)** 构建的现代化桌面翻译工具。支持 **OCR 截图识别**、**智能代码分析** 与 **可视化单词复习本**。

---

## ✨ 功能亮点 (Features)

### 🧠 三核翻译引擎 (Tri-Core Engines)
- **🐋 DeepSeek V3 (推荐)**: 深度语言理解专家，特有的 **“编程模式”** 可智能分析代码逻辑，程序员的神器。
- **📱 Xiaomi MIMO (新增)**: 小米自研大模型，极速响应，支持 OpenAI 兼容协议，体验国产 AI 的力量。
- **🌐 Google 翻译 (免费)**: 响应速度快，无需配置 Key，适合日常快速查词（**免 Key 无限用**）。

### 👁️ 智慧之眼 (Smart OCR)
- 基于 **Tesseract.js** 的本地 OCR 引擎，**离线可用**。
- **截图识别**：按下快捷键（默认 `Ctrl+Alt+Q`），框选屏幕任意区域（报错信息、图片文字），瞬间提取并翻译。
- **路径猎人**：内置模型防丢失机制，自动搜索并修复 OCR 模型路径。

### 🎨 极致 UI 与交互
- **灵动窗口**：翻译卡片自动出现在屏幕正中央，支持**随意拖动**。
- **智能伸缩**：内容变长时，窗口以中心为轴向两端优雅展开，不再遮挡视线。
- **无边框设计**：完美圆角 + 弥散阴影，适配 Windows 11 云母质感。
- **🌙 深色模式**：全应用适配 Dark Mode，夜间编码不伤眼，一键秒切。

### 📊 单词复习本 Pro (Vocabulary Dashboard)
- **自动记录**：查询过的单词自动入库。
- **艾宾浩斯辅助**：
  - **🕒 排序切换**：支持按时间或查询频率排序。
  - **👁️ 遮挡模式**：一键模糊释义，点击才显示，背单词效率 Max。
  - **🔊 朗读发音**：内置 TTS 语音朗读。
  - **💾 数据备份**：支持 JSON 格式导入/导出，数据安全无忧。

---

## 📸 界面预览 (Screenshots)

|                   **设置界面 (Settings)**                   |                 **单词复习本 (Dashboard)**                 |
| :---------------------------------------------------------: | :--------------------------------------------------------: |
| <img src="assets/settings.png" alt="设置界面" width="100%"> | <img src="assets/dashboard.png" alt="复习本" width="100%"> |

---

## 🛠️ 安装与使用 (Installation)

### 方式一：直接下载 (推荐)
前往 [Releases](https://github.com/Never-lose/deepseek-translator/releases) 页面下载最新的 `.exe` 安装包。

### 方式二：开发者构建
如果你想自己修改代码，请按以下步骤操作：

1. **克隆项目**
   ```bash
   git clone [https://github.com/Never-lose/deepseek-translator.git](https://github.com/Never-lose/deepseek-translator.git)
   cd deepseek-translator



1. **安装依赖**

   Bash

   ```
   npm install
   ```

2. **启动开发模式**

   Bash

   ```
   npm start
   ```

3. **打包生成 exe**

   Bash

   ```
   npm run dist
   ```

------

## ⚙️ 快捷键 (Shortcuts)

| **功能**     | **默认快捷键**   | **说明**                     |
| ------------ | ---------------- | ---------------------------- |
| **划词翻译** | `Ctrl + Q`       | 选中这是文本后按下，自动弹出 |
| **截图识别** | `Ctrl + Alt + Q` | 调起截图工具，框选识别       |

*快捷键可在设置中自定义修改。*

------

## 📅 更新日志 (Changelog)

### v1.2.0 

- **✨ 新增**: 全面支持 **Xiaomi MIMO** 大模型，体验国产 AI 速度。
- **✨ 新增**: 翻译窗口支持 **随意拖动**，且高度变化时支持 **中心自适应伸缩**。
- **🐛 修复**: 解决了窗口在部分分辨率下飞出屏幕、底部内容被截断的问题。
- **🐛 修复**: 针对 Xiaomi 模型进行了 Prompt 优化，现在能稳定输出 **音标**。
- **💄 优化**: 设置页面重构，增加滚动条支持，防止小屏幕显示不全。
- **🔊 修复**: 修复了 TTS 朗读按钮点击无响应的 Bug。

------

### v1.2.1 (Latest)

- **🐛 修复**: 部分电脑按下划词翻译快捷键会触发 **NumLock 键**。
- **🐛 修复**: 部分电脑在多显示器环境下截图识别 Bug。
  - 注：**该 Bug 会导致在主显示截图时出现副显示器的画面，在副显示器截图会出现主显示器画面。**
- **🚧 有待修复**: 更改安装路径后，程序过几秒会自动退出。

------

## ❤️ 致谢 (Credits)

本项目由以下力量共同驱动：

- ✨ **核心代码生成**: [Google Gemini](https://gemini.google.com/)
- 🎨 **程序图标提供**: "海绵宝宝"
- 🤖 **模型支持**: DeepSeek, Xiaomi Cloud-ML, Google Translate

------

## 💬 反馈 (Feedback)

如果遇到 Bug 或有新功能建议，欢迎联系：

📧 Email: liusq2228@gmail.com

