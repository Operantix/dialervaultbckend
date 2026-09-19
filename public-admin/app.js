// DialerVault Admin Application Logic
let allUsers = [];
let currentUserKey = null;
let currentFiles = [];
let activeCategory = 'all';
let recoveryMode = 'decrypted'; // 'decrypted' | 'encrypted'

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

const usersTableBody = document.getElementById('usersTableBody');
const userFilesModal = document.getElementById('userFilesModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const modalUserName = document.getElementById('modalUserName');
const modalUserEmail = document.getElementById('modalUserEmail');
const btnRecoverManifest = document.getElementById('btnRecoverManifest');
const btnRecoverAll = document.getElementById('btnRecoverAll');
const recoverAllCount = document.getElementById('recoverAllCount');
const filesTableBody = document.getElementById('filesTableBody');

const btnModeDecrypted = document.getElementById('btnModeDecrypted');
const btnModeEncrypted = document.getElementById('btnModeEncrypted');
const progressContainer = document.getElementById('downloadProgressBarContainer');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentText = document.getElementById('progressPercentText');
const progressBarFill = document.getElementById('progressBarFill');

// Folder counts
const fCountAll = document.getElementById('fCountAll');
const fCountPhotos = document.getElementById('fCountPhotos');
const fCountVideos = document.getElementById('fCountVideos');
const fCountAudio = document.getElementById('fCountAudio');
const fCountDocs = document.getElementById('fCountDocs');
const fCountArchives = document.getElementById('fCountArchives');

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

btnCloseModal.addEventListener('click', () => {
  userFilesModal.classList.add('hidden');
});

window.addEventListener('click', (e) => {
  if (e.target === userFilesModal) {
    userFilesModal.classList.add('hidden');
  }
});

// Mode Toggles
btnModeDecrypted.addEventListener('click', () => {
  recoveryMode = 'decrypted';
  btnModeDecrypted.classList.add('active');
  btnModeEncrypted.classList.remove('active');
  renderFilesTable();
});

btnModeEncrypted.addEventListener('click', () => {
  recoveryMode = 'encrypted';
  btnModeEncrypted.classList.add('active');
  btnModeDecrypted.classList.remove('active');
  renderFilesTable();
});

// Category Folder Clicks
document.querySelectorAll('.folder-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.folder-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    activeCategory = card.getAttribute('data-category');
    renderFilesTable();
  });
});

btnRecoverManifest.addEventListener('click', () => {
  if (!currentUserKey) return;
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();
  const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/manifest?adminKey=${encodeURIComponent(key)}`;
  triggerDownload(downloadUrl, `${currentUserKey}_vault_index.json`);
});

// Recover All
btnRecoverAll.addEventListener('click', async () => {
  const filesToRecover = getFilteredFiles();
  if (filesToRecover.length === 0) return;

  progressContainer.classList.remove('hidden');
  btnRecoverAll.disabled = true;

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  for (let i = 0; i < filesToRecover.length; i++) {
    const file = filesToRecover[i];
    const pct = Math.round(((i + 1) / filesToRecover.length) * 100);
    progressStatusText.textContent = `Recovering ${i + 1}/${filesToRecover.length}: ${file.fileName || file.itemId} (${recoveryMode})...`;
    progressPercentText.textContent = `${pct}%`;
    progressBarFill.style.width = `${pct}%`;

    const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(file.itemId)}?mode=${recoveryMode}&adminKey=${encodeURIComponent(key)}`;
    triggerDownload(downloadUrl, recoveryMode === 'encrypted' ? `${file.itemId}.enc` : (file.fileName || `${file.itemId}.bin`));
    
    // Short delay to allow browser to schedule downloads cleanly
    await new Promise(r => setTimeout(r, 600));
  }

  progressStatusText.textContent = `✅ Successfully recovered all ${filesToRecover.length} files (${recoveryMode})!`;
  setTimeout(() => {
    progressContainer.classList.add('hidden');
    btnRecoverAll.disabled = false;
  }, 4000);
});

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

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

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
        <td>${u.isLifetime100GB ? '⭐️ 100 GB Lifetime' : 'Free Tier (1 GB)'}</td>
        <td>${formatDate(u.lastBackupTime)}</td>
        <td>
          <button class="btn-view-files" onclick="openUserVault('${escapeHtml(u.userKey)}', '${escapeHtml(u.email)}')">
            Explore Vault &amp; Recover
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

