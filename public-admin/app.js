// DialerVault Admin Application Logic
let allUsers = [];
let currentUserKey = null;
let currentFiles = [];
let activeBox = 'all'; // 'all' | 'Photos' | 'Videos' | 'Audio' | 'Other'
let activeSection = 'decrypted'; // 'decrypted' | 'encrypted'
let downloadedFileIds = new Set(); // Track downloaded & decrypted files

const serverUrlInput = document.getElementById('serverUrl');
const adminKeyInput = document.getElementById('adminKey');
const btnSaveConfig = document.getElementById('btnSaveConfig');
const btnRefresh = document.getElementById('btnRefresh');
const serverStatusText = document.getElementById('serverStatusText');
const userSearchInput = document.getElementById('userSearch');

const statTotalUsers = document.getElementById('statTotalUsers');
const statTotalFiles = document.getElementById('statTotalFiles');
const statTotalStorage = document.getElementById('statTotalStorage');
const statUnusual = document.getElementById('statUnusual');

// Views
const usersListView = document.querySelector('.content-section');
const vaultDetailView = document.getElementById('vaultDetailView');
const btnBackToUsers = document.getElementById('btnBackToUsers');

// Header in Detail
const detailUserName = document.getElementById('detailUserName');
const detailUserEmail = document.getElementById('detailUserEmail');
const detailTotalFilesPill = document.getElementById('detailTotalFilesPill');
const detailTotalSizePill = document.getElementById('detailTotalSizePill');
const btnRecoverManifest = document.getElementById('btnRecoverManifest');
const btnWipeUserFiles = document.getElementById('btnWipeUserFiles');
const btnDeleteUserAccount = document.getElementById('btnDeleteUserAccount');

// Section Tabs
const tabBtnDecrypted = document.getElementById('tabBtnDecrypted');
const tabBtnEncrypted = document.getElementById('tabBtnEncrypted');
const sectionDecrypted = document.getElementById('sectionDecrypted');
const sectionEncrypted = document.getElementById('sectionEncrypted');

// Recover All Buttons
const btnRecoverAllDecrypted = document.getElementById('btnRecoverAllDecrypted');
const btnRecoverAllEncrypted = document.getElementById('btnRecoverAllEncrypted');
const decryptedRecoverCount = document.getElementById('decryptedRecoverCount');
const encryptedRecoverCount = document.getElementById('encryptedRecoverCount');

// Tables
const usersTableBody = document.getElementById('usersTableBody');
const decryptedFilesTableBody = document.getElementById('decryptedFilesTableBody');
const encryptedFilesTableBody = document.getElementById('encryptedFilesTableBody');

// Progress Bar
const progressContainer = document.getElementById('downloadProgressBarContainer');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentText = document.getElementById('progressPercentText');
const progressBarFill = document.getElementById('progressBarFill');

// Box Counts
const boxCountAll = document.getElementById('boxCountAll');
const boxCountImages = document.getElementById('boxCountImages');
const boxCountVideos = document.getElementById('boxCountVideos');
const boxCountMusic = document.getElementById('boxCountMusic');
const boxCountOther = document.getElementById('boxCountOther');

// Load saved config
const savedServer = localStorage.getItem('dv_admin_server') || 'https://dialervaultbckend-production.up.railway.app';
const savedKey = localStorage.getItem('dv_admin_key') || 'dialervault_admin_secret_2026';
serverUrlInput.value = savedServer;
adminKeyInput.value = savedKey;

btnSaveConfig.addEventListener('click', () => {
  localStorage.setItem('dv_admin_server', serverUrlInput.value.trim().replace(/\/$/, ''));
  localStorage.setItem('dv_admin_key', adminKeyInput.value.trim());
  fetchUsers();
});

btnRefresh.addEventListener('click', fetchUsers);
userSearchInput.addEventListener('input', renderUsers);

// Back to Users List
btnBackToUsers.addEventListener('click', () => {
  vaultDetailView.classList.add('hidden');
  usersListView.classList.remove('hidden');
  progressContainer.classList.add('hidden');
});

