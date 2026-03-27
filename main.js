'use strict';

var obsidian = require('obsidian');

/* ==============================================================
 *  SYSTEM PROMPT
 * ============================================================== */

var SYSTEM_PROMPT = [
  'You are an expert at converting screenshot images into Obsidian-compatible Markdown.',
  'Follow these rules strictly:',
  '',
  '## Extraction',
  '- Extract ALL visible text with perfect accuracy. Do not omit anything.',
  '- Preserve the ORIGINAL language (Chinese stays Chinese, English stays English, etc.).',
  '',
  '## Obsidian Markdown Syntax (use ONLY these)',
  '- Headings: # / ## / ### etc.',
  '- Bold: **text** | Italic: *text* | Highlight: ==text== | Strikethrough: ~~text~~',
  '- Unordered list: - item | Ordered list: 1. item',
  '- Task/checkbox: - [ ] todo / - [x] done',
  '- Code block: ```language (always specify language)',
  '- Inline code: `code`',
  '- Tables: | col | col | with |---| separator row; use alignment colons if needed',
  '- Block math: $$\\nLaTeX\\n$$ | Inline math: $LaTeX$',
  '- Blockquote: > text',
  '- Callout (for colored/highlighted boxes): > [!note], > [!tip], > [!warning], > [!info], > [!example]',
  '- Footnotes: text[^1] … [^1]: footnote content',
  '- Links: [text](url) | Images in screenshot → *[Image: brief description]*',
  '- Horizontal rule: ---',
  '- Tags: #tag (if visible in screenshot)',
  '',
  '## Structure',
  '- For diagrams/flowcharts, recreate with ```mermaid if feasible, otherwise describe.',
  '- Multi-column layouts → linearize logically (main content first, sidebar second).',
  '- Keep hierarchical nesting (indentation) accurate.',
  '- Do NOT convert text to ==highlight== only because it is colored. Use == == only when the source clearly indicates highlight/marking semantics.',
  '',
  '## Output',
  '- Output ONLY the Markdown content. No explanations, no preamble, no wrapping code fence.',
  '- Ensure blank lines around headings, code blocks, block math, and tables.',
].join('\n');

var USER_PROMPT = '请将这张截图的全部内容准确转换为 Obsidian 兼容的 Markdown 格式。保持原文语言不变。';

/* ==============================================================
 *  DEFAULT SETTINGS
 * ============================================================== */

var DEFAULT_SETTINGS = {
  provider: 'openai',
  openaiApiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  geminiApiKey: '',
  geminiBaseUrl: 'https://generativelanguage.googleapis.com',
  geminiModel: 'gemini-2.5-flash',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llava',
  showPreview: true,
  keepOriginalImage: false,
  newNoteFolder: 'pic2md',
  customPrompt: '',
};

/* ==============================================================
 *  HELPERS
 * ============================================================== */

function ab2b64(buffer) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  var bytes = new Uint8Array(buffer);
  var binary = '';
  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function cleanMarkdown(text) {
  text = (text || '').trim();
  var m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[1].trim() : text;
}

function normalizeBase64(input) {
  var b64 = String(input || '').trim();
  // Support accidental data URL input and strip all whitespace/newlines.
  var m = b64.match(/^data:.*?;base64,(.*)$/i);
  if (m) b64 = m[1];
  b64 = b64.replace(/\s+/g, '');
  // Defensive cleanup: avoid "...undefined" leaking into payload.
  if (b64.endsWith('undefined')) b64 = b64.slice(0, -'undefined'.length);
  return b64;
}

async function reencodeImageBase64(b64, srcMime, targetMime, quality) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('当前环境不支持图片重编码');
  }
  var clean = normalizeBase64(b64);
  return await new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        var ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('无法创建 Canvas 上下文'));
        // Fill white background before JPEG export to avoid black transparent areas.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        var dataUrl = canvas.toDataURL(targetMime || 'image/jpeg', quality || 0.9);
        var m = dataUrl.match(/^data:.*?;base64,(.*)$/i);
        if (!m || !m[1]) return reject(new Error('图片重编码失败'));
        resolve(m[1]);
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = function () {
      reject(new Error('图片加载失败，无法重编码'));
    };
    img.src = 'data:' + (srcMime || 'image/png') + ';base64,' + clean;
  });
}