window.openUserVault = async function(userKey, email) {
  currentUserKey = userKey;
  activeCategory = 'all';
  document.querySelectorAll('.folder-card').forEach(c => c.classList.remove('active'));
  document.querySelector('.folder-card[data-category="all"]').classList.add('active');

  modalUserName.textContent = `Vault: ${userKey}`;
  modalUserEmail.textContent = email || userKey;
  userFilesModal.classList.remove('hidden');
  progressContainer.classList.add('hidden');

  filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading vault files from Cloudflare R2 &amp; Firebase...</td></tr>`;

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}/files`, {
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    currentFiles = data.files || [];

    updateFolderCounts();
    renderFilesTable();
  } catch (err) {
    filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell" style="color: var(--danger)">Failed to load vault files: ${err.message}</td></tr>`;
  }
};

function updateFolderCounts() {
  fCountAll.textContent = `${currentFiles.length} files`;
  fCountPhotos.textContent = `${currentFiles.filter(f => isCategory(f, 'Photos')).length} files`;
  fCountVideos.textContent = `${currentFiles.filter(f => isCategory(f, 'Videos')).length} files`;
  fCountAudio.textContent = `${currentFiles.filter(f => isCategory(f, 'Audio')).length} files`;
  fCountDocs.textContent = `${currentFiles.filter(f => isCategory(f, 'Documents')).length} files`;
  fCountArchives.textContent = `${currentFiles.filter(f => isCategory(f, 'Archives')).length} files`;
}

function isCategory(file, cat) {
  const c = (file.category || '').toLowerCase();
  const target = cat.toLowerCase();
  if (c === target) return true;
  if (target === 'photos' && (c === 'photo' || c === 'images' || c === 'image')) return true;
  if (target === 'videos' && (c === 'video')) return true;
  if (target === 'documents' && (c === 'document' || c === 'docs' || c === 'doc')) return true;
  return false;
}

function getFilteredFiles() {
  if (activeCategory === 'all') return currentFiles;
  return currentFiles.filter(f => isCategory(f, activeCategory));
}

function renderFilesTable() {
  const filtered = getFilteredFiles();
  recoverAllCount.textContent = filtered.length;

  if (filtered.length === 0) {
    filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">No files found in this category.</td></tr>`;
    return;
  }

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  filesTableBody.innerHTML = filtered.map(f => {
    const decryptedUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(f.itemId)}?mode=decrypted&adminKey=${encodeURIComponent(key)}`;
    const encryptedUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/${encodeURIComponent(f.itemId)}?mode=encrypted&adminKey=${encodeURIComponent(key)}`;

    return `
      <tr>
        <td><span class="badge-tag tag-normal">${escapeHtml(f.category || 'General')}</span></td>
        <td>
          <strong style="cursor: pointer; color: var(--accent);" onclick="recoverSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}', '${recoveryMode}')" title="Click to recover ${recoveryMode}">
            ${escapeHtml(f.fileName || f.itemId)}
          </strong>
        </td>
        <td>${formatBytes(f.fileSizeBytes)}</td>
        <td>${formatDate(f.uploadedAt)}</td>
        <td>
          <button class="btn-action-decrypted" onclick="recoverSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}', 'decrypted')">
            🔓 Decrypted
          </button>
          <button class="btn-action-encrypted" onclick="recoverSingleFile('${escapeHtml(f.itemId)}', '${escapeHtml(f.fileName)}', 'encrypted')">
            🔒 Encrypted
          </button>
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

  setTimeout(() => {
    progressContainer.classList.add('hidden');
  }, 2500);
};

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
