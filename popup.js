const $ = id => document.getElementById(id);
let config = {};
const BASE_DIR = 'clipboard';
let deleteTarget = null;
let editingItem = null;
let allItems = [];
let previewCache = null;

// 加密相关
const CRYPTO_KEY_SEED = 'webdav-clipboard-v1';
let cryptoKey = null;

async function initCrypto() {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(CRYPTO_KEY_SEED), 'PBKDF2', false, ['deriveKey']);
  cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encrypt(text) {
  if (!text) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, enc.encode(text));
  return btoa(String.fromCharCode(...iv) + String.fromCharCode(...new Uint8Array(encrypted)));
}

async function decrypt(data) {
  if (!data) return '';
  try {
    const raw = atob(data);
    const iv = new Uint8Array([...raw.slice(0, 12)].map(c => c.charCodeAt(0)));
    const encrypted = new Uint8Array([...raw.slice(12)].map(c => c.charCodeAt(0)));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, encrypted);
    return new TextDecoder().decode(decrypted);
  } catch { return ''; }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initCrypto();
  const stored = await chrome.storage.local.get(['url', 'user', 'encPass', 'pass', 'cachedTexts', 'cachedFiles']);

  // 迁移旧的明文密码到加密存储
  let pass = '';
  if (stored.encPass) {
    pass = await decrypt(stored.encPass);
  } else if (stored.pass) {
    pass = stored.pass;
    // 迁移：加密并删除明文
    await chrome.storage.local.set({ encPass: await encrypt(pass) });
    await chrome.storage.local.remove('pass');
  }

  config = { url: stored.url, user: stored.user, pass };
  $('url').value = config.url || '';
  $('user').value = config.user || '';
  $('pass').value = config.pass || '';

  // Load cached data first (instant display)
  if (stored.cachedTexts) {
    allItems = stored.cachedTexts;
    renderHistory(allItems);
  }

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      $('text').classList.remove('active');
      $('files').classList.remove('active');
      $(tab.dataset.tab).classList.add('active');
    });
  });

  // Settings
  $('settingsBtn').addEventListener('click', () => {
    $('text').classList.remove('active');
    $('files').classList.remove('active');
    $('settings').classList.add('active');
    document.querySelector('.tabs').style.display = 'none';
  });

  $('backBtn').addEventListener('click', () => {
    $('settings').classList.remove('active');
    document.querySelector('.tabs').style.display = 'flex';
    document.querySelector('.tab.active').click();
  });

  // Config buttons
  $('saveConfig').addEventListener('click', saveConfig);
  $('testConfig').addEventListener('click', testConfig);

  // New text button
  $('newTextBtn').addEventListener('click', () => openEditor());

  // Editor
  $('cancelEdit').addEventListener('click', closeEditor);
  $('saveEdit').addEventListener('click', saveText);

  // Delete confirmation
  $('cancelDelete').addEventListener('click', () => $('deleteConfirm').classList.remove('active'));
  $('confirmDelete').addEventListener('click', confirmDelete);

  // Preview
  $('closePreview').addEventListener('click', () => $('preview').classList.remove('active'));
  $('previewDownload').addEventListener('click', downloadFromPreview);

  // File upload
  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', uploadFile);

  // Drag and drop
  const dropZone = $('dropZone');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', handleDrop);

  // History click events
  $('history').addEventListener('click', handleHistoryClick);
  $('fileList').addEventListener('click', handleFileClick);

  // Search
  $('searchText').addEventListener('input', filterHistory);

  // Refresh button
  $('refreshBtn').addEventListener('click', () => loadHistory(true));

  // Background refresh
  if (config.url) { loadHistory(); }
});

async function saveConfig() {
  const btn = $('saveConfig');
  btn.classList.add('loading');
  btn.disabled = true;

  const url = $('url').value;
  const user = $('user').value;
  const pass = $('pass').value;

  // HTTP 警告
  if (url && !url.startsWith('https://')) {
    showStatus('警告：HTTP 连接不安全，密码可能被截获', false);
  }

  config = { url, user, pass };
  await chrome.storage.local.set({ url, user, encPass: await encrypt(pass) });

  btn.classList.remove('loading');
  btn.disabled = false;
  if (url.startsWith('https://') || !url) showStatus('配置已保存', true);
}

async function testConfig() {
  const btn = $('testConfig');
  btn.classList.add('loading');
  btn.disabled = true;
  const testUrl = $('url').value;
  const testUser = $('user').value;
  const testPass = $('pass').value;

  if (!testUrl) {
    btn.classList.remove('loading');
    btn.disabled = false;
    return showStatus('请输入URL', false);
  }

  try {
    const str = `${testUser}:${testPass}`;
    const encoded = btoa(unescape(encodeURIComponent(str)));
    const res = await fetch(testUrl, {
      method: 'PROPFIND',
      headers: { 'Authorization': 'Basic ' + encoded, 'Depth': '0' }
    });
    if (res.ok || res.status === 207) {
      showStatus('连接成功', true);
    } else if (res.status === 401) {
      showStatus('认证失败', false);
    } else {
      showStatus('连接失败: ' + res.status, false);
    }
  } catch (e) {
    showStatus('连接失败', false);
  }
  btn.classList.remove('loading');
  btn.disabled = false;
}