function fmtErr(e, provider) {
  var s = e && (e.status || e.httpStatus);
  if (s === 400) return new Error(provider + ' 请求参数错误，请检查模型名/接口地址');
  if (s === 401) return new Error(provider + ' API Key 无效，请检查设置');
  if (s === 403) return new Error(provider + ' API Key 权限不足');
  if (s === 404) return new Error(provider + ' 模型不存在，请检查模型名称');
  if (s === 429) return new Error(provider + ' 请求频率超限，请稍后再试');
  if (s === 413) return new Error('图片太大，请缩小后重试');
  if (s >= 500) return new Error(provider + ' 服务器错误 (' + s + ')');
  var msg = (e && e.message) || '';
  if (msg.indexOf('ECONNREFUSED') >= 0) return new Error('无法连接 ' + provider + ' 服务');
  if (msg.indexOf('Failed to fetch') >= 0 || msg.indexOf('network') >= 0)
    return new Error('网络连接失败，请检查网络');
  return new Error(provider + ' 错误: ' + (msg || s || '未知'));
}

/* ==============================================================
 *  API CALLS  (use obsidian.requestUrl — no CORS issues)
 * ============================================================== */

async function callOpenAI(b64, mime, s) {
  var url = s.openaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
  var prompt = s.customPrompt || USER_PROMPT;
  try {
    var r = await obsidian.requestUrl({
      url: url,
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + s.openaiApiKey },
      body: JSON.stringify({
        model: s.openaiModel,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } },
            ],
          },
        ],
        max_tokens: 16384,
        temperature: 0.1,
      }),
    });
    return r.json.choices[0].message.content;
  } catch (e) { throw fmtErr(e, 'OpenAI'); }
}

async function callGemini(b64, mime, s, hasRetriedImageDecode) {
  var base = (s.geminiBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  var model = (s.geminiModel || 'gemini-2.5-flash').replace(/^models\//, '');
  var url = base + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + s.geminiApiKey;
  var prompt = s.customPrompt || USER_PROMPT;
  var safeB64 = normalizeBase64(b64);
  if (!safeB64 || !/^[A-Za-z0-9+/=]+$/.test(safeB64)) {
    throw new Error('Gemini 图片数据无效：base64 为空或格式错误');
  }
  var payload = JSON.stringify({
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: safeB64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 16384 },
  });

  try {
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!resp.ok) {
      var errBody = '';
      try { errBody = await resp.text(); } catch (_) {}
      var errMsg = '';
      try {
        var ej = JSON.parse(errBody);
        errMsg = (ej.error && ej.error.message) || errBody;
      } catch (_) { errMsg = errBody; }
      var err = new Error(errMsg || 'HTTP ' + resp.status);
      err.status = resp.status;
      throw err;
    }
    var data = await resp.json();
    var cand = data && data.candidates && data.candidates[0];
    var parts = cand && cand.content && cand.content.parts;
    var out = parts && parts.map(function (p) { return p.text || ''; }).join('\n').trim();
    if (!out) {
      var fb = data && data.promptFeedback && data.promptFeedback.blockReason;
      if (fb) throw new Error('Gemini 返回为空，原因: ' + fb);
      throw new Error('Gemini 返回为空，请检查模型权限或重试');
    }
    return out;
  } catch (e) {
    var msg = (e && e.message) ? e.message : '';
    var isImageDecodeErr = msg.indexOf('Unable to process input image') >= 0;
    if (isImageDecodeErr && !hasRetriedImageDecode) {
      try {
        var repaired = await reencodeImageBase64(safeB64, mime, 'image/jpeg', 0.9);
        return await callGemini(repaired, 'image/jpeg', s, true);
      } catch (_) {
        // Fall through to normal error mapping.
      }
    }
    if (e.message && (e.message.indexOf('ERR_CONNECTION') >= 0 || e.message.indexOf('Failed to fetch') >= 0 || e.message.indexOf('network') >= 0 || e.message.indexOf('ENOTFOUND') >= 0)) {
      throw new Error('无法连接 Gemini 服务 (' + (new URL(url)).hostname + ')。\n如果在国内，请在设置中将 API 地址改为代理地址，或开启系统代理/VPN。');
    }
    throw fmtErr(e, 'Gemini');
  }
}

