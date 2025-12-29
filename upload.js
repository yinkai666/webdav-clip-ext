document.addEventListener('DOMContentLoaded', async () => {
  const filename = document.getElementById('filename');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const status = document.getElementById('status');

  const stored = await chrome.storage.local.get(['pendingUpload', 'url', 'user', 'encPass']);
  const upload = stored.pendingUpload;

  if (!upload) {
    filename.textContent = '无待上传文件';
    status.textContent = '请从扩展中选择文件';
    status.classList.add('error');
    return;
  }

  filename.textContent = upload.name;

  // 解密密码
  const pass = stored.encPass ? await decrypt(stored.encPass) : '';
  const baseUrl = (stored.url || '').replace(/\/$/, '');
  const auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${stored.user || ''}:${pass}`)));

  // base64 转 Blob
  const res = await fetch(upload.data);
  const blob = await res.blob();

  // 确保目录存在
  await fetch(`${baseUrl}/clipboard/`, { method: 'MKCOL', headers: { 'Authorization': auth } });
  await fetch(`${baseUrl}/clipboard/files/`, { method: 'MKCOL', headers: { 'Authorization': auth } });

  // 上传
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `${baseUrl}/clipboard/files/${upload.name}`);
  xhr.setRequestHeader('Authorization', auth);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = percent + '%';
      progressText.textContent = percent + '%';
    }
  };

  xhr.onload = async () => {
    await chrome.storage.local.remove('pendingUpload');
    if (xhr.status >= 200 && xhr.status < 300) {
      // 清除文件缓存，下次打开 popup 会重新加载
      await chrome.storage.local.remove('cachedFiles');
      status.textContent = '上传成功！可以关闭此页面';
      status.classList.add('success');
    } else {
      status.textContent = '上传失败: ' + xhr.status;
      status.classList.add('error');
    }
  };

  xhr.onerror = async () => {
    await chrome.storage.local.remove('pendingUpload');
    status.textContent = '上传失败';
    status.classList.add('error');
  };

  xhr.send(blob);
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
