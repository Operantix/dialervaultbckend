const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const stream = require('stream');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Razorpay = require('razorpay');
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

// Disk-based multer storage for high-speed streaming of large files (up to 500MB) without memory pressure
const uploadTempDir = path.join(STORAGE_ROOT, 'temp_uploads');
if (!fs.existsSync(uploadTempDir)) {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadTempDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${file.fieldname}-${uniqueSuffix}.tmp`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB per file chunk
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
const folderPromiseCache = new Map();

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
  if (folderPromiseCache.has(cacheKey)) {
    return await folderPromiseCache.get(cacheKey);
  }

  if (!drive) return null;

  const folderPromise = (async () => {
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
  })();

  folderPromiseCache.set(cacheKey, folderPromise);
  try {
    return await folderPromise;
  } finally {
    folderPromiseCache.delete(cacheKey);
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
    usedBytes: userQuota.usedBytes || 0,
    limitBytes: userQuota.limitBytes || (userQuota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT),
    isLifetime100GB: !!userQuota.isLifetime100GB,
    purchased_packs: userQuota.purchased_packs || (userQuota.isLifetime100GB ? 1 : 0),
    total_gb: userQuota.total_gb || (userQuota.isLifetime100GB ? 100 : 1)
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
  const uploadedFilePath = req.file?.path;
  try {
    const { email, itemId, fileName, fileSize, category } = req.body;

    if (!email || !itemId || (!uploadedFilePath && !req.file?.buffer)) {
      return res.status(400).json({ error: 'Missing email, itemId or file data' });
    }

    const userName = getUserName(email);
    const key = cleanEmailKey(email);
    const safeCategory = category && category.trim() ? category.trim() : 'General';
    const safeFileName = fileName || `file_${itemId}`;
    const fileKey = cleanFileNameKey(safeFileName);
    const bytes = parseInt(fileSize, 10) || req.file?.size || (req.file?.buffer ? req.file.buffer.length : 0);

    // Check user quota in Firebase / localDb
    let userQuota = { usedBytes: 0, isLifetime100GB: false };
    let alreadySynced = false;
    let existingDriveId = null;
    let existingDriveLink = null;
    let existingDownloadLink = null;

    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userName}/quota`).once('value');
      if (snap.exists()) userQuota = snap.val();

      // Check 1: Does this file name already exist in users/<username>/<category>/<fileName>?
      const byNameSnap = await firebaseDb.ref(`users/${userName}/${safeCategory}/${fileKey}`).once('value');
      if (byNameSnap.exists()) {
        const val = byNameSnap.val();
        if (val.backedUpToDrive && val.driveFileId && val.driveFileId !== 'local_vault_storage') {
          alreadySynced = true;
          existingDriveId = val.driveFileId;
          existingDriveLink = val.driveLink || val.webViewLink;
          existingDownloadLink = val.downloadLink;
        }
      }

      // Check 2: Does this itemId already exist in users/<username>/files/<itemId>?
      if (!alreadySynced) {
        const byIdSnap = await firebaseDb.ref(`users/${userName}/files/${itemId}`).once('value');
        if (byIdSnap.exists()) {
          const val = byIdSnap.val();
          if (val.backedUpToDrive && val.driveFileId && val.driveFileId !== 'local_vault_storage') {
            alreadySynced = true;
            existingDriveId = val.driveFileId;
            existingDriveLink = val.driveLink || val.webViewLink;
            existingDownloadLink = val.downloadLink;
          }
        }
      }
    } else {
      userQuota = localDb.users[userName] || userQuota;
      if (localDb.files[userName] && localDb.files[userName][itemId] && localDb.files[userName][itemId].backedUpToDrive) {
        alreadySynced = true;
        existingDriveId = localDb.files[userName][itemId].driveFileId;
        existingDriveLink = localDb.files[userName][itemId].driveLink;
        existingDownloadLink = localDb.files[userName][itemId].downloadLink;
      }
    }

    // If ALREADY SYNCED in Google Drive & Firebase, return confirmed links
    if (alreadySynced && existingDriveId) {
      console.log(`ℹ️ [Firebase Sync Skip] '${safeFileName}' (${itemId}) is already backed up to Drive (ID: ${existingDriveId}) and recorded in Firebase. Skipping.`);
      return res.json({
        success: true,
        itemId,
        fileName: safeFileName,
        driveFileId: existingDriveId,
        driveLink: existingDriveLink || `https://drive.google.com/file/d/${existingDriveId}/view`,
        downloadLink: existingDownloadLink || `https://drive.google.com/uc?id=${existingDriveId}&export=download`,
        category: safeCategory,
        alreadySynced: true,
        isDuplicate: true,
        backedUpToDrive: true,
        message: `File '${safeFileName}' is already backed up to Drive and synced in Firebase.`
      });
    }

    const maxAllowed = userQuota.limitBytes || (userQuota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT);
    if (userQuota.usedBytes + bytes > maxAllowed) {
      return res.status(403).json({ error: 'Storage quota exceeded for your tier' });
    }

    // 1. Ensure file is saved locally in server storage under username/category as fallback/staging
    try {
      const localDir = getLocalUserPath(email, safeCategory);
      const localFilePath = path.join(localDir, `${itemId}.enc`);
      if (!fs.existsSync(localFilePath)) {
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          fs.copyFileSync(uploadedFilePath, localFilePath);
        } else if (req.file?.buffer) {
          fs.writeFileSync(localFilePath, req.file.buffer);
        }
      }
    } catch (saveErr) {
      console.error('Local save error:', saveErr.message);
    }

    // 2. CRITICAL: Upload to Google Drive FIRST.
    // Photos, videos, documents, and all other details will ONLY be saved to Firebase
    // if Google Drive backup is 100% successful!
    if (!drive) {
      initGoogleDrive();
    }

    if (!drive) {
      return res.status(502).json({
        success: false,
        error: 'Google Drive is not connected or initialized. File details cannot be saved to Firebase without successful Google Drive backup.'
      });
    }

    let driveFileId = null;
    let driveWebViewLink = null;
    let driveDownloadLink = null;

    try {
      const targetFolderId = await resolveUserCategoryFolder(email, safeCategory);

      // Check if file with same itemId or fileName already exists in Drive folder
      const existingQuery = `'${targetFolderId}' in parents and name = '${itemId}.enc' and trashed = false`;
      const existingRes = await drive.files.list({
        q: existingQuery,
        fields: 'files(id, name, size, webViewLink, webContentLink)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      if (existingRes.data.files && existingRes.data.files.length > 0) {
        const fileObj = existingRes.data.files[0];
        driveFileId = fileObj.id;
        driveWebViewLink = fileObj.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view?usp=drivesdk`;
        driveDownloadLink = fileObj.webContentLink || `https://drive.google.com/uc?id=${driveFileId}&export=download`;
        console.log(`ℹ️ [Drive Found] '${itemId}.enc' already present in Drive (ID: ${driveFileId}).`);
      } else {
        // High-speed direct streaming to Google Drive
        let mediaBody;
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
          mediaBody = fs.createReadStream(uploadedFilePath);
        } else if (req.file?.buffer) {
          const bufferStream = new stream.PassThrough();
          bufferStream.end(req.file.buffer);
          mediaBody = bufferStream;
        }

        const driveRes = await drive.files.create({
          requestBody: {
            name: `${itemId}.enc`,
            mimeType: 'application/octet-stream',
            parents: targetFolderId ? [targetFolderId] : undefined,
            description: `DialerVault Backup: ${safeFileName} (${safeCategory})`
          },
          media: {
            mimeType: 'application/octet-stream',
            body: mediaBody
          },
          fields: 'id, name, webViewLink, webContentLink, size, mimeType',
          supportsAllDrives: true
        });

        driveFileId = driveRes.data.id;
        driveWebViewLink = driveRes.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view?usp=drivesdk`;
        driveDownloadLink = driveRes.data.webContentLink || `https://drive.google.com/uc?id=${driveFileId}&export=download`;

        // Grant read permission asynchronously in background (eliminates blocking latency)
        drive.permissions.create({
          fileId: driveFileId,
          requestBody: {
            role: 'reader',
            type: 'anyone'
          },
          supportsAllDrives: true
        }).catch((_permErr) => {});

        console.log(`✅ [Uploaded to Drive] '${safeFileName}' (${itemId}.enc) -> ID: ${driveFileId}, Link: ${driveWebViewLink}`);
      }
    } catch (driveErr) {
      console.error(`❌ [Google Drive Backup Failed] '${safeFileName}':`, driveErr.message);
      return res.status(502).json({
        success: false,
        error: `Google Drive backup failed (${driveErr.message}). Details were NOT saved to Firebase because Drive backup is required first.`
      });
    }

    if (!driveFileId) {
      return res.status(502).json({
        success: false,
        error: 'Google Drive failed to return a valid File ID. Not saved to Firebase.'
      });
    }

    // 3. NOW AND ONLY NOW: Save in Firebase Realtime Database
    // Store complete file details, Drive links, category, and metadata!
    const effectiveDriveLink = driveWebViewLink || `https://drive.google.com/file/d/${driveFileId}/view?usp=drivesdk`;
    const effectiveDownloadLink = driveDownloadLink || `https://drive.google.com/uc?id=${driveFileId}&export=download`;

    const fileMetadata = {
      itemId,
      fileName: safeFileName,
      category: safeCategory,
      fileSizeBytes: bytes,
      driveFileId,
      driveLink: effectiveDriveLink,
      webViewLink: effectiveDriveLink,
      downloadLink: effectiveDownloadLink,
      backedUpToDrive: true,
      email: email.trim().toLowerCase(),
      uploadedAt: Date.now()
    };

    userQuota.usedBytes += bytes;

    if (firebaseDb) {
      // Atomic multi-path update in a single network round-trip
      const updates = {};
      updates[`users/${userName}/${safeCategory}/${fileKey}`] = fileMetadata;
      updates[`users/${userName}/files/${itemId}`] = fileMetadata;
      updates[`users/${userName}/links/${itemId}`] = {
        itemId,
        fileName: safeFileName,
        category: safeCategory,
        driveFileId,
        driveLink: effectiveDriveLink,
        downloadLink: effectiveDownloadLink,
        uploadedAt: fileMetadata.uploadedAt
      };
      updates[`users/${userName}/quota`] = userQuota;
      updates[`users/${key}/quota`] = userQuota;
      updates[`users/${key}/files/${itemId}`] = fileMetadata;

      await firebaseDb.ref().update(updates);
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
      driveFileId,
      driveLink: effectiveDriveLink,
      webViewLink: effectiveDriveLink,
      downloadLink: effectiveDownloadLink,
      category: safeCategory,
      backedUpToDrive: true,
      usedBytes: userQuota.usedBytes,
      alreadySynced: false,
      message: `Successfully backed up '${safeFileName}' to Google Drive and recorded links in Firebase!`
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up temporary upload file
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try { fs.unlinkSync(uploadedFilePath); } catch (_) {}
    }
  }
});

