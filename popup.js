const $ = id => document.getElementById(id);
let config = {};
const BASE_DIR = 'clipboard';
const INLINE_UPLOAD_LIMIT = 2 * 1024 * 1024; // 2MB
let deleteTarget = null;
let editingItem = null;
let allItems = [];
let previewCache = null;
let previewBlobUrl = null; // 用于清理 Blob URL
let cachedFiles = []; // 文件列表缓存
let filesLoading = false; // 请求节流
let orderCache = { order_files: [], order_texts: [] }; // 排序信息缓存
let orderSaveTimer = null; // 防抖定时器

// Theme management
function applyTheme(theme) {
  const app = document.querySelector('.app');
  app.classList.remove('theme-light', 'theme-dark', 'theme-system');
  if (theme === 'dark') {
    app.classList.add('theme-dark');
  } else if (theme === 'system') {
    app.classList.add('theme-system');
  }
  // light theme uses default CSS variables, no class needed
}

async function initTheme() {
  const stored = await chrome.storage.local.get('theme');
  const theme = stored.theme || 'light'; // 默认浅色
  applyTheme(theme);
  updateThemeUI(theme);
}

function updateThemeUI(theme) {
  document.querySelectorAll('.theme-option').forEach(btn => {
    const isActive = btn.dataset.theme === theme;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-checked', isActive);
  });
}

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
  // Initialize theme first for instant visual feedback
  await initTheme();

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
  // 先从本地缓存加载排序信息
  await loadOrderFromCache();
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
    // Toggle header buttons
    $('settingsBtn').style.display = 'none';
    $('backBtn').style.display = 'block';
    $('refreshBtn').style.display = 'none';
  });

  $('backBtn').addEventListener('click', () => {
    $('settings').classList.remove('active');
    document.querySelector('.tabs').style.display = 'flex';
    document.querySelector('.tab.active').click();
    // Toggle header buttons
    $('settingsBtn').style.display = 'block';
    $('backBtn').style.display = 'none';
    $('refreshBtn').style.display = 'inline-flex';
  });

  // Config buttons
  $('saveConfig').addEventListener('click', saveConfig);
  $('testConfig').addEventListener('click', testConfig);

  // Password visibility toggle
  $('togglePass').addEventListener('click', () => {
    const passInput = $('pass');
    const iconEye = document.querySelector('.icon-eye');
    const iconEyeOff = document.querySelector('.icon-eye-off');
    const isPassword = passInput.type === 'password';

    passInput.type = isPassword ? 'text' : 'password';
    iconEye.style.display = isPassword ? 'none' : 'block';
    iconEyeOff.style.display = isPassword ? 'block' : 'none';
    $('togglePass').setAttribute('aria-label', isPassword ? '隐藏密码' : '显示密码');
  });

  // Theme selector
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.theme;
      applyTheme(theme);
      updateThemeUI(theme);
      await chrome.storage.local.set({ theme });
    });
  });

  // New text button
  $('newTextBtn').addEventListener('click', () => openEditor());

  // Editor
  $('cancelEdit').addEventListener('click', closeEditor);
  $('saveEdit').addEventListener('click', saveText);

  // Delete confirmation
  $('cancelDelete').addEventListener('click', () => $('deleteConfirm').classList.remove('active'));
  $('confirmDelete').addEventListener('click', confirmDelete);

  // Preview
  $('closePreview').addEventListener('click', closePreview);
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

  // Drag and drop for reordering
  setupDragSort($('history'), 'texts');
  setupDragSort($('fileList'), 'files');

  // Search
  $('searchText').addEventListener('input', filterHistory);

  // Refresh button
  $('refreshBtn').addEventListener('click', async () => {
    // 刷新时也从服务器重新加载排序信息
    await loadOrderFromServer();
    // 根据当前激活的 tab 刷新对应列表
    const activeTab = document.querySelector('.tab.active');
    if (activeTab && activeTab.dataset.tab === 'files') {
      loadFiles(true);
    } else {
      loadHistory(true);
    }
  });

  // ESC key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('deleteConfirm').classList.contains('active')) {
        $('deleteConfirm').classList.remove('active');
        deleteTarget = null;
      } else if ($('editor').classList.contains('active')) {
        closeEditor();
      } else if ($('preview').classList.contains('active')) {
        closePreview();
      } else if ($('settings').classList.contains('active')) {
        $('backBtn').click();
      } else {
        closeAllActionMenus();
      }
    }
  });

  // Click outside to close action menus
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.list-item')) {
      closeAllActionMenus();
    }
  });

  // Background refresh
  if (config.url) {
    // 从服务器加载排序信息，然后刷新列表
    loadOrderFromServer().then(() => loadHistory());
  }
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

