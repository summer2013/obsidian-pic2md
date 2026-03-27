# Pic2Md - 截图转 Markdown

将截图（剪贴板 / 本地文件）通过 AI 视觉模型识别，并转换为 Obsidian 兼容的 Markdown。

支持：
- OpenAI（如 `gpt-4o`）
- Gemini（如 `gemini-2.5-flash`）
- Ollama（本地模型，如 `llava`）

## 功能特性

- 截图转 Markdown（尽量保留原有层级结构）
- 支持两种输入方式：
  - 剪贴板截图
  - 选择本地图片文件（支持拖拽 / 粘贴）
- 转换结果支持预览（渲染预览 + 源码）
- 一键插入当前光标 / 复制 / 新建笔记
- 可选在结果末尾附加原图引用（仅对库内/行内图片转换生效，本地文件导入不会附加）
- 内置连接测试按钮（1x1 图片探活）



## 安装

将以下文件放入：

`<Vault>/.obsidian/plugins/pic2md/`

- `manifest.json`
- `main.js`
- `style.css`

然后在 Obsidian 中：

1. 打开 **设置 -> 第三方插件**
2. 关闭安全模式（如尚未关闭）
3. 启用 `Pic2Md - 截图转Markdown`

## 快速开始

1. 打开插件设置，选择 AI 服务商
2. 填写对应的 API Key / 地址 / 模型
3. 点击 **🧪 测试连接**
4. 在命令面板执行以下命令之一：
   - `从剪贴板截图转 Markdown`
   - `选择图片文件转 Markdown`
   - `从剪贴板截图创建新笔记`
  
https://github.com/user-attachments/assets/7497a2ce-8d12-4400-89c3-7527cc89d5fa


## 配置说明

### OpenAI

- API Key：`sk-...`
- API 地址：默认 `https://api.openai.com/v1`
- 模型：推荐 `gpt-4o`

### Gemini

- API Key：Google AI Studio 申请
- API 地址：默认 `https://generativelanguage.googleapis.com`
- 模型：推荐 `gemini-2.5-flash`

### Ollama

- 服务地址：默认 `http://localhost:11434`
- 模型：如 `llava`

## 使用建议

- 图片尽量清晰、分辨率适中
- 单图建议小于 20MB（插件会进行大小限制检查）
- 对复杂排版（多栏、流程图）可通过自定义提示词提升结构还原质量

## 常见问题（FAQ）

### 1) 无法连接 Gemini/OpenAI

- 检查 API 地址是否可访问
- 检查系统代理 / VPN
- 国内网络建议配置可用代理地址

### 2) Ollama 连接失败

- 确认本地 Ollama 已启动
- 确认模型已下载（如 `ollama pull llava`）
- 确认地址和端口与插件设置一致

## API Key 与安全

- **本地存储**：密钥保存在 Obsidian 插件数据里（通常在 `<Vault>/.obsidian/plugins/pic2md/data.json`），为**明文**。任何能访问你仓库文件夹的人、备份、同步盘、误提交的 Git 都可能看到，请勿把 `.obsidian` 公开到公共仓库。
- **网络传输**：请求发往你配置的官方或代理地址；不要在不可信的第三方页面粘贴密钥。
- **界面与日志**：插件不会在普通成功路径把 Key 打到 Notice；错误信息里若包含请求 URL，会对 `key` / `api_key` 等查询参数做脱敏后再显示。
- **开发者工具**：若在 Obsidian 里打开开发者工具并查看网络请求，可能看到请求头或 URL 中的密钥，属于本地调试行为，注意录屏/共享屏幕时不要暴露。

## 命令列表

- 从剪贴板截图转 Markdown
- 选择图片文件转 Markdown
- 从剪贴板截图创建新笔记

## 版本信息

- 插件 ID：`pic2md`
- 当前版本：`1.0.0`

