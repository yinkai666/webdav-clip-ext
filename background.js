// 后台文件上传服务
const BASE_DIR = 'clipboard';
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2MB

// 上传状态存储
let uploadStatus = {
  uploading: false,
  fileName: '',
  progress: 0,
  error: null
};

// 大文件临时存储（用于跨页面传递文件数据）
let pendingLargeFile = null;
let pendingLargeFileTimeout = null;

// 清除待上传的大文件数据
function clearPendingLargeFile() {
  pendingLargeFile = null;
  if (pendingLargeFileTimeout) {
    clearTimeout(pendingLargeFileTimeout);
    pendingLargeFileTimeout = null;
  }
}

// Service Worker 激活时的日志
self.addEventListener('activate', () => {
  console.log('WebDAV Clipboard Service Worker 已激活');
});

// 解密函数
async function decrypt(data) {
  if (!data) return '';
  try {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode('webdav-clipboard-v1'), 'PBKDF2', false, ['deriveKey']);
    const cryptoKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('salt'), iterations: 100000, hash: 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
    const raw = atob(data);
    const iv = new Uint8Array([...raw.slice(0, 12)].map(c => c.charCodeAt(0)));
    const encrypted = new Uint8Array([...raw.slice(12)].map(c => c.charCodeAt(0)));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, encrypted);
    return new TextDecoder().decode(decrypted);
  } catch { return ''; }
}

// 获取配置
async function getConfig() {
  const stored = await chrome.storage.local.get(['url', 'user', 'encPass']);
  const pass = stored.encPass ? await decrypt(stored.encPass) : '';
  return {
    baseUrl: (stored.url || '').replace(/\/$/, ''),
    auth: 'Basic ' + btoa(unescape(encodeURIComponent(`${stored.user || ''}:${pass}`)))
  };
}

// 确保目录存在
async function ensureDir(config, dir) {
  await fetch(`${config.baseUrl}/${dir}/`, {
    method: 'MKCOL',
    headers: { 'Authorization': config.auth }
  });
}

// 后台上传文件
async function uploadFile(fileData) {
  const { name, type, data } = fileData;

  uploadStatus = {
    uploading: true,
    fileName: name,
    progress: 0,
    error: null
  };

  try {
    const config = await getConfig();
    if (!config.baseUrl) {
      throw new Error('未配置 WebDAV 地址');
    }

    // 确保目录存在
    await ensureDir(config, BASE_DIR);
    await ensureDir(config, `${BASE_DIR}/files`);

    // base64 转 ArrayBuffer
    const binaryString = atob(data.split(',')[1]);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // 使用 fetch 上传（Service Worker 不支持 XHR）
    const response = await fetch(`${config.baseUrl}/${BASE_DIR}/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: {
        'Authorization': config.auth,
        'Content-Type': type || 'application/octet-stream'
      },
      body: bytes.buffer
    });

    if (response.ok) {
      uploadStatus = { uploading: false, fileName: name, progress: 100, error: null };
      // 清除文件缓存
      await chrome.storage.local.remove('cachedFiles');
      return { success: true };
    } else {
      throw new Error(`上传失败: ${response.status}`);
    }
  } catch (e) {
    uploadStatus = { uploading: false, fileName: name, progress: 0, error: e.message };
    return { success: false, error: e.message };
  }
}

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'uploadFile') {
    uploadFile(message.fileData).then(sendResponse);
    return true; // 保持消息通道开放
  }

  if (message.type === 'getUploadStatus') {
    sendResponse(uploadStatus);
    return false;
  }

  if (message.type === 'clearUploadStatus') {
    uploadStatus = { uploading: false, fileName: '', progress: 0, error: null };
    sendResponse({ success: true });
    return false;
  }

  // 存储大文件数据（从 popup.js 发送）
  if (message.type === 'storeLargeFile') {
    // 清除之前的数据和定时器
    clearPendingLargeFile();

    // 存储新的文件数据
    pendingLargeFile = {
      name: message.name,
      type: message.fileType,
      size: message.size,
      data: message.data // ArrayBuffer 转换后的数组
    };

    // 设置 5 分钟超时自动清除（防止内存泄漏）
    pendingLargeFileTimeout = setTimeout(() => {
      console.log('大文件数据超时清除');
      clearPendingLargeFile();
    }, 5 * 60 * 1000);

    sendResponse({ success: true });
    return false;
  }

  // 获取大文件数据（从 upload.js 请求）
  if (message.type === 'getLargeFile') {
    const fileData = pendingLargeFile;
    // 获取后立即清除数据
    clearPendingLargeFile();
    sendResponse({ success: !!fileData, fileData });
    return false;
  }
});