async function callOllama(b64, mime, s) {
  var url = s.ollamaUrl.replace(/\/+$/, '') + '/api/generate';
  var prompt = s.customPrompt || USER_PROMPT;
  try {
    var r = await obsidian.requestUrl({
      url: url,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        model: s.ollamaModel,
        prompt: SYSTEM_PROMPT + '\n\n' + prompt,
        images: [b64],
        stream: false,
        options: { temperature: 0.1, num_predict: 16384 },
      }),
    });
    return r.json.response;
  } catch (e) { throw fmtErr(e, 'Ollama'); }
}

async function callAI(b64, mime, settings) {
  // Size check (~20MB limit)
  var sizeMB = (b64.length * 0.75) / (1024 * 1024);
  if (sizeMB > 20) {
    throw new Error('图片过大 (' + sizeMB.toFixed(1) + 'MB)，API 限制 20MB');
  }

  switch (settings.provider) {
    case 'gemini':
      if (!settings.geminiApiKey) throw new Error('请在插件设置中填写 Gemini API Key');
      return await callGemini(b64, mime, settings);
    case 'ollama':
      return await callOllama(b64, mime, settings);
    default:
      if (!settings.openaiApiKey) throw new Error('请在插件设置中填写 OpenAI API Key');
      return await callOpenAI(b64, mime, settings);
  }
}

/* ==============================================================
 *  IMAGE PICKER MODAL  (Browse + Drag-drop + Paste — 三合一)
 * ============================================================== */

class ImagePickerModal extends obsidian.Modal {
  constructor(app, callback) {
    super(app);
    this.callback = callback;
    this.resolved = false;
    this._onPaste = null;
  }

  onOpen() {
    var self = this;
    var el = this.contentEl;
    el.empty();
    el.addClass('pic2md-picker-modal');

    el.createEl('h3', { text: '📸 选择图片' });

    /* ---------- Drop zone ---------- */
    var zone = el.createDiv({ cls: 'pic2md-drop-zone' });
    zone.createDiv({ cls: 'pic2md-drop-icon', text: '🖼️' });
    zone.createEl('p', { text: '拖拽图片到此处  ·  粘贴截图(Ctrl+V)' });
    zone.createEl('p', { text: '或点击下方按钮选择文件', cls: 'pic2md-hint' });

    /* ---------- Browse button + hidden input ---------- */
    var btn = el.createEl('button', { text: '📂 浏览图片文件', cls: 'mod-cta pic2md-browse-btn' });

    var inp = el.createEl('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.style.cssText = 'position:absolute;left:-9999px;opacity:0;width:0;height:0;';

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      inp.value = '';          // reset so re-selecting same file still triggers change
      inp.click();
    });

    inp.addEventListener('change', function () {
      console.log('[Pic2Md] file input change, files:', inp.files && inp.files.length);
      if (inp.files && inp.files.length > 0) {
        self._readFile(inp.files[0]);
      }
    });

    /* ---------- Drag & drop ---------- */
    var prevent = function (e) { e.preventDefault(); e.stopPropagation(); };

    zone.addEventListener('dragenter', function (e) { prevent(e); zone.addClass('pic2md-drag-over'); });
    zone.addEventListener('dragover',  function (e) { prevent(e); zone.addClass('pic2md-drag-over'); });
    zone.addEventListener('dragleave', function (e) { prevent(e); zone.removeClass('pic2md-drag-over'); });
    zone.addEventListener('drop', function (e) {
      prevent(e);
      zone.removeClass('pic2md-drag-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0 && files[0].type.startsWith('image/')) {
        self._readFile(files[0]);
      } else {
        new obsidian.Notice('请拖入图片文件');
      }
    });

    /* ---------- Paste (global) ---------- */
    this._onPaste = function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
          e.preventDefault();
          var f = items[i].getAsFile();
          if (f) self._readFile(f);
          return;
        }
      }
    };
    document.addEventListener('paste', this._onPaste, true);
  }

  _readFile(file) {
    if (this.resolved) return;
    this.resolved = true;
    var self = this;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = reader.result;
      var m = dataUrl.match(/^data:(.*?);base64,(.*)$/s);
      if (m) {
        self.close();
        self.callback({ base64: m[2], mime: m[1], name: file.name });
      } else {
        self.resolved = false;
        new obsidian.Notice('❌ 无法解析图片数据');
      }
    };
    reader.onerror = function () {
      self.resolved = false;
      new obsidian.Notice('❌ 读取文件失败');
    };
    reader.readAsDataURL(file);
  }

  onClose() {
    if (this._onPaste) {
      document.removeEventListener('paste', this._onPaste, true);
      this._onPaste = null;
    }
    this.contentEl.empty();
  }
}