function headers() {
  const str = `${config.user || ''}:${config.pass || ''}`;
  const encoded = btoa(unescape(encodeURIComponent(str)));
  return { 'Authorization': 'Basic ' + encoded };
}

function baseUrl() {
  return (config.url || '').replace(/\/$/, '');
}

async function ensureDir(dir) {
  await fetch(`${baseUrl()}/${dir}/`, { method: 'MKCOL', headers: headers() });
}

// Editor functions
function openEditor(name = '', content = '') {
  editingItem = name;
  $('editorTitle').textContent = name ? '编辑文本' : '新建文本';
  $('textName').value = name.replace('.txt', '');
  $('sharedText').value = content;
  $('editor').classList.add('active');
}

function closeEditor() {
  $('editor').classList.remove('active');
  editingItem = null;
}

async function saveText() {
  const text = $('sharedText').value;
  if (!text) return showStatus('请输入文本', false);

  const btn = $('saveEdit');
  btn.classList.add('loading');

  try {
    await ensureDir(BASE_DIR);
    await ensureDir(`${BASE_DIR}/texts`);

    const customName = $('textName').value.trim();
    const timestamp = new Date().toLocaleString().replace(/[/:]/g, '-');
    const name = customName || timestamp;

    // If editing, delete old file first if name changed
    if (editingItem && editingItem !== `${name}.txt`) {
      await fetch(`${baseUrl()}/${BASE_DIR}/texts/${editingItem}`, { method: 'DELETE', headers: headers() });
    }

    const res = await fetch(`${baseUrl()}/${BASE_DIR}/texts/${name}.txt`, {
      method: 'PUT', headers: headers(), body: text
    });

    if (!res.ok) {
      showStatus('保存失败: ' + res.status, false);
    } else {
      showStatus('保存成功', true);
      closeEditor();
      loadHistory();
    }
  } catch (e) {
    showStatus('保存失败', false);
  }
  btn.classList.remove('loading');
}

async function loadHistory(showLoading = false) {
  const refreshBtn = $('refreshBtn');
  if (showLoading && refreshBtn) refreshBtn.classList.add('loading');

  const files = await listDir(`${BASE_DIR}/texts`);
  if (!files.length) {
    allItems = [];
    $('history').innerHTML = '';
    await chrome.storage.local.set({ cachedTexts: [] });
    if (refreshBtn) refreshBtn.classList.remove('loading');
    return;
  }

  allItems = await Promise.all(files.slice(-20).reverse().map(async f => {
    try {
      const res = await fetch(`${baseUrl()}/${BASE_DIR}/texts/${f}`, { headers: headers() });
      const content = res.ok ? await res.text() : '';
      return { name: f, content };
    } catch { return { name: f, content: '' }; }
  }));

  renderHistory(allItems);
  await chrome.storage.local.set({ cachedTexts: allItems });
  if (refreshBtn) refreshBtn.classList.remove('loading');
}

function filterHistory() {
  const query = $('searchText').value.toLowerCase().trim();
  if (!query) {
    renderHistory(allItems);
    return;
  }
  const filtered = allItems.filter(item =>
    item.name.toLowerCase().includes(query) || item.content.toLowerCase().includes(query)
  );
  renderHistory(filtered);
}

function renderHistory(items) {
  $('history').innerHTML = items.map(item => `
    <div class="list-item" data-name="${escapeHtml(item.name)}" data-content="${escapeHtml(item.content)}">
      <div class="list-item-header">
        <div class="list-item-title">${escapeHtml(item.name.replace('.txt', ''))}</div>
        <div class="list-item-time">${formatTime(item.name)}</div>
      </div>
      <div class="list-item-preview">${escapeHtml(item.content)}</div>
      <div class="list-item-actions">
        <button data-action="copy">复制</button>
        <button data-action="edit">编辑</button>
        <button data-action="delete" class="danger">删除</button>
      </div>
    </div>
  `).join('');
}

