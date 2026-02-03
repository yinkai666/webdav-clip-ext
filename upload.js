document.addEventListener('DOMContentLoaded', async () => {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const expectedFile = document.getElementById('expectedFile');
  const sizeHint = document.getElementById('sizeHint');
  const progress = document.getElementById('progress');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const status = document.getElementById('status');
  const hint = document.querySelector('.hint');

  // 从 URL 参数获取期望的文件信息
  const params = new URLSearchParams(window.location.search);
  const expectedName = params.get('name');
  const expectedSize = parseInt(params.get('size')) || 0;
  const expectedType = params.get('type') || 'application/octet-stream';
  const fromBackground = params.get('fromBackground') === 'true';

  // 获取配置
  const stored = await chrome.storage.local.get(['url', 'user', 'encPass']);
  const pass = stored.encPass ? await decrypt(stored.encPass) : '';
  const baseUrl = (stored.url || '').replace(/\/$/, '');
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${stored.user || ''}:${pass}`)));

  if (!baseUrl) {
    status.textContent = '请先在扩展中配置 WebDAV 地址';
    status.classList.add('error');
    return;
  }

  // 如果数据来自 background，尝试获取文件数据并自动上传
  if (fromBackground && expectedName) {
    await tryAutoUpload();
  } else if (expectedName) {
    // 降级模式：显示文件选择界面
    fileInfo.style.display = 'block';
    expectedFile.textContent = `${expectedName} (${formatSize(expectedSize)})`;
    sizeHint.textContent = `请选择同名文件：${expectedName}`;
  }

  // 尝试从 background 获取文件数据并自动上传
  async function tryAutoUpload() {
    try {
      status.textContent = '正在获取文件数据...';
      status.classList.remove('error', 'success');

      const response = await chrome.runtime.sendMessage({ type: 'getLargeFile' });

      if (response && response.success && response.fileData) {
        const fileData = response.fileData;

        // 验证文件信息
        if (fileData.name !== expectedName) {
          console.warn('文件名不匹配', fileData.name, expectedName);
          fallbackToManualSelect();
          return;
        }

        // 更新 UI 提示
        hint.textContent = '文件数据已获取，正在自动上传...';
        fileInfo.style.display = 'block';
        expectedFile.textContent = `${fileData.name} (${formatSize(fileData.size)})`;
        sizeHint.textContent = '自动上传中...';

        // 将数组转换回 Uint8Array
        const uint8Array = new Uint8Array(fileData.data);

        // 创建 Blob 对象
        const blob = new Blob([uint8Array], { type: fileData.type });

        // 开始上传
        await uploadBlob(blob, fileData.name, fileData.type);
      } else {
        // 没有获取到数据，降级到手动选择
        console.log('未获取到文件数据，降级到手动选择');
        fallbackToManualSelect();
      }
    } catch (e) {
      console.error('自动上传失败:', e);
      fallbackToManualSelect();
    }
  }

  // 降级到手动文件选择
  function fallbackToManualSelect() {
    hint.textContent = '由于浏览器限制，大文件需要在此页面重新选择上传';
    status.textContent = '';
    status.classList.remove('error', 'success');
    fileInfo.style.display = 'block';
    expectedFile.textContent = `${expectedName} (${formatSize(expectedSize)})`;
    sizeHint.textContent = `请选择同名文件：${expectedName}`;
  }

  // 上传 Blob 数据
  async function uploadBlob(blob, fileName, fileType) {
    status.textContent = '';
    status.classList.remove('error', 'success');
    progress.classList.add('active');
    dropZone.style.display = 'none';

    try {
      // 确保目录存在
      await fetch(`${baseUrl}/clipboard/`, { method: 'MKCOL', headers: { 'Authorization': auth } });
      await fetch(`${baseUrl}/clipboard/files/`, { method: 'MKCOL', headers: { 'Authorization': auth } });

      // 上传
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${baseUrl}/clipboard/files/${encodeURIComponent(fileName)}`);
      xhr.setRequestHeader('Authorization', auth);
      xhr.setRequestHeader('Content-Type', fileType);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = percent + '%';
          progressText.textContent = percent + '%';
        }
      };

      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // 清除文件缓存
          await chrome.storage.local.remove('cachedFiles');
          status.textContent = '上传成功！可以关闭此页面';
          status.classList.add('success');
          fileInfo.style.display = 'none';
          hint.textContent = '上传完成';
        } else {
          status.textContent = '上传失败: ' + xhr.status;
          status.classList.add('error');
          resetUI();
        }
      };

      xhr.onerror = () => {
        status.textContent = '上传失败，网络错误';
        status.classList.add('error');
        resetUI();
      };

      xhr.send(blob);
    } catch (e) {
      status.textContent = '上传失败: ' + e.message;
      status.classList.add('error');
      resetUI();
    }
  }

  // 点击选择文件
  dropZone.addEventListener('click', () => fileInput.click());

  // 拖拽
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // 文件选择
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) handleFile(file);
  });

  async function handleFile(file) {
    // 如果有期望的文件名，检查是否匹配
    if (expectedName && file.name !== expectedName) {
      status.textContent = `文件名不匹配，期望：${expectedName}`;
      status.classList.add('error');
      status.classList.remove('success');
      return;
    }

    status.textContent = '';
    status.classList.remove('error', 'success');
    progress.classList.add('active');
    dropZone.style.display = 'none';
    fileInfo.style.display = 'none';

    try {
      // 确保目录存在
      await fetch(`${baseUrl}/clipboard/`, { method: 'MKCOL', headers: { 'Authorization': auth } });
      await fetch(`${baseUrl}/clipboard/files/`, { method: 'MKCOL', headers: { 'Authorization': auth } });

      // 上传
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${baseUrl}/clipboard/files/${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Authorization', auth);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          progressFill.style.width = percent + '%';
          progressText.textContent = percent + '%';
        }
      };

      xhr.onload = async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // 清除文件缓存
          await chrome.storage.local.remove('cachedFiles');
          status.textContent = '上传成功！可以关闭此页面';
          status.classList.add('success');
        } else {
          status.textContent = '上传失败: ' + xhr.status;
          status.classList.add('error');
          resetUI();
        }
      };

      xhr.onerror = () => {
        status.textContent = '上传失败，网络错误';
        status.classList.add('error');
        resetUI();
      };

      xhr.send(file);
    } catch (e) {
      status.textContent = '上传失败: ' + e.message;
      status.classList.add('error');
      resetUI();
    }
  }

  function resetUI() {
    progress.classList.remove('active');
    dropZone.style.display = 'block';
    if (expectedName) fileInfo.style.display = 'block';
    progressFill.style.width = '0%';
    progressText.textContent = '0%';
    fileInput.value = '';
  }
});

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

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