/* ==============================================================
 *  PREVIEW MODAL
 * ============================================================== */

class PreviewModal extends obsidian.Modal {
  constructor(app, markdown, onAction) {
    super(app);
    this.markdown = markdown;
    this.onAction = onAction;
  }

  async onOpen() {
    var self = this;
    var el = this.contentEl;
    el.addClass('pic2md-preview-modal');
    el.createEl('h3', { text: '📝 转换结果预览' });

    /* Tabs */
    var tabs = el.createDiv({ cls: 'pic2md-tabs' });
    var tPreview = tabs.createEl('button', { text: '预览', cls: 'pic2md-tab active' });
    var tSource  = tabs.createEl('button', { text: '源码', cls: 'pic2md-tab' });

    var aPreview = el.createDiv({ cls: 'pic2md-preview-area' });
    var aSource  = el.createDiv({ cls: 'pic2md-source-area' });
    aSource.style.display = 'none';

    /* Render preview */
    try {
      await obsidian.MarkdownRenderer.render(this.app, this.markdown, aPreview, '', this);
    } catch (_) {
      aPreview.createEl('pre', { text: this.markdown });
    }

    /* Source code */
    var pre = aSource.createEl('pre', { cls: 'pic2md-source' });
    pre.createEl('code', { text: this.markdown });

    tPreview.onclick = function () {
      tPreview.addClass('active'); tSource.removeClass('active');
      aPreview.style.display = ''; aSource.style.display = 'none';
    };
    tSource.onclick = function () {
      tSource.addClass('active'); tPreview.removeClass('active');
      aSource.style.display = ''; aPreview.style.display = 'none';
    };

    /* Buttons */
    var row = el.createDiv({ cls: 'pic2md-btn-row' });

    row.createEl('button', { text: '✅ 插入光标处', cls: 'mod-cta' })
      .addEventListener('click', function () { self.close(); self.onAction('insert'); });

    row.createEl('button', { text: '📋 复制' })
      .addEventListener('click', async function () {
        await navigator.clipboard.writeText(self.markdown);
        new obsidian.Notice('✅ 已复制到剪贴板');
      });

    row.createEl('button', { text: '📝 新建笔记' })
      .addEventListener('click', function () { self.close(); self.onAction('newNote'); });
  }

  onClose() { this.contentEl.empty(); }
}

/* ==============================================================
 *  VAULT IMAGE PICKER  (Fuzzy search)
 * ============================================================== */

class VaultImageModal extends obsidian.FuzzySuggestModal {
  constructor(app, cb) {
    super(app);
    this.cb = cb;
    this.setPlaceholder('搜索库中的图片...');
  }
  getItems() {
    var exts = ['png','jpg','jpeg','gif','webp','bmp'];
    return this.app.vault.getFiles().filter(function (f) {
      return exts.indexOf(f.extension.toLowerCase()) >= 0;
    });
  }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.cb(f); }
}

/* ==============================================================
 *  SETTINGS TAB
 * ============================================================== */