function formatTime(name) {
  // Try to parse timestamp from name
  const match = name.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}/${match[2]}/${match[3]}`;
  return '';
}

function handleHistoryClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const item = btn.closest('.list-item');
  const name = item.dataset.name;
  const content = item.dataset.content;

  if (btn.dataset.action === 'copy') {
    navigator.clipboard.writeText(content);
    showStatus('已复制', true);
  } else if (btn.dataset.action === 'edit') {
    openEditor(name, content);
  } else if (btn.dataset.action === 'delete') {
    deleteTarget = { type: 'text', name };
    $('deleteConfirm').classList.add('active');
  }
}

async function confirmDelete() {
  if (!deleteTarget) return;
  const btn = $('confirmDelete');
  btn.classList.add('loading');

  try {
    const path = deleteTarget.type === 'text' ? `${BASE_DIR}/texts/${deleteTarget.name}` : `${BASE_DIR}/files/${deleteTarget.name}`;
    await fetch(`${baseUrl()}/${path}`, { method: 'DELETE', headers: headers() });
    showStatus('已删除', true);
    if (deleteTarget.type === 'text') loadHistory();
    else loadFiles();
  } catch (e) {
    showStatus('删除失败', false);
  }

  btn.classList.remove('loading');
  $('deleteConfirm').classList.remove('active');
  deleteTarget = null;
}

// File functions
async function loadFiles() {
  const list = await listDir(`${BASE_DIR}/files`);
  $('fileList').innerHTML = list.reverse().map(f => `
    <div class="list-item" data-name="${escapeHtml(f)}">
      <div class="list-item-header">
        <div class="list-item-title">${escapeHtml(f)}</div>
      </div>
      <div class="list-item-actions">
        <button data-action="preview">预览</button>
        <button data-action="download">下载</button>
        <button data-action="delete" class="danger">删除</button>
      </div>
    </div>
  `).join('');
}

function handleFileClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const item = btn.closest('.list-item');
  const name = item.dataset.name;

  if (btn.dataset.action === 'preview') {
    previewFile(name);
  } else if (btn.dataset.action === 'download') {
    downloadFile(name);
  } else if (btn.dataset.action === 'delete') {
    deleteTarget = { type: 'file', name };
    $('deleteConfirm').classList.add('active');
  }
}

async function downloadFile(name) {
  try {
    // 如果有缓存且是同一文件，直接使用缓存
    if (previewCache && previewCache.name === name) {
      downloadBlob(previewCache.blob, name);
      return;
    }
    const res = await fetch(`${baseUrl()}/${BASE_DIR}/files/${name}`, { headers: headers() });
    if (!res.ok) return showStatus('下载失败', false);
    const blob = await res.blob();
    downloadBlob(blob, name);
  } catch (e) {
    showStatus('下载失败', false);
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

function downloadFromPreview() {
  if (previewCache) downloadBlob(previewCache.blob, previewCache.name);
}

async function previewFile(name) {
  $('previewTitle').textContent = name;
  $('previewBody').innerHTML = '<div class="no-preview">加载中...</div>';
  $('preview').classList.add('active');

  try {
    const res = await fetch(`${baseUrl()}/${BASE_DIR}/files/${name}`, { headers: headers() });
    if (!res.ok) {
      $('previewBody').innerHTML = '<div class="no-preview">加载失败</div>';
      return;
    }
    const blob = await res.blob();
    previewCache = { name, blob };

    const ext = name.split('.').pop().toLowerCase();
    const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    const textExts = ['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'log', 'csv'];

    if (imgExts.includes(ext)) {
      $('previewBody').innerHTML = `<img src="${URL.createObjectURL(blob)}">`;
    } else if (textExts.includes(ext)) {
      const text = await blob.text();
      $('previewBody').innerHTML = `<pre>${escapeHtml(text)}</pre>`;
    } else {
      $('previewBody').innerHTML = `<div class="no-preview">不支持预览此文件类型<br>点击下载查看</div>`;
    }
  } catch (e) {
    $('previewBody').innerHTML = '<div class="no-preview">加载失败</div>';
  }
}

async function uploadFile() {
  const file = $('fileInput').files[0];
  if (!file) return;
  await doUpload(file);
  $('fileInput').value = '';
}

function handleDrop(e) {
  e.preventDefault();
  $('dropZone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) doUpload(file);
}

async function doUpload(file) {
  const btn = $('uploadBtn');
  const progress = $('uploadProgress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');

  btn.style.display = 'none';
  progress.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '0%';

  try {
    await ensureDir(BASE_DIR);
    await ensureDir(`${BASE_DIR}/files`);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${baseUrl()}/${BASE_DIR}/files/${file.name}`);
      xhr.setRequestHeader('Authorization', headers()['Authorization']);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = percent + '%';
          progressText.textContent = percent + '%';
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          showStatus('上传成功', true);
          loadFiles();
          resolve();
        } else {
          showStatus('上传失败', false);
          reject();
        }
      };

      xhr.onerror = () => {
        showStatus('上传失败', false);
        reject();
      };

      xhr.send(file);
    });
  } catch (e) {
    showStatus('上传失败', false);
  }

  progress.style.display = 'none';
  btn.style.display = 'block';
}

async function listDir(dir) {
  try {
    const res = await fetch(`${baseUrl()}/${dir}/`, { method: 'PROPFIND', headers: { ...headers(), 'Depth': '1' } });
    if (!res.ok) return [];
    const text = await res.text();
    const matches = text.match(/<D:href>[^<]+<\/D:href>/g) || [];
    return matches.map(m => decodeURIComponent(m.replace(/<\/?D:href>/g, '').split('/').filter(Boolean).pop()))
      .filter(n => n !== dir.split('/').pop() && !n.endsWith('/'));
  } catch { return []; }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function showStatus(msg, success) {
  const el = $('status');
  el.textContent = msg;
  el.className = success ? 'success show' : 'error show';
  setTimeout(() => el.classList.remove('show'), 2000);
}

// Load files when switching to files tab
document.querySelector('[data-tab="files"]').addEventListener('click', loadFiles);
