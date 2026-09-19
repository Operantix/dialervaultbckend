// DialerVault Admin Application Logic
let allUsers = [];
let currentUserKey = null;

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
const modalFileCount = document.getElementById('modalFileCount');
const modalTotalSize = document.getElementById('modalTotalSize');
const btnRecoverManifest = document.getElementById('btnRecoverManifest');
const filesTableBody = document.getElementById('filesTableBody');

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

btnRecoverManifest.addEventListener('click', () => {
  if (!currentUserKey) return;
  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();
  const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(currentUserKey)}/recover/manifest?adminKey=${encodeURIComponent(key)}`;
  window.open(downloadUrl, '_blank');
});

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
      headers: {
        'x-admin-key': key
      }
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
          <button class="btn-view-files" onclick="openUserFiles('${escapeHtml(u.userKey)}', '${escapeHtml(u.email)}')">
            View Files &amp; Recover
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

window.openUserFiles = async function(userKey, email) {
  currentUserKey = userKey;
  modalUserName.textContent = `Vault: ${userKey}`;
  modalUserEmail.textContent = email || userKey;
  userFilesModal.classList.remove('hidden');

  filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">Loading files from Cloudflare R2 &amp; Firebase...</td></tr>`;

  const baseUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const key = adminKeyInput.value.trim();

  try {
    const res = await fetch(`${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}/files`, {
      headers: { 'x-admin-key': key }
    });
    const data = await res.json();
    const files = data.files || [];

    modalFileCount.textContent = `${files.length} files`;
    const totalBytes = files.reduce((sum, f) => sum + (f.fileSizeBytes || 0), 0);
    modalTotalSize.textContent = formatBytes(totalBytes);

    if (files.length === 0) {
      filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell">No files backed up yet for this user.</td></tr>`;
      return;
    }

    filesTableBody.innerHTML = files.map(f => {
      const downloadUrl = `${baseUrl}/api/admin/user/${encodeURIComponent(userKey)}/recover/${encodeURIComponent(f.itemId)}?adminKey=${encodeURIComponent(key)}`;
      return `
        <tr>
          <td><span class="badge-tag tag-normal">${escapeHtml(f.category || 'General')}</span></td>
          <td><strong>${escapeHtml(f.fileName || f.itemId)}</strong></td>
          <td>${formatBytes(f.fileSizeBytes)}</td>
          <td>${formatDate(f.uploadedAt)}</td>
          <td>
            <a href="${downloadUrl}" target="_blank" class="btn-recover" style="display: inline-flex; text-decoration: none; padding: 4px 10px; font-size: 11px;">
              Recover File
            </a>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    filesTableBody.innerHTML = `<tr><td colspan="5" class="loading-cell" style="color: var(--danger)">Failed to load user files: ${err.message}</td></tr>`;
  }
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