class Pic2MdSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    var p = this.plugin;
    var c = this.containerEl;
    c.empty();
    c.createEl('h2', { text: '📸 Pic2Md 设置' });

    /* ---- Provider ---- */
    new obsidian.Setting(c)
      .setName('AI 服务商')
      .setDesc('选择用于图片识别的 AI 服务')
      .addDropdown(function (dd) {
        dd.addOption('openai', 'OpenAI (GPT-4o 等)')
          .addOption('gemini', 'Google Gemini (免费额度大)')
          .addOption('ollama', 'Ollama (本地离线)')
          .setValue(p.settings.provider)
          .onChange(async function (v) {
            p.settings.provider = v;
            await p.saveSettings();
            p.settingTab.display();
          });
      });

    var pv = p.settings.provider;

    /* ---- OpenAI ---- */
    if (pv === 'openai') {
      c.createEl('h3', { text: 'OpenAI 配置' });
      new obsidian.Setting(c).setName('API Key').addText(function (t) {
        t.setPlaceholder('sk-...')
         .setValue(p.settings.openaiApiKey)
         .onChange(async function (v) { p.settings.openaiApiKey = v.trim(); await p.saveSettings(); });
        t.inputEl.type = 'password';
        t.inputEl.style.width = '100%';
      });
      new obsidian.Setting(c).setName('API 地址').setDesc('支持中转/Azure等兼容接口').addText(function (t) {
        t.setPlaceholder('https://api.openai.com/v1')
         .setValue(p.settings.openaiBaseUrl)
         .onChange(async function (v) { p.settings.openaiBaseUrl = v.trim(); await p.saveSettings(); });
        t.inputEl.style.width = '100%';
      });
      new obsidian.Setting(c).setName('模型').setDesc('推荐 gpt-4o').addText(function (t) {
        t.setPlaceholder('gpt-4o')
         .setValue(p.settings.openaiModel)
         .onChange(async function (v) { p.settings.openaiModel = v.trim(); await p.saveSettings(); });
      });
    }

    /* ---- Gemini ---- */
    if (pv === 'gemini') {
      c.createEl('h3', { text: 'Gemini 配置' });
      new obsidian.Setting(c).setName('API Key').setDesc('Google AI Studio 获取').addText(function (t) {
        t.setPlaceholder('AIza...')
         .setValue(p.settings.geminiApiKey)
         .onChange(async function (v) { p.settings.geminiApiKey = v.trim(); await p.saveSettings(); });
        t.inputEl.type = 'password';
        t.inputEl.style.width = '100%';
      });
      new obsidian.Setting(c).setName('API 地址').setDesc('可改为代理地址').addText(function (t) {
        t.setPlaceholder('https://generativelanguage.googleapis.com')
         .setValue(p.settings.geminiBaseUrl)
         .onChange(async function (v) { p.settings.geminiBaseUrl = v.trim(); await p.saveSettings(); });
        t.inputEl.style.width = '100%';
      });
      new obsidian.Setting(c).setName('模型').addText(function (t) {
        t.setPlaceholder('gemini-2.5-flash')
         .setValue(p.settings.geminiModel)
         .onChange(async function (v) { p.settings.geminiModel = v.trim(); await p.saveSettings(); });
      });
    }

    /* ---- Ollama ---- */
    if (pv === 'ollama') {
      c.createEl('h3', { text: 'Ollama 配置' });
      new obsidian.Setting(c).setName('服务地址').addText(function (t) {
        t.setPlaceholder('http://localhost:11434')
         .setValue(p.settings.ollamaUrl)
         .onChange(async function (v) { p.settings.ollamaUrl = v.trim(); await p.saveSettings(); });
        t.inputEl.style.width = '100%';
      });
      new obsidian.Setting(c).setName('模型').setDesc('先运行 ollama pull llava').addText(function (t) {
        t.setPlaceholder('llava')
         .setValue(p.settings.ollamaModel)
         .onChange(async function (v) { p.settings.ollamaModel = v.trim(); await p.saveSettings(); });
      });
    }

    /* ---- Test ---- */
    new obsidian.Setting(c)
      .setName('测试连接')
      .setDesc('用 1×1 像素图测试 API 是否连通')
      .addButton(function (b) {
        b.setButtonText('🧪 测试').onClick(async function () {
          b.setButtonText('⏳...');
          b.setDisabled(true);
          try {
            var tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAEngJj7l6w0AAAAABJRU5ErkJggg==';
            await callAI(tiny, 'image/png', p.settings);
            new obsidian.Notice('✅ 连接成功！');
          } catch (e) {
            new obsidian.Notice('❌ ' + e.message, 10000);
          }
          b.setButtonText('🧪 测试');
          b.setDisabled(false);
        });
      });

    /* ---- General ---- */
    c.createEl('h3', { text: '通用设置' });

    new obsidian.Setting(c).setName('转换后预览').setDesc('先弹窗预览确认，再选择插入方式')
      .addToggle(function (t) {
        t.setValue(p.settings.showPreview)
         .onChange(async function (v) { p.settings.showPreview = v; await p.saveSettings(); });
      });

    new obsidian.Setting(c).setName('保留原图引用').setDesc('结果末尾附折叠原图（仅库内图片）')
      .addToggle(function (t) {
        t.setValue(p.settings.keepOriginalImage)
         .onChange(async function (v) { p.settings.keepOriginalImage = v; await p.saveSettings(); });
      });

    new obsidian.Setting(c).setName('新笔记目录').setDesc('"新建笔记"时保存到此目录')
      .addText(function (t) {
        t.setPlaceholder('pic2md')
         .setValue(p.settings.newNoteFolder)
         .onChange(async function (v) { p.settings.newNoteFolder = v.trim(); await p.saveSettings(); });
      });

    new obsidian.Setting(c).setName('自定义提示词').setDesc('覆盖默认的用户提示词（留空=默认）')
      .addTextArea(function (t) {
        t.setPlaceholder(USER_PROMPT)
         .setValue(p.settings.customPrompt)
         .onChange(async function (v) { p.settings.customPrompt = v; await p.saveSettings(); });
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
      });
  }
}

