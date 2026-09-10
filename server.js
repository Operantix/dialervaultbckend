const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const stream = require('stream');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const STORAGE_ROOT = path.join(__dirname, 'vault_storage');
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
}

function getLocalUserPath(email, category) {
  const userName = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  const dir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userName, category || 'General');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function findLocalFile(email, itemId) {
  const userName = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  const userDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userName);
  if (!fs.existsSync(userDir)) return null;

  // Search user root and category subfolders
  const targetName = `${itemId}.enc`;
  const rootFile = path.join(userDir, targetName);
  if (fs.existsSync(rootFile)) return rootFile;

  const entries = fs.readdirSync(userDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subFile = path.join(userDir, entry.name, targetName);
      if (fs.existsSync(subFile)) return subFile;
    }
  }
  return null;
}

app.use(cors());
app.use(express.json());

// In-memory multer storage for incoming encrypted file chunks
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB per file chunk
});

// 1. Initialize Google Drive API Client (Supports OAuth2 for Personal Drive or Service Account)
let drive = null;

function initGoogleDrive() {
  try {
    // 1. Prioritize OAuth2 if Refresh Token exists (Uses personal 15 GB quota, bypassing Service Account 0-quota limit)
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        'https://developers.google.com/oauthplayground'
      );
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
      });
      drive = google.drive({ version: 'v3', auth: oauth2Client });
      console.log('✅ Google Drive OAuth2 authenticated (Personal Drive quota active)');
      return;
    }

    // 2. Fallback to Service Account
    let credentials = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      credentials = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    } else {
      try {
        credentials = require('./google-service-account.json');
      } catch (ignored) {}
    }

    if (credentials) {
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/drive']
      });
      drive = google.drive({ version: 'v3', auth });
      console.log('✅ Google Drive Service Account authenticated');
    } else {
      console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON / OAuth2 credentials missing. Running in simulation mode.');
    }
  } catch (err) {
    console.error('❌ Google Drive Auth Error:', err.message);
  }
}

initGoogleDrive();

// 2. Initialize Firebase Admin (for Realtime Database / Firestore)
let firebaseDb = null;

function initFirebase() {
  try {
    let serviceAccount = null;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    } else {
      try {
        serviceAccount = require('./firebase-service-account.json');
      } catch (ignored) {}
    }

    const databaseURL = process.env.FIREBASE_DATABASE_URL;

    if (serviceAccount && databaseURL) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL
      });
      firebaseDb = admin.database();
      console.log('✅ Firebase Realtime Database connected');
    } else if (databaseURL) {
      console.log('ℹ️ Firebase Database URL present. Metadata will sync via REST.');
    } else {
      console.warn('ℹ️ Firebase credentials not provided. Using in-memory fallback.');
    }
  } catch (err) {
    console.error('❌ Firebase Init Error:', err.message);
  }
}

initFirebase();

// Fallback in-memory metadata store
const localDb = {
  users: {},
  files: {}
};

const FREE_LIMIT = 1073741824; // 1.0 GB
const LIFETIME_LIMIT = 107374182400; // 100 GB

// Cache for created Drive folder IDs so we don't query Drive every upload
const folderIdCache = new Map();