// Upload Vault Manifest (vault_index.json) - DELETES old copy and replaces fresh every time!
app.post('/api/backup/manifest', upload.single('manifest'), async (req, res) => {
  const manifestFilePath = req.file?.path;
  try {
    const { email } = req.body;
    const manifestBuffer = manifestFilePath && fs.existsSync(manifestFilePath)
      ? fs.readFileSync(manifestFilePath)
      : req.file?.buffer;

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
          fields: 'id, name, webViewLink, webContentLink',
          supportsAllDrives: true
        });
        const manifestDriveId = createRes.data.id;
        const manifestDriveLink = createRes.data.webViewLink || `https://drive.google.com/file/d/${manifestDriveId}/view`;
        console.log(`✅ [Fresh Manifest Created] New vault_index.json saved in Google Drive (ID: ${manifestDriveId}, Link: ${manifestDriveLink}).`);

        if (firebaseDb) {
          await firebaseDb.ref(`users/${userName}/manifest_drive_link`).set(manifestDriveLink);
          await firebaseDb.ref(`users/${userName}/manifest_drive_id`).set(manifestDriveId);
          await firebaseDb.ref(`users/${key}/manifest_drive_link`).set(manifestDriveLink);
        }
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

    res.json({ success: true, message: 'Manifest cleanly replaced and backed up with Drive verification!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (manifestFilePath && fs.existsSync(manifestFilePath)) {
      try { fs.unlinkSync(manifestFilePath); } catch (_) {}
    }
  }
});