/* ==============================================================
 *  MAIN PLUGIN
 * ============================================================== */

class Pic2MdPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    var self = this;

    this.statusBarEl = this.addStatusBarItem();
    this.settingTab = new Pic2MdSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    /* ---- Command: clipboard → markdown (needs editor) ---- */
    this.addCommand({
      id: 'pic2md-clipboard',
      name: '从剪贴板截图转 Markdown',
      editorCallback: function (editor) { self.handleClipboard(editor); },
    });

    /* ---- Command: file picker → markdown (needs editor) ---- */
    this.addCommand({
      id: 'pic2md-file',
      name: '选择图片文件转 Markdown',
      editorCallback: function (editor) { self.handleFilePicker(editor); },
    });

    /* ---- Command: clipboard → new note (no editor needed) ---- */
    this.addCommand({
      id: 'pic2md-clipboard-new-note',
      name: '从剪贴板截图创建新笔记',
      callback: function () { self.handleClipboardNewNote(); },
    });

    /* ---- Right-click context menu on image links ---- */
    this.registerEvent(
      this.app.workspace.on('editor-menu', function (menu, editor) {
        var cursor = editor.getCursor();
        var line = editor.getLine(cursor.line);
        var m = line.match(/!\[\[(.+?\.(png|jpe?g|gif|webp|bmp))\]\]/i) ||
                line.match(/!\[.*?\]\((.+?\.(png|jpe?g|gif|webp|bmp))\)/i);
        if (m) {
          menu.addItem(function (item) {
            item.setTitle('📸 Pic2Md: 转为 Markdown')
                .setIcon('image')
                .onClick(function () { self.handleInlineImage(editor, m[1]); });
          });
        }
      })
    );

    console.log('[Pic2Md] loaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* ============================================================
   *  HANDLERS
   * ============================================================ */

  async handleClipboard(editor) {
    try {
      var b64, mime;
      try {
        var items = await navigator.clipboard.read();
        for (var ci = 0; ci < items.length; ci++) {
          for (var ti = 0; ti < items[ci].types.length; ti++) {
            var type = items[ci].types[ti];
            if (type.startsWith('image/')) {
              var blob = await items[ci].getType(type);
              var ab = await blob.arrayBuffer();
              b64 = ab2b64(ab);
              mime = type;
              break;
            }
          }
          if (b64) break;
        }
      } catch (clipErr) {
        console.warn('[Pic2Md] clipboard.read() failed, showing picker', clipErr);
        new obsidian.Notice('⚠️ 无法直接读取剪贴板，请在弹窗中粘贴图片 (Ctrl+V)', 5000);
        this.handleFilePicker(editor);
        return;
      }

      if (!b64) {
        new obsidian.Notice('📋 剪贴板中没有图片，请先截图 (或使用"选择图片文件"命令)');
        return;
      }

      await this.doConvert(b64, mime, editor, null, 'clipboard');
    } catch (err) {
      console.error('[Pic2Md]', err);
      new obsidian.Notice('❌ ' + err.message, 8000);
    }
  }

  handleFilePicker(editor) {
    var self = this;
    new ImagePickerModal(this.app, async function (img) {
      await self.doConvert(img.base64, img.mime, editor, img.name, 'local-file');
    }).open();
  }

  handleVaultImage(editor) {
    var self = this;
    new VaultImageModal(this.app, async function (file) {
      try {
        var ab = await self.app.vault.readBinary(file);
        var b64 = ab2b64(ab);
        var mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
                        gif:'image/gif', webp:'image/webp', bmp:'image/bmp' };
        var mime = mimeMap[file.extension.toLowerCase()] || 'image/png';
        await self.doConvert(b64, mime, editor, file.name, 'vault');
      } catch (e) {
        new obsidian.Notice('❌ 读取图片失败: ' + e.message);
      }
    }).open();
  }

  async handleInlineImage(editor, imagePath) {
    try {
      var file = this.app.metadataCache.getFirstLinkpathDest(imagePath, '');
      if (!file) { new obsidian.Notice('❌ 找不到: ' + imagePath); return; }
      var ab = await this.app.vault.readBinary(file);
      var b64 = ab2b64(ab);
      var mimeMap = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
                      gif:'image/gif', webp:'image/webp', bmp:'image/bmp' };
      var mime = mimeMap[file.extension.toLowerCase()] || 'image/png';
      await this.doConvert(b64, mime, editor, file.name, 'inline-image');
    } catch (e) {
      new obsidian.Notice('❌ ' + e.message, 8000);
    }
  }

  async handleClipboardNewNote() {
    try {
      var b64, mime;
      var items = await navigator.clipboard.read();
      for (var ci = 0; ci < items.length; ci++) {
        for (var ti = 0; ti < items[ci].types.length; ti++) {
          var type = items[ci].types[ti];
          if (type.startsWith('image/')) {
            var blob = await items[ci].getType(type);
            var ab = await blob.arrayBuffer();
            b64 = ab2b64(ab);
            mime = type;
            break;
          }
        }
        if (b64) break;
      }
      if (!b64) { new obsidian.Notice('📋 剪贴板中没有图片'); return; }

      var notice = new obsidian.Notice('⏳ 正在转换...', 0);
      this.statusBarEl.setText('🔄 转换中...');
      try {
        var raw = await callAI(b64, mime, this.settings);
        var md = cleanMarkdown(raw);
        notice.hide();
        await this.createNewNote(md, 'clipboard');
        this.statusBarEl.setText('✅ 完成');
        new obsidian.Notice('✅ 新笔记已创建！');
      } catch (e) {
        notice.hide();
        this.statusBarEl.setText('❌ 失败');
        new obsidian.Notice('❌ ' + e.message, 8000);
      }
      var sb = this.statusBarEl;
      setTimeout(function () { sb.setText(''); }, 5000);
    } catch (err) {
      new obsidian.Notice('❌ ' + err.message, 8000);
    }
  }

  /* ============================================================
   *  CORE CONVERSION
   * ============================================================ */

  async doConvert(b64, mime, editor, imageName, sourceType) {
    var self = this;
    var sb = this.statusBarEl;
    sb.setText('🔄 正在识别转换...');
    var notice = new obsidian.Notice('⏳ 正在将图片转换为 Markdown...', 0);

    try {
      var raw = await callAI(b64, mime, this.settings);
      var md = cleanMarkdown(raw);

      var canEmbedOriginal = sourceType === 'vault' || sourceType === 'inline-image';
      if (this.settings.keepOriginalImage && canEmbedOriginal && imageName && imageName !== 'clipboard') {
        md += '\n\n> [!info]- 原图\n> ![[' + imageName + ']]\n';
      }

      notice.hide();

      if (this.settings.showPreview) {
        new PreviewModal(this.app, md, async function (action) {
          if (action === 'insert') {
            editor.replaceSelection(md);
          } else if (action === 'newNote') {
            await self.createNewNote(md, imageName);
          }
        }).open();
      } else {
        editor.replaceSelection(md);
      }

      sb.setText('✅ 转换完成');
      new obsidian.Notice('✅ 转换完成！');
    } catch (err) {
      notice.hide();
      sb.setText('❌ 转换失败');
      new obsidian.Notice('❌ 转换失败: ' + err.message, 8000);
      console.error('[Pic2Md]', err);
    }

    setTimeout(function () { sb.setText(''); }, 5000);
  }

  /* ============================================================
   *  CREATE NEW NOTE
   * ============================================================ */

  async createNewNote(markdown, source) {
    var folder = this.settings.newNoteFolder || 'pic2md';
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    var now = new Date();
    var ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var stem = (source && source !== 'clipboard')
      ? source.replace(/\.[^.]+$/, '') : 'screenshot';
    var filename = folder + '/' + stem + '_' + ts + '.md';

    var fm = '---\nsource: screenshot\ncreated: ' + now.toISOString() +
             '\noriginal: "' + (source || 'clipboard') + '"\n---\n\n';

    var file = await this.app.vault.create(filename, fm + markdown);
    await this.app.workspace.getLeaf('tab').openFile(file);
  }
}

/* ==============================================================
 *  EXPORT
 * ============================================================== */

module.exports = Pic2MdPlugin;