// 从 WebDAV 服务器读取排序信息
async function loadOrderFromServer() {
  try {
    const res = await fetch(`${baseUrl()}/${BASE_DIR}/order.json`, { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      orderCache = {
        order_files: data.order_files || [],
        order_texts: data.order_texts || []
      };
      // 同步到本地缓存
      await chrome.storage.local.set({ orderCache });
      return orderCache;
    } else if (res.status === 404) {
      // 服务器上没有排序文件，使用空排序
      orderCache = { order_files: [], order_texts: [] };
      return orderCache;
    }
    return null; // 其他错误
  } catch (e) {
    console.warn('读取排序信息失败:', e);
    return null;
  }
}

// 保存排序信息到 WebDAV 服务器（带防抖）
function saveOrderToServer() {
  // 清除之前的定时器
  if (orderSaveTimer) {
    clearTimeout(orderSaveTimer);
  }
  // 防抖：500ms 后保存
  orderSaveTimer = setTimeout(async () => {
    try {
      await ensureDir(BASE_DIR);
      const res = await fetch(`${baseUrl()}/${BASE_DIR}/order.json`, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(orderCache)
      });
      if (!res.ok) {
        console.warn('保存排序信息失败:', res.status);
      }
      // 同步到本地缓存
      await chrome.storage.local.set({ orderCache });
    } catch (e) {
      console.warn('保存排序信息失败:', e);
      // 网络错误时至少保存到本地
      await chrome.storage.local.set({ orderCache });
    }
  }, 500);
}

// 从本地缓存加载排序信息（作为 fallback）
async function loadOrderFromCache() {
  const stored = await chrome.storage.local.get('orderCache');
  if (stored.orderCache) {
    orderCache = stored.orderCache;
    return orderCache;
  }
  // 兼容旧格式
  const oldStored = await chrome.storage.local.get(['order_files', 'order_texts']);
  orderCache = {
    order_files: oldStored.order_files || [],
    order_texts: oldStored.order_texts || []
  };
  return orderCache;
}