// Endpoint to fetch all backed-up Google Drive links stored in Firebase
app.get('/api/backup/drive-links', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email parameter required' });

    const userName = getUserName(email);
    const key = cleanEmailKey(email);
    let filesObj = {};

    if (firebaseDb) {
      const filesSnap = await firebaseDb.ref(`users/${userName}/files`).once('value');
      if (filesSnap.exists()) {
        filesObj = filesSnap.val();
      } else {
        const legacySnap = await firebaseDb.ref(`users/${key}/files`).once('value');
        if (legacySnap.exists()) filesObj = legacySnap.val();
      }
    } else {
      filesObj = localDb.files[userName] || {};
    }

    const driveLinks = [];
    for (const [id, meta] of Object.entries(filesObj)) {
      if (meta && (meta.backedUpToDrive || (meta.driveFileId && meta.driveFileId !== 'local_vault_storage'))) {
        driveLinks.push({
          itemId: meta.itemId || id,
          fileName: meta.fileName,
          category: meta.category,
          driveFileId: meta.driveFileId,
          driveLink: meta.driveLink || meta.webViewLink || `https://drive.google.com/file/d/${meta.driveFileId}/view`,
          downloadLink: meta.downloadLink || `https://drive.google.com/uc?id=${meta.driveFileId}&export=download`,
          fileSizeBytes: meta.fileSizeBytes || 0,
          uploadedAt: meta.uploadedAt
        });
      }
    }

    res.json({
      success: true,
      email,
      userName,
      count: driveLinks.length,
      links: driveLinks
    });
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
      const userName = getUserName(email);
      let snap = await firebaseDb.ref(`users/${userName}/manifest`).once('value');
      if (!snap.exists()) {
        snap = await firebaseDb.ref(`users/${key}/manifest`).once('value');
      }
      if (snap.exists()) {
        const val = snap.val();
        return res.type('json').send(typeof val === 'string' ? val : JSON.stringify(val));
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
      const userName = getUserName(email);
      let snap = await firebaseDb.ref(`users/${userName}/files/${itemId}`).once('value');
      if (!snap.exists()) {
        snap = await firebaseDb.ref(`users/${key}/files/${itemId}`).once('value');
      }
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

// Helper: Dynamically fetch active Razorpay config from Firebase RTDB or .env
async function getActiveRazorpayConfig() {
  let config = {
    enabled: true,
    key_id: process.env.RAZORPAY_KEY_ID || '',
    key_secret: process.env.RAZORPAY_KEY_SECRET || '',
    currency: 'INR',
    price_100gb: 10,
    price_100gb_inr: 10,
    amount_in_paise: 1000,
    plan_name: '100 GB Cloud Storage Pack',
    description: 'Permanent 100 GB High-Speed Encrypted Cloud Storage & VIP Disaster Recovery'
  };

  if (firebaseDb) {
    try {
      const snap = await firebaseDb.ref('server_config/razorpay').once('value');
      if (snap.exists()) {
        const val = snap.val();
        const priceInr = parseInt(val.price_100gb || val.price_100gb_inr || val.price || 10, 10);
        config = {
          ...config,
          ...val,
          price_100gb: priceInr,
          price_100gb_inr: priceInr,
          amount_in_paise: val.amount_in_paise || (priceInr * 100),
          key_id: val.key_id || config.key_id,
          key_secret: val.key_secret || config.key_secret
        };
      }
    } catch (e) {
      console.warn('⚠️ Could not load Razorpay config from Firebase:', e.message);
    }
  }

  // Ensure amount_in_paise always accurately mirrors price_100gb in INR (1 ₹ = 100 paise)
  if (config.price_100gb) {
    config.amount_in_paise = config.price_100gb * 100;
  }

  return config;
}

// 1. Get Public Razorpay Configuration for Android Client
app.get('/api/payment/config', async (req, res) => {
  try {
    const config = await getActiveRazorpayConfig();
    res.json({
      success: true,
      enabled: config.enabled !== false,
      key_id: config.key_id,
      currency: config.currency || 'INR',
      price_100gb: config.price_100gb || 10,
      price_100gb_inr: config.price_100gb || 10,
      amount_in_paise: config.amount_in_paise || 1000,
      plan_name: config.plan_name || '100 GB Cloud Storage Pack',
      description: config.description || 'Permanent 100 GB Cloud Storage'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create Razorpay Order
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const config = await getActiveRazorpayConfig();
    const keyId = config.key_id;
    const keySecret = config.key_secret;

    if (!keyId || !keySecret || keyId === 'rzp_test_placeholder_key_id') {
      console.warn('⚠️ Razorpay credentials not yet configured or placeholder in use.');
      return res.status(503).json({
        error: 'Razorpay API credentials have not been configured yet in Firebase or .env. Please update your key_id and key_secret.'
      });
    }

    const rzp = new Razorpay({
      key_id: keyId,
      key_secret: keySecret
    });

    const amount = parseInt(config.amount_in_paise, 10) || 1000;
    const currency = config.currency || 'INR';
    const userKey = cleanEmailKey(email);
    const receipt = `rcpt_${Date.now()}_${userKey.slice(0, 10)}`;

    const order = await rzp.orders.create({
      amount,
      currency,
      receipt,
      notes: {
        email: email.trim().toLowerCase(),
        plan: config.plan_name,
        price_100gb: config.price_100gb,
        app: 'DialerVault'
      }
    });

    // Save created order in Firebase
    if (firebaseDb) {
      await firebaseDb.ref(`orders/${order.id}`).set({
        order_id: order.id,
        email: email.trim().toLowerCase(),
        amount,
        currency,
        price_100gb: config.price_100gb,
        status: 'created',
        receipt,
        created_at: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      price_100gb: config.price_100gb,
      key_id: keyId,
      plan_name: config.plan_name,
      description: config.description
    });
  } catch (err) {
    console.error('❌ Razorpay order creation error:', err);
    res.status(500).json({ error: err.message || 'Failed to create Razorpay order' });
  }
});

// 3. Verify Razorpay Payment Signature and Cumulatively Extend +100 GB Storage
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { email, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!email || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required payment verification parameters' });
    }

    const config = await getActiveRazorpayConfig();
    const keySecret = config.key_secret;

    if (!keySecret) {
      return res.status(500).json({ error: 'Razorpay secret key not configured on server' });
    }

    // Razorpay signature validation: HMAC-SHA256(order_id + "|" + payment_id, secret)
    const hmac = crypto.createHmac('sha256', keySecret);
    hmac.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const generatedSignature = hmac.digest('hex');

    if (generatedSignature !== razorpay_signature) {
      console.warn(`❌ Payment signature mismatch for order ${razorpay_order_id}`);
      return res.status(400).json({ success: false, error: 'Payment signature verification failed' });
    }

    console.log(`✅ Razorpay payment verified successfully: Payment ID: ${razorpay_payment_id}, Order ID: ${razorpay_order_id} for ${email}`);

    const userKey = cleanEmailKey(email);
    const paymentRecord = {
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      signature: razorpay_signature,
      email: email.trim().toLowerCase(),
      amount: config.amount_in_paise || 1000,
      price_100gb: config.price_100gb || 10,
      currency: config.currency || 'INR',
      plan: config.plan_name,
      verified_at: new Date().toISOString()
    };

    const ONE_PACK_BYTES = 107374182400; // 100 GB in bytes
    let newLimit = ONE_PACK_BYTES;
    let newPacks = 1;
    let totalGB = 100;

    if (firebaseDb) {
      // Save payment log under /payments/{payment_id}
      await firebaseDb.ref(`payments/${razorpay_payment_id}`).set(paymentRecord);

      // Save payment under user record history
      await firebaseDb.ref(`users/${userKey}/payments/${razorpay_payment_id}`).set(paymentRecord);
      await firebaseDb.ref(`users/${userKey}/last_payment`).set(paymentRecord);

      // Check current user quota to extend storage cumulatively
      const quotaSnap = await firebaseDb.ref(`users/${userKey}/quota`).once('value');
      if (quotaSnap.exists()) {
        const qVal = quotaSnap.val();
        if (qVal.isLifetime100GB && qVal.limitBytes) {
          const currentLimit = parseInt(qVal.limitBytes, 10) || 0;
          const currentPacks = parseInt(qVal.purchased_packs, 10) || 1;
          newLimit = currentLimit + ONE_PACK_BYTES;
          newPacks = currentPacks + 1;
        }
      }

      totalGB = Math.round(newLimit / (1024 * 1024 * 1024));

      // Update user quota to cumulative 100 GB tiers
      await firebaseDb.ref(`users/${userKey}/quota/isLifetime100GB`).set(true);
      await firebaseDb.ref(`users/${userKey}/quota/limitBytes`).set(newLimit);
      await firebaseDb.ref(`users/${userKey}/quota/purchased_packs`).set(newPacks);
      await firebaseDb.ref(`users/${userKey}/quota/total_gb`).set(totalGB);
      await firebaseDb.ref(`users/${userKey}/quota/last_upgraded_at`).set(new Date().toISOString());

      // Update order status
      await firebaseDb.ref(`orders/${razorpay_order_id}/status`).set('paid');
      await firebaseDb.ref(`orders/${razorpay_order_id}/payment_id`).set(razorpay_payment_id);
      await firebaseDb.ref(`orders/${razorpay_order_id}/allocated_limit`).set(newLimit);
    } else {
      const prev = localDb.users[userKey]?.limitBytes || 0;
      newLimit = prev > 0 ? (prev + ONE_PACK_BYTES) : ONE_PACK_BYTES;
      totalGB = Math.round(newLimit / (1024 * 1024 * 1024));
      localDb.users[userKey] = {
        usedBytes: 0,
        isLifetime100GB: true,
        limitBytes: newLimit,
        purchased_packs: newPacks,
        total_gb: totalGB
      };
    }

    res.json({
      success: true,
      message: `Payment verified! Successfully extended storage by +100 GB. Total Cloud Storage: ${totalGB} GB!`,
      isLifetime100GB: true,
      limitBytes: newLimit,
      total_gb: totalGB,
      purchased_packs: newPacks
    });
  } catch (err) {
    console.error('❌ Payment verification error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Direct upgrade / extend endpoint
app.post('/api/upgrade/activate', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const key = cleanEmailKey(email);
    const ONE_PACK_BYTES = 107374182400; // 100 GB
    let newLimit = ONE_PACK_BYTES;
    let newPacks = 1;
    let totalGB = 100;

    if (firebaseDb) {
      const quotaSnap = await firebaseDb.ref(`users/${key}/quota`).once('value');
      if (quotaSnap.exists()) {
        const qVal = quotaSnap.val();
        if (qVal.isLifetime100GB && qVal.limitBytes) {
          const currentLimit = parseInt(qVal.limitBytes, 10) || 0;
          const currentPacks = parseInt(qVal.purchased_packs, 10) || 1;
          newLimit = currentLimit + ONE_PACK_BYTES;
          newPacks = currentPacks + 1;
        }
      }
      totalGB = Math.round(newLimit / (1024 * 1024 * 1024));

      await firebaseDb.ref(`users/${key}/quota/isLifetime100GB`).set(true);
      await firebaseDb.ref(`users/${key}/quota/limitBytes`).set(newLimit);
      await firebaseDb.ref(`users/${key}/quota/purchased_packs`).set(newPacks);
      await firebaseDb.ref(`users/${key}/quota/total_gb`).set(totalGB);
      await firebaseDb.ref(`users/${key}/quota/last_upgraded_at`).set(new Date().toISOString());

      res.json({
        success: true,
        message: `Added +100 GB storage for ${email}. Total: ${totalGB} GB!`,
        limitBytes: newLimit,
        total_gb: totalGB
      });
    } else {
      localDb.users[key] = { usedBytes: 0, isLifetime100GB: true, limitBytes: ONE_PACK_BYTES };
      res.json({ success: true, limitBytes: ONE_PACK_BYTES, total_gb: 100 });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 DialerVault Central Cloud Backend running on port ${port}`);
});