// Helper: Sanitize email for folder and key names
function cleanEmailKey(email) {
  return email.trim().toLowerCase().replace(/[.#$\[\]]/g, '_');
}

/**
 * Ensures a directory path exists in Google Drive:
 * DialerVault_Central_Backups -> user@email.com -> category (e.g. Photos)
 */
async function getOrCreateDriveFolder(parentFolderId, folderName) {
  const cacheKey = `${parentFolderId}_${folderName}`;
  if (folderIdCache.has(cacheKey)) {
    return folderIdCache.get(cacheKey);
  }

  if (!drive) return null;

  try {
    const query = `'${parentFolderId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const res = await drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (res.data.files && res.data.files.length > 0) {
      const folderId = res.data.files[0].id;
      folderIdCache.set(cacheKey, folderId);
      return folderId;
    }

    // Create new folder
    const createRes = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
      },
      fields: 'id'
    });

    const newId = createRes.data.id;
    folderIdCache.set(cacheKey, newId);
    return newId;
  } catch (err) {
    console.error(`Error managing folder ${folderName}:`, err.message);
    return null;
  }
}

const APP_PACKAGE_NAME = process.env.APP_PACKAGE_NAME || 'com.operantix.dialervault';

/**
 * Resolves destination folder:
 * Shared Root Drive -> com.operantix.dialervault -> user_name_or_email -> Category (Photos, Videos, etc.)
 */
async function resolveUserCategoryFolder(email, category) {
  if (!drive) return null;
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootId) return null;

  // 1. First ensure App Package Name folder exists (com.operantix.dialervault)
  const appPackageFolderId = await getOrCreateDriveFolder(rootId, APP_PACKAGE_NAME);
  const parentForUser = appPackageFolderId || rootId;

  // 2. Extract username/handle from email (e.g. "alex" from "alex@gmail.com") or clean email
  const userNameFolder = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  const userFolderId = await getOrCreateDriveFolder(parentForUser, userNameFolder);
  if (!userFolderId) return parentForUser;

  // 3. Category folder inside user folder (Photos, Videos, Documents, etc.)
  const validCategory = category && category.trim() ? category.trim() : 'General';
  const categoryFolderId = await getOrCreateDriveFolder(userFolderId, validCategory);
  return categoryFolderId || userFolderId;
}

// ---------------------- ENDPOINTS ----------------------

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DialerVault Central Cloud Storage',
    googleDriveReady: !!drive,
    firebaseReady: !!firebaseDb,
    version: '1.2.3'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    online: true,
    version: '1.2.3',
    timestamp: Date.now()
  });
});

// Config endpoint returning active server URL (can be read directly or through Firebase)
app.get('/api/config', (req, res) => {
  res.json({
    backendUrl: process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://dialervault-production.up.railway.app',
    status: 'active',
    updatedAt: new Date().toISOString()
  });
});

// Quota check endpoint
app.get('/api/backup/quota', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email parameter required' });

  const key = cleanEmailKey(email);
  let userQuota = { usedBytes: 0, isLifetime100GB: false, limitBytes: FREE_LIMIT };

  if (firebaseDb) {
    const snap = await firebaseDb.ref(`users/${key}/quota`).once('value');
    if (snap.exists()) userQuota = snap.val();
  } else {
    userQuota = localDb.users[key] || userQuota;
  }

  res.json({
    email,
    usedBytes: userQuota.usedBytes,
    limitBytes: userQuota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT,
    isLifetime100GB: userQuota.isLifetime100GB
  });
});

// Helper: Extract and sanitize username from email
function getUserName(email) {
  if (!email) return 'default_user';
  const clean = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  return clean.replace(/[.#$\[\]/]/g, '_');
}

// Helper: Sanitize file name for Firebase key
function cleanFileNameKey(name) {
  if (!name) return 'unnamed_file';
  return name.trim().replace(/[.#$\[\]/]/g, '_');
}

// Upload encrypted file chunk
app.post('/api/backup/upload', upload.single('file'), async (req, res) => {
  try {
    const { email, itemId, fileName, fileSize, category } = req.body;
    const fileBuffer = req.file?.buffer;

    if (!email || !itemId || !fileBuffer) {
      return res.status(400).json({ error: 'Missing email, itemId or file data' });
    }

    const userName = getUserName(email);
    const key = cleanEmailKey(email);
    const safeCategory = category && category.trim() ? category.trim() : 'General';
    const safeFileName = fileName || `file_${itemId}`;
    const fileKey = cleanFileNameKey(safeFileName);
    const bytes = parseInt(fileSize, 10) || fileBuffer.length;

    // Check user quota in Firebase / localDb
    let userQuota = { usedBytes: 0, isLifetime100GB: false };
    let alreadySynced = false;
    let existingDriveId = null;

    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userName}/quota`).once('value');
      if (snap.exists()) userQuota = snap.val();

      // Check 1: Does this file name already exist in users/<username>/<category>/<fileName>?
      const byNameSnap = await firebaseDb.ref(`users/${userName}/${safeCategory}/${fileKey}`).once('value');
      if (byNameSnap.exists()) {
        alreadySynced = true;
        existingDriveId = byNameSnap.val().driveFileId;
      }

      // Check 2: Does this itemId already exist in users/<username>/files/<itemId>?
      if (!alreadySynced) {
        const byIdSnap = await firebaseDb.ref(`users/${userName}/files/${itemId}`).once('value');
        if (byIdSnap.exists()) {
          alreadySynced = true;
          existingDriveId = byIdSnap.val().driveFileId;
        }
      }
    } else {
      userQuota = localDb.users[userName] || userQuota;
      if (localDb.files[userName] && (localDb.files[userName][itemId] || localDb.files[userName][fileKey])) {
        alreadySynced = true;
      }
    }

    // If ALREADY SYNCED in Firebase, SKIP Google Drive upload entirely!
    if (alreadySynced) {
      console.log(`ℹ️ [Firebase Sync Skip] '${safeFileName}' (${itemId}) is already synced in Firebase for user '${userName}' in '${safeCategory}'. Skipping Drive upload.`);
      return res.json({
        success: true,
        itemId,
        fileName: safeFileName,
        driveFileId: existingDriveId || 'existing_cloud_file',
        category: safeCategory,
        alreadySynced: true,
        isDuplicate: true,
        message: `File '${safeFileName}' is already backed up. Duplicate skipped.`
      });
    }

    const maxAllowed = userQuota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT;
    if (userQuota.usedBytes + bytes > maxAllowed) {
      return res.status(403).json({ error: 'Storage quota exceeded for your tier' });
    }

    let driveFileId = null;

    // 1. Ensure file is saved locally in server storage under username/category
    try {
      const localDir = getLocalUserPath(email, safeCategory);
      const localFilePath = path.join(localDir, `${itemId}.enc`);
      if (!fs.existsSync(localFilePath)) {
        fs.writeFileSync(localFilePath, fileBuffer);
      }
    } catch (saveErr) {
      console.error('Local save error:', saveErr.message);
    }

    // 2. Google Drive check & upload (double-checks Drive folder so Drive never has duplicate)
    if (drive) {
      try {
        const targetFolderId = await resolveUserCategoryFolder(email, safeCategory);

        // Check if file with same itemId or fileName already exists in Drive folder
        const existingQuery = `'${targetFolderId}' in parents and name = '${itemId}.enc' and trashed = false`;
        const existingRes = await drive.files.list({
          q: existingQuery,
          fields: 'files(id, name, size)',
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        if (existingRes.data.files && existingRes.data.files.length > 0) {
          driveFileId = existingRes.data.files[0].id;
          console.log(`ℹ️ [Drive Duplicate Skip] '${itemId}.enc' already exists in Drive folder (ID: ${driveFileId}).`);
        } else {
          // File does not exist yet -> Upload once
          const bufferStream = new stream.PassThrough();
          bufferStream.end(fileBuffer);

          const driveRes = await drive.files.create({
            requestBody: {
              name: `${itemId}.enc`,
              mimeType: 'application/octet-stream',
              parents: targetFolderId ? [targetFolderId] : undefined
            },
            media: {
              mimeType: 'application/octet-stream',
              body: bufferStream
            },
            fields: 'id',
            supportsAllDrives: true
          });

          driveFileId = driveRes.data.id;
          console.log(`✅ [Uploaded to Drive] '${safeFileName}' (${itemId}.enc) -> ID: ${driveFileId}`);
        }
      } catch (driveErr) {
        console.warn(`[Drive Notice] Cloud drive write skipped (${driveErr.message}). File securely held in Central Vault storage.`);
      }
    }

    // 3. Store in Firebase in structured path: users/<username>/<category>/<fileName> and users/<username>/files/<itemId>
    const fileMetadata = {
      itemId,
      fileName: safeFileName,
      category: safeCategory,
      fileSizeBytes: bytes,
      driveFileId: driveFileId || 'local_vault_storage',
      uploadedAt: Date.now()
    };

    userQuota.usedBytes += bytes;

    if (firebaseDb) {
      // 1) By Category and FileName
      await firebaseDb.ref(`users/${userName}/${safeCategory}/${fileKey}`).set(fileMetadata);
      // 2) By ItemId for fast ID lookup
      await firebaseDb.ref(`users/${userName}/files/${itemId}`).set(fileMetadata);
      // 3) Quota tracking
      await firebaseDb.ref(`users/${userName}/quota`).set(userQuota);
      // Also write legacy key for backwards compatibility
      await firebaseDb.ref(`users/${key}/quota`).set(userQuota);
    } else {
      if (!localDb.files[userName]) localDb.files[userName] = {};
      localDb.files[userName][itemId] = fileMetadata;
      localDb.files[userName][fileKey] = fileMetadata;
      localDb.users[userName] = userQuota;
    }

    res.json({
      success: true,
      itemId,
      fileName: safeFileName,
      driveFileId: driveFileId || 'local_vault_storage',
      category: safeCategory,
      usedBytes: userQuota.usedBytes,
      alreadySynced: false,
      message: `Successfully uploaded '${safeFileName}' to Cloud!`
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload Vault Manifest (vault_index.json) - DELETES old copy and replaces fresh every time!
app.post('/api/backup/manifest', upload.single('manifest'), async (req, res) => {
  try {
    const { email } = req.body;
    const manifestBuffer = req.file?.buffer;

    if (!email || !manifestBuffer) {
      return res.status(400).json({ error: 'Missing email or manifest' });
    }

    const userName = getUserName(email);
    const key = cleanEmailKey(email);

    // Save manifest locally on server
    try {
      const localDir = getLocalUserPath(email, 'Manifest');
      fs.writeFileSync(path.join(localDir, 'vault_index.json'), manifestBuffer);
    } catch (mErr) {
      console.error('Manifest local save error:', mErr.message);
    }

    if (drive) {
      try {
        const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
        const appPackageFolderId = await getOrCreateDriveFolder(rootId, APP_PACKAGE_NAME);
        const parentForUser = appPackageFolderId || rootId;

        const userNameFolder = getUserName(email);
        const userFolderId = await getOrCreateDriveFolder(parentForUser, userNameFolder);
        const targetParent = userFolderId || rootId;

        // 1. Find ALL old vault_index.json files in this user's Google Drive folder
        const checkQuery = `'${targetParent}' in parents and name = 'vault_index.json' and trashed = false`;
        const existingRes = await drive.files.list({
          q: checkQuery,
          fields: 'files(id, name)',
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true
        });

        // 2. DELETE all old copies from Google Drive!
        if (existingRes.data.files && existingRes.data.files.length > 0) {
          for (const oldFile of existingRes.data.files) {
            try {
              await drive.files.delete({
                fileId: oldFile.id,
                supportsAllDrives: true
              });
              console.log(`🗑️ [Old Manifest Deleted] Deleted old vault_index.json (ID: ${oldFile.id}) from Google Drive.`);
            } catch (delErr) {
              console.warn(`Could not delete old manifest ${oldFile.id}:`, delErr.message);
            }
          }
        }

        // 3. Create fresh, single copy of vault_index.json
        const bufferStream = new stream.PassThrough();
        bufferStream.end(manifestBuffer);

        const createRes = await drive.files.create({
          requestBody: {
            name: 'vault_index.json',
            mimeType: 'application/json',
            parents: targetParent ? [targetParent] : undefined
          },
          media: {
            mimeType: 'application/json',
            body: bufferStream
          },
          fields: 'id',
          supportsAllDrives: true
        });
        console.log(`✅ [Fresh Manifest Created] New vault_index.json saved in Google Drive (ID: ${createRes.data.id}).`);
      } catch (dErr) {
        console.warn(`[Drive Notice] Manifest drive write skipped: ${dErr.message}`);
      }
    }

    // Save manifest in Firebase under users/<username>/manifest
    if (firebaseDb) {
      const manifestStr = manifestBuffer.toString('utf-8');
      await firebaseDb.ref(`users/${userName}/manifest`).set(manifestStr);
      await firebaseDb.ref(`users/${key}/manifest`).set(manifestStr);
    }

    res.json({ success: true, message: 'Manifest cleanly replaced and backed up!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to fetch all synced item IDs for an email (used by app to prevent re-uploading)
app.get('/api/backup/synced-items', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email parameter required' });

    const userName = getUserName(email);
    let syncedIds = [];
    let syncedNames = [];

    if (firebaseDb) {
      const filesSnap = await firebaseDb.ref(`users/${userName}/files`).once('value');
      if (filesSnap.exists()) {
        const filesObj = filesSnap.val();
        syncedIds = Object.keys(filesObj);
        syncedNames = Object.values(filesObj).map(f => f.fileName).filter(Boolean);
      }
    }

    res.json({
      success: true,
      userName,
      count: syncedIds.length,
      syncedIds,
      syncedNames
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download Manifest for Disaster Recovery
app.get('/api/backup/manifest', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email parameter required' });

    const key = cleanEmailKey(email);

    // 1. Check Firebase first for fast instant download
    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${key}/manifest`).once('value');
      if (snap.exists()) {
        return res.type('json').send(snap.val());
      }
    }

    // 2. Check local server storage
    const localDir = getLocalUserPath(email, 'Manifest');
    const localManifest = path.join(localDir, 'vault_index.json');
    if (fs.existsSync(localManifest)) {
      return res.sendFile(localManifest);
    }

    // 3. Fallback: Query Google Drive
    if (drive) {
      const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID;
      const userFolderId = await getOrCreateDriveFolder(rootId, email.trim().toLowerCase());

      const q = `'${userFolderId}' in parents and name = 'vault_index.json' and trashed = false`;
      const list = await drive.files.list({ q, fields: 'files(id, name)', supportsAllDrives: true });

      if (list.data.files && list.data.files.length > 0) {
        const fileId = list.data.files[0].id;
        const driveStream = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' }
        );
        return driveStream.data.pipe(res);
      }
    }

    res.status(404).json({ error: 'No backup manifest found for this email' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download individual file chunk by itemId
app.get('/api/backup/download', async (req, res) => {
  try {
    const { email, itemId } = req.query;
    if (!email || !itemId) return res.status(400).json({ error: 'Missing email or itemId' });

    // 1. Check local server vault storage first
    const localFile = findLocalFile(email, itemId);
    if (localFile && fs.existsSync(localFile)) {
      return res.sendFile(localFile);
    }

    const key = cleanEmailKey(email);
    let driveFileId = null;

    // 2. Look up driveFileId from Firebase metadata
    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${key}/files/${itemId}`).once('value');
      if (snap.exists()) {
        driveFileId = snap.val().driveFileId;
      }
    }

    // 3. Stream directly from Google Drive if available
    if (drive && driveFileId && driveFileId !== 'local_vault_storage' && driveFileId !== 'simulated_id') {
      try {
        const driveStream = await drive.files.get(
          { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' }
        );
        return driveStream.data.pipe(res);
      } catch (dErr) {
        console.warn(`Drive download stream failed: ${dErr.message}`);
      }
    }

    // 3. Fallback search by filename in Drive
    if (drive) {
      const q = `name = '${itemId}.enc' and trashed = false`;
      const list = await drive.files.list({ q, fields: 'files(id, name)' });
      if (list.data.files && list.data.files.length > 0) {
        const fileId = list.data.files[0].id;
        const driveStream = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' }
        );
        return driveStream.data.pipe(res);
      }
    }

    res.status(404).json({ error: 'File not found in cloud backup' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate 100 GB Lifetime Tier for ₹10
app.post('/api/upgrade/activate', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const key = cleanEmailKey(email);
    let userQuota = { usedBytes: 0, isLifetime100GB: true, limitBytes: LIFETIME_LIMIT };

    if (firebaseDb) {
      await firebaseDb.ref(`users/${key}/quota/isLifetime100GB`).set(true);
      await firebaseDb.ref(`users/${key}/quota/limitBytes`).set(LIFETIME_LIMIT);
    } else {
      localDb.users[key] = userQuota;
    }

    res.json({
      success: true,
      message: '100 GB Lifetime Plan successfully activated for ' + email,
      limitBytes: LIFETIME_LIMIT
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 DialerVault Central Cloud Backend running on port ${port}`);
});