// 初始化排序信息
async function initOrder() {
  // 先尝试从服务器加载
  const serverOrder = await loadOrderFromServer();
  if (serverOrder) {
    return serverOrder;
  }
  // 服务器失败时从本地缓存加载
  return await loadOrderFromCache();
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

function getSkeletonHTML(count = 5) {
  return Array.from({ length: count }).map(() => `
    <div class="list-item skeleton-item">
      <div class="list-item-header">
        <div class="list-item-info">
          <div class="skeleton-text" style="width:60%;height:16px;margin-bottom:4px"></div>
          <div class="skeleton-text" style="width:40%;height:12px"></div>
        </div>
      </div>
      <div class="list-item-preview">
        <div class="skeleton-text" style="width:80%;height:14px"></div>
      </div>
    </div>
  `).join('');
}

async function loadHistory(showLoading = false) {
  const refreshBtn = $('refreshBtn');
  if (showLoading && refreshBtn) refreshBtn.classList.add('loading');

  if (showLoading || !allItems.length) {
    $('history').innerHTML = getSkeletonHTML(5);
  }

  try {
    const files = await listDir(`${BASE_DIR}/texts`, true);
    if (files === null) {
      if (allItems.length > 0) {
        showStatus('网络异常，显示缓存数据', false);
        renderHistory(allItems);
      } else {
        showStatus('无法连接服务器', false);
        $('history').innerHTML = '';
      }
      if (refreshBtn) refreshBtn.classList.remove('loading');
      return;
    }

    if (!files.length) {
      allItems = [];
      renderHistory([]);
      await chrome.storage.local.set({ cachedTexts: [] });
      if (refreshBtn) refreshBtn.classList.remove('loading');
      return;
    }

    const stored = await chrome.storage.local.get(['cachedTexts']);
    const cachedMap = new Map((stored.cachedTexts || []).map(i => [i.name, i]));

    const items = await Promise.all(files.slice(-20).map(async f => {
      const cached = cachedMap.get(f.name);
      if (cached && cached.date && f.date && new Date(cached.date).getTime() === new Date(f.date).getTime()) {
        return { ...cached, date: f.date?.toISOString() };
      }
      try {
        const res = await fetch(`${baseUrl()}/${BASE_DIR}/texts/${f.name}`, { headers: headers() });
        const content = res.ok ? await res.text() : '';
        return { name: f.name, content, date: f.date?.toISOString() };
      } catch { return { name: f.name, content: '', date: f.date?.toISOString() }; }
    }));

    // 使用 orderCache 中的排序信息
    const order = orderCache.order_texts || [];
    const newItems = items.filter(i => !order.includes(i.name)).sort((a, b) => (b.date || 0) - (a.date || 0));
    const orderedItems = order.map(n => items.find(i => i.name === n)).filter(Boolean);
    allItems = [...newItems, ...orderedItems];

    renderHistory(allItems);
    await chrome.storage.local.set({ cachedTexts: allItems });
  } catch (err) {
    if (allItems.length > 0) {
      showStatus('同步失败，显示缓存数据', false);
      renderHistory(allItems);
    } else {
      showStatus('加载失败', false);
    }
  }
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
  if (!items.length) {
    $('history').innerHTML = `<div class="empty-state"><div class="empty-state-icon">📝</div><div class="empty-state-text">暂无文本<br>点击右下角 + 添加</div></div>`;
    return;
  }
  $('history').innerHTML = items.map(item => `
    <div class="list-item" draggable="true" data-name="${escapeHtml(item.name)}" data-content="${escapeHtml(item.content)}">
      <div class="list-item-header">
        <div class="list-item-info">
          <div class="list-item-title">${escapeHtml(item.name.replace('.txt', ''))}</div>
          <div class="list-item-time">${formatTime(item.name)}</div>
        </div>
        <button class="action-toggle" data-action="toggle" aria-label="更多操作"><span></span></button>
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

function closeAllActionMenus(exceptItem = null) {
  document.querySelectorAll('.list-item-actions.visible').forEach(actions => {
    const item = actions.closest('.list-item');
    if (exceptItem && item === exceptItem) return;
    actions.classList.remove('visible');
  });
}

function handleHistoryClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  const item = btn.closest('.list-item');
  if (!item) return;
  const name = item.dataset.name;
  const content = item.dataset.content;

  if (btn.dataset.action === 'toggle') {
    const actions = item.querySelector('.list-item-actions');
    if (!actions) return;
    const isVisible = actions.classList.contains('visible');
    closeAllActionMenus(item);
    if (!isVisible) {
      actions.classList.add('visible');
    } else {
      actions.classList.remove('visible');
    }
    return;
  }

  if (btn.dataset.action === 'copy') {
    navigator.clipboard.writeText(content);
    showStatus('已复制', true);
  } else if (btn.dataset.action === 'edit') {
    openEditor(name, content);
  } else if (btn.dataset.action === 'delete') {
    deleteTarget = { type: 'text', name };
    $('deleteConfirm').classList.add('active');
  }
  closeAllActionMenus();
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
    else {
      cachedFiles = []; // 清除缓存
      loadFiles(true);
    }
  } catch (e) {
    showStatus('删除失败', false);
  }

  btn.classList.remove('loading');
  $('deleteConfirm').classList.remove('active');
  deleteTarget = null;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDate(date) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// File functions
let filesInitialized = false; // 标记文件列表是否已初始化

async function loadFiles(forceRefresh = false) {
  if (filesLoading) return;

  // 首次加载时从 storage 读取缓存
  if (!filesInitialized) {
    const stored = await chrome.storage.local.get('cachedFiles');
    cachedFiles = stored.cachedFiles || [];
    filesInitialized = true;
  }

  // 有缓存且非强制刷新时，直接显示缓存，不发请求
  if (!forceRefresh && cachedFiles.length) {
    renderFiles(cachedFiles);
    return;
  }

  // 没有缓存时才发请求
  filesLoading = true;
  const list = await listDir(`${BASE_DIR}/files`, true);
  filesLoading = false;

  if (list === null) {
    if (cachedFiles.length) {
      showStatus('网络异常，显示缓存数据', false);
      renderFiles(cachedFiles);
    } else {
      showStatus('无法连接服务器', false);
      renderFiles([]);
    }
    return;
  }

  // 使用 orderCache 中的排序信息
  const order = orderCache.order_files || [];
  const items = list.map(f => ({ ...f, date: f.date?.toISOString() }));
  const newItems = items.filter(i => !order.includes(i.name)).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const orderedItems = order.map(n => items.find(i => i.name === n)).filter(Boolean);
  cachedFiles = [...newItems, ...orderedItems];

  await chrome.storage.local.set({ cachedFiles });
  renderFiles(cachedFiles);
}

let lastRenderedFilesKey = ''; // 用于避免重复渲染

function renderFiles(list) {
  // 生成内容 key，避免重复渲染导致闪烁
  const contentKey = list.map(f => `${f.name}:${f.size}`).join('|');
  if (contentKey === lastRenderedFilesKey && $('fileList').children.length > 0) {
    return; // 内容没变化，跳过渲染
  }
  lastRenderedFilesKey = contentKey;

  if (!list.length) {
    $('fileList').innerHTML = `<div class="empty-state"><div class="empty-state-icon">📁</div><div class="empty-state-text">暂无文件<br>拖拽文件到上方或点击 + 上传</div></div>`;
    return;
  }
  $('fileList').innerHTML = list.map(f => `
    <div class="list-item" draggable="true" data-name="${escapeHtml(f.name)}">
      <div class="list-item-header">
        <div class="list-item-info">
          <div class="list-item-title">${escapeHtml(f.name)}</div>
          <div class="list-item-meta">${formatSize(f.size)} · ${formatDate(f.date)}</div>
        </div>
        <button class="action-toggle" data-action="toggle" aria-label="更多操作"><span></span></button>
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
  if (!item) return;
  const name = item.dataset.name;

  if (btn.dataset.action === 'toggle') {
    const actions = item.querySelector('.list-item-actions');
    if (!actions) return;
    const isVisible = actions.classList.contains('visible');
    closeAllActionMenus(item);
    if (!isVisible) {
      actions.classList.add('visible');
    } else {
      actions.classList.remove('visible');
    }
    return;
  }

  if (btn.dataset.action === 'preview') {
    previewFile(name);
  } else if (btn.dataset.action === 'download') {
    downloadFile(name);
  } else if (btn.dataset.action === 'delete') {
    deleteTarget = { type: 'file', name };
    $('deleteConfirm').classList.add('active');
  }
  closeAllActionMenus();
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

function closePreview() {
  $('preview').classList.remove('active');
  // 清理 Blob URL 释放内存
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }
}

async function previewFile(name) {
  $('previewTitle').textContent = name;
  $('previewBody').innerHTML = '<div class="no-preview">加载中...</div>';
  $('preview').classList.add('active');

  // 清理之前的 Blob URL
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }

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
      previewBlobUrl = URL.createObjectURL(blob);
      $('previewBody').innerHTML = `<img src="${previewBlobUrl}">`;
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

async function doInlineUpload(file) {
  const progressBar = $('uploadProgress');
  progressBar.style.display = 'block';
  progressBar.querySelector('.progress-fill').style.width = '0%';
  progressBar.querySelector('.progress-text').textContent = '0%';

  try {
    await ensureDir(BASE_DIR);
    await ensureDir(`${BASE_DIR}/files`);

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${baseUrl()}/${BASE_DIR}/files/${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Authorization', headers()['Authorization']);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressBar.querySelector('.progress-fill').style.width = percent + '%';
        progressBar.querySelector('.progress-text').textContent = percent + '%';
      }
    };

    xhr.onload = () => {
      progressBar.style.display = 'none';
      if (xhr.status >= 200 && xhr.status < 300) {
        showStatus('上传成功', true);
        cachedFiles = [];
        loadFiles(true);
      } else {
        showStatus('上传失败: ' + xhr.status, false);
      }
    };

    xhr.onerror = () => {
      progressBar.style.display = 'none';
      showStatus('上传失败', false);
    };

    xhr.send(file);
  } catch (e) {
    progressBar.style.display = 'none';
    showStatus('上传失败', false);
  }
}

async function doUpload(file) {
  if (file.size <= INLINE_UPLOAD_LIMIT) {
    await doInlineUpload(file);
    return;
  }

  // 大文件：读取文件数据并通过 background.js 传递给 upload.html
  showStatus('处理大文件...', true);

  try {
    // 读取文件为 ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    // 转换为普通数组以便通过 chrome.runtime.sendMessage 传递
    const uint8Array = new Uint8Array(arrayBuffer);
    const dataArray = Array.from(uint8Array);

    // 尝试发送文件数据到 background.js 存储
    let useBackground = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'storeLargeFile',
        name: file.name,
        fileType: file.type || 'application/octet-stream',
        size: file.size,
        data: dataArray
      });
      useBackground = response && response.success;
    } catch (e) {
      console.warn('Service Worker 不可用，使用降级方案:', e.message);
      useBackground = false;
    }

    showStatus('正在打开上传页面...', true);
    // 打开上传页面，带上文件信息参数
    const params = new URLSearchParams({
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      fromBackground: useBackground ? 'true' : 'false'
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('upload.html') + '?' + params.toString() });
  } catch (e) {
    console.error('大文件处理失败:', e);
    showStatus('文件处理失败: ' + e.message, false);
  }
}