// Section Tabs
tabBtnDecrypted.addEventListener('click', () => {
  activeSection = 'decrypted';
  tabBtnDecrypted.classList.add('active');
  tabBtnEncrypted.classList.remove('active');
  sectionDecrypted.classList.remove('hidden');
  sectionEncrypted.classList.add('hidden');
  renderDecryptedSection();
});

tabBtnEncrypted.addEventListener('click', () => {
  activeSection = 'encrypted';
  tabBtnEncrypted.classList.add('active');
  tabBtnDecrypted.classList.remove('active');
  sectionEncrypted.classList.remove('hidden');
  sectionDecrypted.classList.add('hidden');
  renderEncryptedSection();
});

// Box selection
document.querySelectorAll('.vault-box').forEach(box => {
  box.addEventListener('click', () => {
    document.querySelectorAll('.vault-box').forEach(b => b.classList.remove('active'));
    box.classList.add('active');
    activeBox = box.getAttribute('data-box');
    renderDecryptedSection();
  });
});

btnRecoverManifest.addEventListener('click', () => {
  if (!currentUserKey) return;
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();
  const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/manifest?adminKey=${encodeURIComponent(key)}`;
  triggerDownload(downloadUrl, `${currentUserKey}_vault_index.json`);
});

// Wipe All Files Button (User Vault)
if (btnWipeUserFiles) {
  btnWipeUserFiles.addEventListener('click', () => {
    if (currentUserKey) wipeUserFiles(currentUserKey);
  });
}

// Delete User Account Button (User Vault)
if (btnDeleteUserAccount) {
  btnDeleteUserAccount.addEventListener('click', () => {
    if (currentUserKey) deleteUserAccount(currentUserKey);
  });
}

// Recover All Decrypted
btnRecoverAllDecrypted.addEventListener('click', () => {
  const files = getFilteredDecryptedFiles();
  recoverBatch(files, 'decrypted');
});

// Recover All Encrypted
btnRecoverAllEncrypted.addEventListener('click', () => {
  recoverBatch(currentFiles, 'encrypted');
});

async function recoverBatch(files, mode) {
  if (!files || files.length === 0) return;

  progressContainer.classList.remove('hidden');
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pct = Math.round(((i + 1) / files.length) * 100);
    progressStatusText.textContent = `Recovering ${i + 1}/${files.length}: ${file.fileName || file.itemId} (${mode})...`;
    progressPercentText.textContent = `${pct}%`;
    progressBarFill.style.width = `${pct}%`;

    const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(file.itemId)}?mode=${mode}&adminKey=${encodeURIComponent(key)}`;
    triggerDownload(downloadUrl, mode === 'encrypted' ? `${file.itemId}.enc` : (file.fileName || `${file.itemId}.bin`));
    downloadedFileIds.add(file.itemId);

    await new Promise(r => setTimeout(r, 600));
  }

  progressStatusText.textContent = `✅ Successfully recovered all ${files.length} files (${mode})!`;
  if (mode === 'decrypted') renderDecryptedSection();
  setTimeout(() => {
    progressContainer.classList.add('hidden');
  }, 4000);
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDate(ts) {
  if (!ts || ts <= 0) return 'Never';
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function fetchUsers() {
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  serverStatusText.textContent = 'Connecting...';
  usersTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">Loading users from central server...</td></tr>`;

  try {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { 'x-admin-key': key }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();
    allUsers = data.users || [];

    serverStatusText.textContent = 'Online & Connected';
    document.querySelector('.status-dot').className = 'status-dot online';

    updateStats();
    renderUsers();
  } catch (err) {
    serverStatusText.textContent = `Error: ${err.message}`;
    document.querySelector('.status-dot').className = 'status-dot error';
    usersTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell" style="color: var(--danger)">Failed to load users: ${err.message}. Check Server URL &amp; Admin Key.</td></tr>`;
  }
}

function updateStats() {
  statTotalUsers.textContent = allUsers.length;
  const totalFiles = allUsers.reduce((sum, u) => sum + (u.totalFiles || 0), 0);
  const totalStorage = allUsers.reduce((sum, u) => sum + (u.usedBytes || 0), 0);
  const unusualCount = allUsers.filter(u => u.isSuspicious).length;

  statTotalFiles.textContent = totalFiles;
  statTotalStorage.textContent = formatBytes(totalStorage);
  statUnusual.textContent = unusualCount;
}

function renderUsers() {
  const query = userSearchInput.value.toLowerCase().trim();
  const filtered = allUsers.filter(u => {
    return (u.email && u.email.toLowerCase().includes(query)) ||
           (u.userKey && u.userKey.toLowerCase().includes(query));
  });

  if (filtered.length === 0) {
    usersTableBody.innerHTML = `<tr><td colspan="7" class="loading-cell">No users found.</td></tr>`;
    return;
  }

  usersTableBody.innerHTML = filtered.map(u => {
    const isSus = u.isSuspicious;
    const tagClass = isSus ? 'tag-suspicious' : 'tag-normal';
    const tagText = isSus ? '⚠️ Unusual Activity' : '✅ Normal';

    return `
      <tr>
        <td>
          <div class="user-cell">
            <span class="user-name">${escapeHtml(u.userKey)}</span>
            <span class="user-email">${escapeHtml(u.email || u.userKey)}</span>
          </div>
        </td>
        <td><span class="badge-tag ${tagClass}">${tagText}</span></td>
        <td><strong>${u.totalFiles}</strong> files</td>
        <td>${formatBytes(u.usedBytes)}</td>
        <td>${u.isLifetime100GB ? '⭐️ 100 GB Lifetime' : 'Free Tier (10 GB)'}</td>
        <td>${formatDate(u.lastBackupTime)}</td>
        <td>
          <div style="display: flex; gap: 8px;">
            <button class="btn-view-files" onclick="openFullUserVault('${escapeHtml(u.userKey)}', '${escapeHtml(u.email)}')">
              Open Vault &rarr;
            </button>
            <button class="btn-action-delete" onclick="deleteUserAccount('${escapeHtml(u.userKey)}')">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Open Full User Vault Page
window.openFullUserVault = async function(userKey, email) {
  currentUserKey = userKey;
  activeBox = 'all';
  activeSection = 'decrypted';
  downloadedFileIds.clear();

  document.querySelectorAll('.vault-box').forEach(b => b.classList.remove('active'));
  document.querySelector('.vault-box[data-box="all"]').classList.add('active');

  tabBtnDecrypted.classList.add('active');
  tabBtnEncrypted.classList.remove('active');
  sectionDecrypted.classList.remove('hidden');
  sectionEncrypted.classList.add('hidden');
  progressContainer.classList.add('hidden');

  detailUserName.textContent = `Vault: ${userKey}`;
  detailUserEmail.textContent = email || userKey;

  // Switch views
  usersListView.classList.add('hidden');
  vaultDetailView.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  decryptedFilesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading files from database &amp; Cloudflare R2...</td></tr>`;
  encryptedFilesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">Loading encrypted files...</td></tr>`;

  await reloadUserFiles(userKey);
};

async function reloadUserFiles(userKey) {
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}/files`, {
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    currentFiles = data.files || [];

    const totalBytes = currentFiles.reduce((sum, f) => sum + (f.fileSizeBytes || 0), 0);
    detailTotalFilesPill.textContent = `${currentFiles.length} files`;
    detailTotalSizePill.textContent = formatBytes(totalBytes);

    updateBoxCounts();
    renderDecryptedSection();
    renderEncryptedSection();
  } catch (err) {
    decryptedFilesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell" style="color: var(--danger)">Failed to load vault files: ${err.message}</td></tr>`;
  }
}

function updateBoxCounts() {
  boxCountAll.textContent = `${currentFiles.length} files`;
  boxCountImages.textContent = `${currentFiles.filter(f => isBoxCategory(f, 'Photos')).length} files`;
  boxCountVideos.textContent = `${currentFiles.filter(f => isBoxCategory(f, 'Videos')).length} files`;
  boxCountMusic.textContent = `${currentFiles.filter(f => isBoxCategory(f, 'Audio')).length} files`;
  boxCountOther.textContent = `${currentFiles.filter(f => isBoxCategory(f, 'Other')).length} files`;
}

function isBoxCategory(file, box) {
  const c = (file.category || '').toLowerCase();
  const target = box.toLowerCase();
  if (target === 'all') return true;
  if (target === 'photos' && (c === 'photos' || c === 'photo' || c === 'images' || c === 'image')) return true;
  if (target === 'videos' && (c === 'videos' || c === 'video')) return true;
  if (target === 'audio' && (c === 'audio' || c === 'music' || c === 'sound')) return true;
  if (target === 'other' && (c === 'documents' || c === 'document' || c === 'docs' || c === 'archives' || c === 'archive' || c === 'general')) return true;
  return false;
}

function getFilteredDecryptedFiles() {
  if (activeBox === 'all') return currentFiles;
  return currentFiles.filter(f => isBoxCategory(f, activeBox));
}

function renderDecryptedSection() {
  const files = getFilteredDecryptedFiles();
  decryptedRecoverCount.textContent = files.length;

  if (files.length === 0) {
    decryptedFilesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">No decrypted files in this box.</td></tr>`;
    return;
  }

  decryptedFilesTableBody.innerHTML = files.map(f => {
    const isDownloaded = downloadedFileIds.has(f.itemId);
    const statusBadge = isDownloaded
      ? `<span class="badge-status-downloaded">💾 Downloaded &amp; Decrypted</span>`
      : `<span class="badge-status-ready">✅ Decrypted from DB</span>`;

    const catIcon = getCategoryIcon(f.category);

    return `
      <tr>
        <td><span style="font-size: 18px; cursor: pointer;" onclick="openMediaPreviewById('${escapeHtml(f.itemId)}')">${catIcon}</span></td>
        <td>
          <strong style="color: var(--accent); cursor: pointer;" onclick="openMediaPreviewById('${escapeHtml(f.itemId)}')" title="Click to preview / play">
            ${escapeHtml(f.fileName || f.itemId)}
          </strong>
        </td>
        <td>${formatBytes(f.fileSizeBytes)}</td>
        <td>${statusBadge}</td>
        <td>${formatDate(f.uploadedAt)}</td>
        <td>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button class="btn-action-preview" onclick="openMediaPreviewById('${escapeHtml(f.itemId)}')" title="Play / Preview media">
              ▶️ Preview
            </button>
            <button class="btn-action-decrypted" onclick="recoverSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}', 'decrypted')">
              🔓 Recover
            </button>
            <button class="btn-action-delete" onclick="deleteSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}')">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderEncryptedSection() {
  encryptedRecoverCount.textContent = currentFiles.length;

  if (currentFiles.length === 0) {
    encryptedFilesTableBody.innerHTML = `<tr><td colspan="6" class="loading-cell">No encrypted files in cloud.</td></tr>`;
    return;
  }

  encryptedFilesTableBody.innerHTML = currentFiles.map(f => {
    return `
      <tr>
        <td><code>${escapeHtml(f.itemId)}.enc</code></td>
        <td>${escapeHtml(f.fileName || f.itemId)}</td>
        <td><span class="badge-tag tag-normal">${escapeHtml(f.category || 'General')}</span></td>
        <td>${formatBytes(f.fileSizeBytes)}</td>
        <td><span class="badge-tag tag-normal">Cloudflare R2 (AES-GCM)</span></td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn-action-encrypted" onclick="recoverSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}', 'encrypted')">
              🔒 Download .enc
            </button>
            <button class="btn-action-delete" onclick="deleteSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}')">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

window.recoverSingleFile = function(itemId, fileName, mode) {
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  progressContainer.classList.remove('hidden');
  progressStatusText.textContent = `Downloading ${fileName || itemId} (${mode})...`;
  progressPercentText.textContent = `100%`;
  progressBarFill.style.width = `100%`;

  const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(itemId)}?mode=${mode}&adminKey=${encodeURIComponent(key)}`;
  triggerDownload(downloadUrl, mode === 'encrypted' ? `${itemId}.enc` : (fileName || `${itemId}.bin`));
  downloadedFileIds.add(itemId);

  if (mode === 'decrypted') {
    renderDecryptedSection();
  }

  setTimeout(() => {
    progressContainer.classList.add('hidden');
  }, 2500);
};

// 1. Delete single file
window.deleteSingleFile = async function(itemId, fileName) {
  if (!confirm(`Are you sure you want to permanently delete '${fileName || itemId}' from Cloudflare R2 and database?`)) {
    return;
  }

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/file/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    if (res.ok) {
      alert(`Deleted: ${fileName || itemId}`);
      await reloadUserFiles(currentUserKey);
      fetchUsers();
    } else {
      alert(`Error: ${data.error || 'Failed to delete file'}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

// 2. Wipe all user files
window.wipeUserFiles = async function(userKey) {
  if (!confirm(`⚠️ DANGER: Are you sure you want to wipe ALL files for user '${userKey}' from Cloudflare R2 and database? This cannot be undone!`)) {
    return;
  }

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}/files`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    if (res.ok) {
      alert(`All files for '${userKey}' have been permanently deleted.`);
      await reloadUserFiles(userKey);
      fetchUsers();
    } else {
      alert(`Error: ${data.error || 'Failed to wipe files'}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

// 3. Delete user account
window.deleteUserAccount = async function(userKey) {
  if (!confirm(`🚨 CRITICAL: Are you sure you want to permanently delete user '${userKey}', their account, and all their cloud files?`)) {
    return;
  }

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}`, {
      method: 'DELETE',
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    if (res.ok) {
      alert(`User '${userKey}' has been completely removed.`);
      vaultDetailView.classList.add('hidden');
      usersListView.classList.remove('hidden');
      fetchUsers();
    } else {
      alert(`Error: ${data.error || 'Failed to delete user'}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
};

function getCategoryIcon(cat) {
  const c = (cat || '').toLowerCase();
  if (c.includes('photo') || c.includes('image')) return '🖼️';
  if (c.includes('video')) return '🎬';
  if (c.includes('audio') || c.includes('music')) return '🎵';
  if (c.includes('doc')) return '📄';
  if (c.includes('archive') || c.includes('zip')) return '🗂️';
  return '📁';
}

// ========================================================
// MEDIA PREVIEW PLAYER MODAL LOGIC (PHOTO & VIDEO PLAYER)
// ========================================================
const mediaPlayerModal = document.getElementById('mediaPlayerModal');
const playerTypeIcon = document.getElementById('playerTypeIcon');
const playerFileName = document.getElementById('playerFileName');
const playerMeta = document.getElementById('playerMeta');
const btnPlayerDownload = document.getElementById('btnPlayerDownload');
const btnPlayerClose = document.getElementById('btnPlayerClose');

const videoContainer = document.getElementById('videoContainer');
const videoPlayer = document.getElementById('videoPlayer');
const imageContainer = document.getElementById('imageContainer');
const imagePreview = document.getElementById('imagePreview');
const audioContainer = document.getElementById('audioContainer');
const audioPlayer = document.getElementById('audioPlayer');
const audioTrackName = document.getElementById('audioTrackName');
const docContainer = document.getElementById('docContainer');
const docNotice = document.getElementById('docNotice');
const btnDocDownload = document.getElementById('btnDocDownload');
const mediaLoadingSpinner = document.getElementById('mediaLoadingSpinner');

let currentPreviewFile = null;

window.openMediaPreviewById = function(itemId) {
  const file = currentFiles.find(f => f.itemId === itemId);
  if (!file) return;
  openMediaPreview(file);
};

window.openMediaPreview = function(file) {
  currentPreviewFile = file;
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  playerFileName.textContent = file.fileName || file.itemId;
  playerMeta.textContent = `${file.category} • ${formatBytes(file.fileSizeBytes)} • Decrypted from database`;

  // Hide all containers
  videoContainer.classList.add('hidden');
  imageContainer.classList.add('hidden');
  audioContainer.classList.add('hidden');
  docContainer.classList.add('hidden');
  mediaLoadingSpinner.classList.remove('hidden');

  // Reset media elements
  videoPlayer.pause();
  videoPlayer.src = '';
  audioPlayer.pause();
  audioPlayer.src = '';
  imagePreview.src = '';

  const mediaUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(file.itemId)}?mode=decrypted&adminKey=${encodeURIComponent(key)}`;

  const fileName = (file.fileName || '').toLowerCase();
  const category = (file.category || '').toLowerCase();

  const isVideo = category.includes('video') || fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.mkv') || fileName.endsWith('.webm') || fileName.endsWith('.3gp');
  const isImage = category.includes('photo') || category.includes('image') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg') || fileName.endsWith('.png') || fileName.endsWith('.gif') || fileName.endsWith('.webp') || fileName.endsWith('.bmp');
  const isAudio = category.includes('audio') || category.includes('music') || fileName.endsWith('.mp3') || fileName.endsWith('.wav') || fileName.endsWith('.m4a') || fileName.endsWith('.ogg') || fileName.endsWith('.flac');

  if (isVideo) {
    playerTypeIcon.textContent = '🎬';
    videoContainer.classList.remove('hidden');
    videoPlayer.src = mediaUrl;
    videoPlayer.load();

    const onCanPlay = () => {
      mediaLoadingSpinner.classList.add('hidden');
      videoPlayer.play().catch(() => {});
      videoPlayer.removeEventListener('canplay', onCanPlay);
    };
    videoPlayer.addEventListener('canplay', onCanPlay);

    setTimeout(() => mediaLoadingSpinner.classList.add('hidden'), 3500);
  } else if (isImage) {
    playerTypeIcon.textContent = '🖼️';
    imageContainer.classList.remove('hidden');
    imagePreview.onload = () => {
      mediaLoadingSpinner.classList.add('hidden');
    };
    imagePreview.onerror = () => {
      mediaLoadingSpinner.classList.add('hidden');
    };
    imagePreview.src = mediaUrl;
  } else if (isAudio) {
    playerTypeIcon.textContent = '🎵';
    audioContainer.classList.remove('hidden');
    audioTrackName.textContent = file.fileName || file.itemId;
    audioPlayer.src = mediaUrl;
    audioPlayer.load();

    const onAudioCanPlay = () => {
      mediaLoadingSpinner.classList.add('hidden');
      audioPlayer.play().catch(() => {});
      audioPlayer.removeEventListener('canplay', onAudioCanPlay);
    };
    audioPlayer.addEventListener('canplay', onAudioCanPlay);

    setTimeout(() => mediaLoadingSpinner.classList.add('hidden'), 2500);
  } else {
    playerTypeIcon.textContent = '📄';
    docContainer.classList.remove('hidden');
    docNotice.textContent = `${file.fileName || file.itemId} (${formatBytes(file.fileSizeBytes)})`;
    mediaLoadingSpinner.classList.add('hidden');
  }

  mediaPlayerModal.classList.remove('hidden');
};

window.closeMediaPreview = function() {
  videoPlayer.pause();
  videoPlayer.src = '';
  audioPlayer.pause();
  audioPlayer.src = '';
  imagePreview.src = '';
  mediaPlayerModal.classList.add('hidden');
  currentPreviewFile = null;
};

if (btnPlayerClose) {
  btnPlayerClose.addEventListener('click', closeMediaPreview);
}

if (mediaPlayerModal) {
  mediaPlayerModal.addEventListener('click', (e) => {
    if (e.target === mediaPlayerModal) closeMediaPreview();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mediaPlayerModal && !mediaPlayerModal.classList.contains('hidden')) {
    closeMediaPreview();
  }
});

if (btnPlayerDownload) {
  btnPlayerDownload.addEventListener('click', () => {
    if (currentPreviewFile) {
      recoverSingleFile(currentPreviewFile.itemId, currentPreviewFile.fileName, 'decrypted');
    }
  });
}

if (btnDocDownload) {
  btnDocDownload.addEventListener('click', () => {
    if (currentPreviewFile) {
      recoverSingleFile(currentPreviewFile.itemId, currentPreviewFile.fileName, 'decrypted');
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Initial load
fetchUsers();