async function listDir(dir, withMeta = false) {
  try {
    const res = await fetch(`${baseUrl()}/${dir}/`, { method: 'PROPFIND', headers: { ...headers(), 'Depth': '1' } });
    if (!res.ok) {
      if (res.status === 404) return [];
      return null;
    }
    const text = await res.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'text/xml');
    const responses = xml.querySelectorAll('response');
    const items = [];
    responses.forEach(r => {
      const href = r.querySelector('href')?.textContent || '';
      const name = decodeURIComponent(href.split('/').filter(Boolean).pop());
      if (name === dir.split('/').pop() || name.endsWith('/')) return;
      if (withMeta) {
        const size = r.querySelector('getcontentlength')?.textContent || '0';
        const date = r.querySelector('getlastmodified')?.textContent || '';
        items.push({ name, size: parseInt(size), date: date ? new Date(date) : null });
      } else {
        items.push(name);
      }
    });
    return items;
  } catch { return null; }
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let draggedItem = null;
function setupDragSort(list, type) {
  list.addEventListener('dragstart', e => {
    draggedItem = e.target.closest('.list-item');
    if (draggedItem) draggedItem.classList.add('dragging');
  });
  list.addEventListener('dragend', () => {
    if (draggedItem) draggedItem.classList.remove('dragging');
    draggedItem = null;
  });
  list.addEventListener('dragover', e => {
    e.preventDefault();
    if (!draggedItem) return; // 防止 draggedItem 为 null
    const target = e.target.closest('.list-item');
    if (target && target !== draggedItem && target.parentNode) {
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      target.parentNode.insertBefore(draggedItem, after ? target.nextSibling : target);
    }
  });
  list.addEventListener('drop', async () => {
    const names = [...list.querySelectorAll('.list-item')].map(el => el.dataset.name);
    // 更新 orderCache 并保存到服务器
    if (type === 'files') {
      orderCache.order_files = names;
    } else if (type === 'texts') {
      orderCache.order_texts = names;
    }
    saveOrderToServer();
  });
}

function showStatus(msg, success) {
  const el = $('status');
  el.textContent = msg;
  el.className = success ? 'success show' : 'error show';
  setTimeout(() => el.classList.remove('show'), 2000);
}

// Load files when switching to files tab
document.querySelector('[data-tab="files"]').addEventListener('click', () => loadFiles());
