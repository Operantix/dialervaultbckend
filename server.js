const express = require('express');
const cors = require('cors');
const multer = require('multer');
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
  const rawUserName = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  const userName = rawUserName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeCategory = (category || 'General').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userName, safeCategory);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT))) {
    throw new Error('Invalid path traversal detected');
  }
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

function findLocalFile(email, itemId) {
  const rawUserName = email.includes('@') ? email.split('@')[0].trim() : email.trim();
  const userName = rawUserName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeItemId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userName);
  const resolvedUserDir = path.resolve(userDir);
  if (!resolvedUserDir.startsWith(path.resolve(STORAGE_ROOT)) || !fs.existsSync(resolvedUserDir)) return null;

  // Search user root and category subfolders
  const targetName = `${safeItemId}.enc`;
  const rootFile = path.join(resolvedUserDir, targetName);
  if (fs.existsSync(rootFile)) return rootFile;

  const entries = fs.readdirSync(resolvedUserDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const subFile = path.join(resolvedUserDir, entry.name, targetName);
      if (fs.existsSync(subFile)) return subFile;
    }
  }
  return null;
}

app.use(cors());
app.use(express.json());

// Serve Admin Application Dashboard
const localAdminDir = path.join(__dirname, 'public-admin');
const rootAdminDir = path.join(__dirname, '..', 'admin-application');
if (fs.existsSync(localAdminDir)) {
  app.use('/admin', express.static(localAdminDir));
} else if (fs.existsSync(rootAdminDir)) {
  app.use('/admin', express.static(rootAdminDir));
}

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

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand
} = require('@aws-sdk/client-s3');

// 2. Initialize Firebase Admin (for Realtime Database / metadata)
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
      console.log('✅ Firebase Admin connected successfully');
    } else {
      console.warn('⚠️ Firebase credentials missing. Using local in-memory/file metadata fallback.');
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

// Helper: Sanitize email for database and key names
function cleanEmailKey(email) {
  if (!email) return 'default_user';
  return email.trim().toLowerCase().replace(/[.#$\[\]]/g, '_');
}

// 1. Initialize Cloudflare R2 Object Storage (S3-compatible API)
let r2Client = null;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'dialervault-backups';
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

function initR2() {
  try {
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const accountId = process.env.R2_ACCOUNT_ID;

    if (accessKeyId && secretAccessKey && accountId) {
      r2Client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId,
          secretAccessKey
        }
      });
      console.log('✅ Cloudflare R2 Object Storage connected and active');
    } else {
      console.warn('⚠️ Cloudflare R2 credentials missing (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID). Fallback to local vault storage active.');
    }
  } catch (err) {
    console.error('❌ Cloudflare R2 Init Error:', err.message);
  }
}

initR2();

// Helper to construct S3 / R2 object key
function getR2ObjectKey(email, category, fileName) {
  const userName = getUserName(email);
  const safeCategory = (category || 'General').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${APP_PACKAGE_NAME}/${userName}/${safeCategory}/${fileName}`;
}

const APP_PACKAGE_NAME = process.env.APP_PACKAGE_NAME || 'com.operantix.dialervault';

// ---------------------- ENDPOINTS ----------------------

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'DialerVault Cloudflare R2 Central Cloud Storage',
    r2Ready: !!r2Client,
    firebaseReady: !!firebaseDb,
    version: '1.4.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    online: true,
    storage: r2Client ? 'Cloudflare R2 Object Storage' : 'Local Vault Fallback',
    version: '1.4.0',
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

// Upload encrypted file chunk to Cloudflare R2
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
    let existingR2Key = null;

    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userName}/quota`).once('value');
      if (snap.exists()) userQuota = snap.val();

      const byIdSnap = await firebaseDb.ref(`users/${userName}/files/${itemId}`).once('value');
      if (byIdSnap.exists()) {
        const val = byIdSnap.val();
        if (val.backedUpToR2 || val.r2Key) {
          alreadySynced = true;
          existingR2Key = val.r2Key || val.driveFileId;
        }
      }
    } else {
      userQuota = localDb.users[userName] || userQuota;
      if (localDb.files[userName] && localDb.files[userName][itemId] && localDb.files[userName][itemId].backedUpToR2) {
        alreadySynced = true;
        existingR2Key = localDb.files[userName][itemId].r2Key;
      }
    }

    if (alreadySynced && existingR2Key) {
      return res.json({
        success: true,
        itemId,
        fileName: safeFileName,
        r2Key: existingR2Key,
        category: safeCategory,
        alreadySynced: true,
        isDuplicate: true,
        backedUpToR2: true,
        message: `File '${safeFileName}' is already backed up to Cloudflare R2.`
      });
    }

    const maxAllowed = userQuota.limitBytes || (userQuota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT);
    if (userQuota.usedBytes + bytes > maxAllowed) {
      return res.status(403).json({ error: 'Storage quota exceeded for your tier' });
    }

    // 1. Ensure file is saved locally in server storage as staging/fallback
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

    // 2. Upload to Cloudflare R2 Object Storage
    let r2Key = null;
    const objectKey = getR2ObjectKey(email, safeCategory, `${itemId}.enc`);

    if (r2Client) {
      try {
        const fileStream = uploadedFilePath && fs.existsSync(uploadedFilePath)
          ? fs.createReadStream(uploadedFilePath)
          : req.file?.buffer;

        await r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: objectKey,
          Body: fileStream,
          ContentType: 'application/octet-stream',
          Metadata: {
            itemId,
            fileName: safeFileName,
            category: safeCategory,
            email: email.trim().toLowerCase()
          }
        }));

        r2Key = objectKey;
        console.log(`✅ [Uploaded to Cloudflare R2] '${safeFileName}' (${itemId}.enc) -> ${objectKey}`);
      } catch (r2Err) {
        console.error(`❌ [Cloudflare R2 Upload Failed] '${safeFileName}':`, r2Err.message);
      }
    }

    if (!r2Key) {
      r2Key = 'local_vault_storage';
      console.warn(`ℹ️ [Notice] R2 not configured or failed, stored in central vault storage.`);
    }

    // 3. Save metadata to Firebase Realtime Database
    const downloadUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://dialervaultbckend-production.up.railway.app'}/api/backup/download?email=${encodeURIComponent(email)}&itemId=${encodeURIComponent(itemId)}`;

    const fileMetadata = {
      itemId,
      fileName: safeFileName,
      category: safeCategory,
      fileSizeBytes: bytes,
      r2Key,
      driveFileId: r2Key, // maintain backward compatibility with client
      driveLink: downloadUrl,
      downloadLink: downloadUrl,
      backedUpToR2: true,
      backedUpToDrive: true,
      email: email.trim().toLowerCase(),
      uploadedAt: Date.now()
    };

    userQuota.usedBytes += bytes;

    if (firebaseDb) {
      const updates = {};
      updates[`users/${userName}/${safeCategory}/${fileKey}`] = fileMetadata;
      updates[`users/${userName}/files/${itemId}`] = fileMetadata;
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
      r2Key,
      driveFileId: r2Key,
      driveLink: downloadUrl,
      downloadLink: downloadUrl,
      category: safeCategory,
      backedUpToR2: true,
      usedBytes: userQuota.usedBytes,
      alreadySynced: false,
      message: `Successfully backed up '${safeFileName}' to Cloudflare R2 and synced metadata!`
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      try { fs.unlinkSync(uploadedFilePath); } catch (_) {}
    }
  }
});

// Upload Vault Manifest (vault_index.json) to Cloudflare R2
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

    // 1. Save manifest locally on server
    try {
      const localDir = getLocalUserPath(email, 'Manifest');
      fs.writeFileSync(path.join(localDir, 'vault_index.json'), manifestBuffer);
    } catch (mErr) {
      console.error('Manifest local save error:', mErr.message);
    }

    // 2. Upload manifest to Cloudflare R2
    const manifestR2Key = `${APP_PACKAGE_NAME}/${userName}/Manifest/vault_index.json`;
    if (r2Client) {
      try {
        await r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: manifestR2Key,
          Body: manifestBuffer,
          ContentType: 'application/json'
        }));
        console.log(`✅ [Fresh Manifest Created] vault_index.json saved to Cloudflare R2 (${manifestR2Key}).`);
      } catch (r2Err) {
        console.warn(`[R2 Notice] Manifest R2 write skipped: ${r2Err.message}`);
      }
    }

    // 3. Save manifest in Firebase under users/<username>/manifest
    if (firebaseDb) {
      const manifestStr = manifestBuffer.toString('utf-8');
      await firebaseDb.ref(`users/${userName}/manifest`).set(manifestStr);
      await firebaseDb.ref(`users/${key}/manifest`).set(manifestStr);
    }

    res.json({ success: true, message: 'Manifest cleanly backed up to Cloudflare R2 & Firebase!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (manifestFilePath && fs.existsSync(manifestFilePath)) {
      try { fs.unlinkSync(manifestFilePath); } catch (_) {}
    }
  }
});

// Endpoint to fetch all backed-up items stored in Firebase
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

    const links = [];
    for (const [id, meta] of Object.entries(filesObj)) {
      if (meta) {
        const downloadUrl = `${process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'https://dialervaultbckend-production.up.railway.app'}/api/backup/download?email=${encodeURIComponent(email)}&itemId=${encodeURIComponent(meta.itemId || id)}`;
        links.push({
          itemId: meta.itemId || id,
          fileName: meta.fileName,
          category: meta.category,
          r2Key: meta.r2Key || meta.driveFileId,
          driveFileId: meta.r2Key || meta.driveFileId,
          driveLink: downloadUrl,
          downloadLink: downloadUrl,
          fileSizeBytes: meta.fileSizeBytes || 0,
          uploadedAt: meta.uploadedAt
        });
      }
    }

    res.json({
      success: true,
      email,
      userName,
      count: links.length,
      links
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
    const userName = getUserName(email);

    // 1. Check Firebase first for fast instant download
    if (firebaseDb) {
      let snap = await firebaseDb.ref(`users/${userName}/manifest`).once('value');
      if (!snap.exists()) {
        snap = await firebaseDb.ref(`users/${key}/manifest`).once('value');
      }
      if (snap.exists()) {
        const val = snap.val();
        return res.type('json').send(typeof val === 'string' ? val : JSON.stringify(val));
      }
    }

    // 2. Check Cloudflare R2
    if (r2Client) {
      try {
        const manifestR2Key = `${APP_PACKAGE_NAME}/${userName}/Manifest/vault_index.json`;
        const r2Res = await r2Client.send(new GetObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: manifestR2Key
        }));
        res.type('json');
        return r2Res.Body.pipe(res);
      } catch (r2Err) {
        console.warn(`R2 manifest fetch failed: ${r2Err.message}`);
      }
    }

    // 3. Check local server storage
    const localDir = getLocalUserPath(email, 'Manifest');
    const localManifest = path.join(localDir, 'vault_index.json');
    if (fs.existsSync(localManifest)) {
      return res.sendFile(localManifest);
    }

    res.status(404).json({ error: 'No backup manifest found for this email' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download individual file chunk by itemId (from Cloudflare R2 or local vault storage)
app.get('/api/backup/download', async (req, res) => {
  try {
    const { email, itemId } = req.query;
    let driveFileId = req.query.driveFileId;
    if (!email || !itemId) return res.status(400).json({ error: 'Missing email or itemId' });

    const userName = getUserName(email);

    // 1. Check Cloudflare R2 directly if r2Client is ready
    if (r2Client) {
      const possibleKeys = [
        driveFileId,
        `${APP_PACKAGE_NAME}/${userName}/Photos/${itemId}.enc`,
        `${APP_PACKAGE_NAME}/${userName}/Videos/${itemId}.enc`,
        `${APP_PACKAGE_NAME}/${userName}/Audio/${itemId}.enc`,
        `${APP_PACKAGE_NAME}/${userName}/Documents/${itemId}.enc`,
        `${APP_PACKAGE_NAME}/${userName}/Archives/${itemId}.enc`,
        `${APP_PACKAGE_NAME}/${userName}/General/${itemId}.enc`
      ].filter(k => k && k !== 'local_vault_storage' && k !== 'simulated_id');

      for (const keyToTry of possibleKeys) {
        try {
          const r2Res = await r2Client.send(new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: keyToTry
          }));
          res.setHeader('Content-Type', 'application/octet-stream');
          return r2Res.Body.pipe(res);
        } catch (_) {}
      }
    }

    // 2. Check local server vault storage
    const localFile = findLocalFile(email, itemId);
    if (localFile && fs.existsSync(localFile)) {
      return res.sendFile(localFile);
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

// Direct upgrade / extend endpoint (requires ADMIN_SECRET_KEY)
app.post('/api/upgrade/activate', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.headers['authorization'];
    const expectedKey = process.env.ADMIN_SECRET_KEY;
    if (!expectedKey || (adminKey !== `Bearer ${expectedKey}` && adminKey !== expectedKey)) {
      return res.status(401).json({ error: 'Unauthorized: Valid Admin API key required for manual quota upgrades' });
    }

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

// ==========================================
// 🛡️ DIALERVAULT ADMIN CONTROL CENTER APIS
// ==========================================

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'dialervault_admin_secret_2026';

function verifyAdminAuth(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.headers['authorization'] || req.query.adminKey;
  if (!adminKey || (adminKey !== ADMIN_SECRET_KEY && adminKey !== `Bearer ${ADMIN_SECRET_KEY}`)) {
    return res.status(401).json({ error: 'Unauthorized: Valid Admin API key required' });
  }
  next();
}

// 1. Get all users, file counts, quota usage, and unusual activity status
app.get('/api/admin/users', verifyAdminAuth, async (req, res) => {
  try {
    const usersMap = {};

    if (firebaseDb) {
      const snap = await firebaseDb.ref('users').once('value');
      if (snap.exists()) {
        const data = snap.val();
        for (const [userKey, val] of Object.entries(data)) {
          if (!val) continue;
          const quota = val.quota || {};
          const files = val.files || {};
          const fileList = Object.values(files).filter(Boolean);
          const totalFiles = fileList.length;
          const totalBytes = fileList.reduce((acc, f) => acc + (f.fileSizeBytes || 0), 0);
          const limitBytes = quota.limitBytes || (quota.isLifetime100GB ? LIFETIME_LIMIT : FREE_LIMIT);
          const isQuotaExceeded = totalBytes > limitBytes;
          
          // Suspicious flag: extreme files or rapid quota overflow
          const isSuspicious = isQuotaExceeded || totalFiles > 5000 || (quota.purchased_packs > 50);

          usersMap[userKey] = {
            userKey,
            email: val.last_payment?.email || fileList[0]?.email || userKey,
            totalFiles,
            usedBytes: totalBytes || quota.usedBytes || 0,
            limitBytes,
            isLifetime100GB: !!quota.isLifetime100GB,
            purchased_packs: quota.purchased_packs || (quota.isLifetime100GB ? 1 : 0),
            total_gb: quota.total_gb || Math.round(limitBytes / (1024 * 1024 * 1024)),
            hasManifest: !!val.manifest,
            lastBackupTime: fileList.reduce((max, f) => Math.max(max, f.uploadedAt || 0), 0),
            isSuspicious,
            status: isSuspicious ? 'Flagged / Unusual Activity' : 'Normal Active'
          };
        }
      }
    }

    // Also include any users in local vault storage
    try {
      const vaultAppDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME);
      if (fs.existsSync(vaultAppDir)) {
        const localUsers = fs.readdirSync(vaultAppDir, { withFileTypes: true });
        for (const u of localUsers) {
          if (u.isDirectory()) {
            const userKey = u.name;
            if (!usersMap[userKey]) {
              usersMap[userKey] = {
                userKey,
                email: userKey,
                totalFiles: 0,
                usedBytes: 0,
                limitBytes: FREE_LIMIT,
                isLifetime100GB: false,
                hasManifest: fs.existsSync(path.join(vaultAppDir, userKey, 'Manifest', 'vault_index.json')),
                lastBackupTime: 0,
                isSuspicious: false,
                status: 'Normal Active (Local)'
              };
            }
          }
        }
      }
    } catch (_) {}

    res.json({
      success: true,
      count: Object.keys(usersMap).length,
      users: Object.values(usersMap)
    });
  } catch (err) {
    console.error('Admin users fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Get detailed files for a specific user
app.get('/api/admin/user/:userKey/files', verifyAdminAuth, async (req, res) => {
  try {
    const { userKey } = req.params;
    let fileList = [];
    let manifest = null;

    if (firebaseDb) {
      const filesSnap = await firebaseDb.ref(`users/${userKey}/files`).once('value');
      if (filesSnap.exists()) {
        fileList = Object.values(filesSnap.val()).filter(Boolean);
      }
      const manifestSnap = await firebaseDb.ref(`users/${userKey}/manifest`).once('value');
      if (manifestSnap.exists()) {
        manifest = manifestSnap.val();
      }
    }

    // Local files scan fallback
    if (fileList.length === 0) {
      const userDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userKey);
      if (fs.existsSync(userDir)) {
        const walkDir = (dir, cat = 'General') => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory()) {
              walkDir(fullPath, e.name);
            } else if (e.name.endsWith('.enc')) {
              const stat = fs.statSync(fullPath);
              fileList.push({
                itemId: e.name.replace('.enc', ''),
                fileName: e.name,
                category: cat,
                fileSizeBytes: stat.size,
                uploadedAt: stat.mtimeMs,
                r2Key: `local_vault_storage`
              });
            }
          }
        };
        walkDir(userDir);
      }
    }

    res.json({
      success: true,
      userKey,
      totalFiles: fileList.length,
      hasManifest: !!manifest,
      files: fileList
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Decrypt user's persistent vault AES key from manifest
async function getUserVaultKey(userKey) {
  try {
    let manifestStr = null;
    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userKey}/manifest`).once('value');
      if (snap.exists()) manifestStr = snap.val();
    }
    if (!manifestStr && r2Client) {
      try {
        const manifestR2Key = `${APP_PACKAGE_NAME}/${userKey}/Manifest/vault_index.json`;
        const r2Res = await r2Client.send(new GetObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: manifestR2Key
        }));
        manifestStr = await r2Res.Body.transformToString();
      } catch (_) {}
    }
    if (!manifestStr) {
      const localManifest = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userKey, 'Manifest', 'vault_index.json');
      if (fs.existsSync(localManifest)) manifestStr = fs.readFileSync(localManifest, 'utf8');
    }

    if (!manifestStr) return null;

    const manifest = typeof manifestStr === 'string' ? JSON.parse(manifestStr) : manifestStr;
    const vaultKeyEncBase64 = manifest.vault_key_enc;
    if (!vaultKeyEncBase64) return null;

    const encBytes = Buffer.from(vaultKeyEncBase64, 'base64');
    if (encBytes.length <= 28) return null;

    const salt = encBytes.subarray(0, 16);
    const iv = encBytes.subarray(16, 28);
    const cipherBytes = encBytes.subarray(28);

    const pin = 'OperanVaultPersistentDefaultSaltKey2026';
    const kek = crypto.pbkdf2Sync(pin, salt, 65536, 32, 'sha256');

    const authTag = cipherBytes.subarray(cipherBytes.length - 16);
    const data = cipherBytes.subarray(0, cipherBytes.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
    decipher.setAuthTag(authTag);
    const rawAesKey = Buffer.concat([decipher.update(data), decipher.final()]);
    return rawAesKey;
  } catch (err) {
    console.warn(`Could not derive vault key for ${userKey}:`, err.message);
    return null;
  }
}

// Helper: Decrypt buffer using AES-GCM (VAULT1 format)
function decryptVaultBuffer(encryptedBuffer, rawAesKey) {
  if (encryptedBuffer.length > 18 && encryptedBuffer.subarray(0, 6).toString('utf8') === 'VAULT1') {
    const iv = encryptedBuffer.subarray(6, 18);
    const cipherDataWithTag = encryptedBuffer.subarray(18);
    const authTag = cipherDataWithTag.subarray(cipherDataWithTag.length - 16);
    const data = cipherDataWithTag.subarray(0, cipherDataWithTag.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', rawAesKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
  return encryptedBuffer;
}

// Helper: Get MIME type from file extension
function getMimeType(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.wav': return 'audio/wav';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    case '.txt': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

// 3. Admin Recover: Download user's file (Decrypted or Encrypted) or manifest
app.get('/api/admin/user/:userKey/recover/:itemId', verifyAdminAuth, async (req, res) => {
  try {
    const { userKey, itemId } = req.params;
    const mode = req.query.mode || 'decrypted'; // 'decrypted' | 'encrypted'

    // A. If itemId is 'manifest', return user's vault_index.json
    if (itemId === 'manifest') {
      if (firebaseDb) {
        const snap = await firebaseDb.ref(`users/${userKey}/manifest`).once('value');
        if (snap.exists()) {
          const val = snap.val();
          res.setHeader('Content-Disposition', `attachment; filename="${userKey}_vault_index.json"`);
          res.setHeader('Content-Type', 'application/json');
          return res.send(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
        }
      }

      if (r2Client) {
        try {
          const manifestR2Key = `${APP_PACKAGE_NAME}/${userKey}/Manifest/vault_index.json`;
          const r2Res = await r2Client.send(new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: manifestR2Key
          }));
          res.setHeader('Content-Disposition', `attachment; filename="${userKey}_vault_index.json"`);
          res.setHeader('Content-Type', 'application/json');
          return r2Res.Body.pipe(res);
        } catch (_) {}
      }

      const localManifest = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userKey, 'Manifest', 'vault_index.json');
      if (fs.existsSync(localManifest)) {
        return res.download(localManifest, `${userKey}_vault_index.json`);
      }
      return res.status(404).json({ error: 'Manifest not found for user' });
    }

    // B. Find file metadata (to know original file name & category)
    let meta = null;
    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userKey}/files/${itemId}`).once('value');
      if (snap.exists()) meta = snap.val();
    }

    const originalFileName = meta?.fileName || `${itemId}.bin`;
    const mimeType = getMimeType(originalFileName);

    // Fetch encrypted buffer from R2 or local storage
    let encryptedBuffer = null;

    if (r2Client) {
      const categories = [meta?.category, 'Photos', 'Videos', 'Audio', 'Documents', 'Archives', 'General'].filter(Boolean);
      for (const cat of categories) {
        const keyToTry = `${APP_PACKAGE_NAME}/${userKey}/${cat}/${itemId}.enc`;
        try {
          const r2Res = await r2Client.send(new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: keyToTry
          }));
          const chunks = [];
          for await (const chunk of r2Res.Body) chunks.push(chunk);
          encryptedBuffer = Buffer.concat(chunks);
          break;
        } catch (_) {}
      }
    }

    if (!encryptedBuffer) {
      const localFile = findLocalFile(userKey, itemId);
      if (localFile && fs.existsSync(localFile)) {
        encryptedBuffer = fs.readFileSync(localFile);
      }
    }

    if (!encryptedBuffer) {
      return res.status(404).json({ error: 'Requested file not found in R2 or local storage' });
    }

    // C. Deliver based on requested mode (Decrypted vs Encrypted)
    if (mode === 'encrypted') {
      res.setHeader('Content-Disposition', `attachment; filename="${itemId}.enc"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      return res.send(encryptedBuffer);
    }

    // Attempt Decryption
    const vaultKey = await getUserVaultKey(userKey);
    let outputBuffer = encryptedBuffer;
    let isDecrypted = false;

    if (vaultKey) {
      try {
        outputBuffer = decryptVaultBuffer(encryptedBuffer, vaultKey);
        isDecrypted = true;
      } catch (decErr) {
        console.warn(`Decryption failed for item ${itemId}:`, decErr.message);
      }
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(originalFileName)}"`);
    res.setHeader('Content-Type', isDecrypted ? mimeType : 'application/octet-stream');
    res.setHeader('X-Decrypted', isDecrypted ? 'true' : 'false');
    return res.send(outputBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Admin Delete: Delete single file for a user
app.delete('/api/admin/user/:userKey/file/:itemId', verifyAdminAuth, async (req, res) => {
  try {
    const { userKey, itemId } = req.params;

    // Get file size to adjust quota
    let fileSize = 0;
    let category = 'General';
    let fileKey = null;

    if (firebaseDb) {
      const snap = await firebaseDb.ref(`users/${userKey}/files/${itemId}`).once('value');
      if (snap.exists()) {
        const val = snap.val();
        fileSize = val.fileSizeBytes || 0;
        category = val.category || 'General';
        fileKey = cleanFileNameKey(val.fileName);
      }
    }

    // A. Delete from Cloudflare R2
    if (r2Client) {
      const categories = [category, 'Photos', 'Videos', 'Audio', 'Documents', 'Archives', 'General'];
      for (const cat of categories) {
        const keyToTry = `${APP_PACKAGE_NAME}/${userKey}/${cat}/${itemId}.enc`;
        try {
          await r2Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: keyToTry
          }));
        } catch (_) {}
      }
    }

    // B. Delete from local storage
    const localFile = findLocalFile(userKey, itemId);
    if (localFile && fs.existsSync(localFile)) {
      try { fs.unlinkSync(localFile); } catch (_) {}
    }

    // C. Remove from Firebase & decrement quota
    if (firebaseDb) {
      await firebaseDb.ref(`users/${userKey}/files/${itemId}`).remove();
      if (fileKey) {
        await firebaseDb.ref(`users/${userKey}/${category}/${fileKey}`).remove();
      }
      if (fileSize > 0) {
        const qSnap = await firebaseDb.ref(`users/${userKey}/quota`).once('value');
        if (qSnap.exists()) {
          const qVal = qSnap.val();
          const newUsed = Math.max(0, (qVal.usedBytes || 0) - fileSize);
          await firebaseDb.ref(`users/${userKey}/quota/usedBytes`).set(newUsed);
        }
      }
    }

    res.json({ success: true, message: `File ${itemId} deleted successfully.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Admin Delete: Delete ALL files for a user (wipe user vault)
app.delete('/api/admin/user/:userKey/files', verifyAdminAuth, async (req, res) => {
  try {
    const { userKey } = req.params;

    // A. Delete all objects in Cloudflare R2 under user prefix
    if (r2Client) {
      try {
        const userPrefix = `${APP_PACKAGE_NAME}/${userKey}/`;
        const listRes = await r2Client.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET_NAME,
          Prefix: userPrefix
        }));

        if (listRes.Contents && listRes.Contents.length > 0) {
          for (const obj of listRes.Contents) {
            await r2Client.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: obj.Key
            }));
          }
        }
      } catch (r2Err) {
        console.warn(`R2 wipe notice for ${userKey}:`, r2Err.message);
      }
    }

    // B. Delete local user directory
    const userDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userKey);
    if (fs.existsSync(userDir)) {
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    }

    // C. Clear files & reset quota in Firebase
    if (firebaseDb) {
      await firebaseDb.ref(`users/${userKey}/files`).remove();
      await firebaseDb.ref(`users/${userKey}/manifest`).remove();
      await firebaseDb.ref(`users/${userKey}/Photos`).remove();
      await firebaseDb.ref(`users/${userKey}/Videos`).remove();
      await firebaseDb.ref(`users/${userKey}/Audio`).remove();
      await firebaseDb.ref(`users/${userKey}/Documents`).remove();
      await firebaseDb.ref(`users/${userKey}/Archives`).remove();
      await firebaseDb.ref(`users/${userKey}/General`).remove();
      await firebaseDb.ref(`users/${userKey}/quota/usedBytes`).set(0);
    }

    res.json({ success: true, message: `All files wiped successfully for user ${userKey}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Admin Delete: Delete user completely (account + all data)
app.delete('/api/admin/user/:userKey', verifyAdminAuth, async (req, res) => {
  try {
    const { userKey } = req.params;

    // A. Delete all R2 objects under user prefix
    if (r2Client) {
      try {
        const userPrefix = `${APP_PACKAGE_NAME}/${userKey}/`;
        const listRes = await r2Client.send(new ListObjectsV2Command({
          Bucket: R2_BUCKET_NAME,
          Prefix: userPrefix
        }));

        if (listRes.Contents && listRes.Contents.length > 0) {
          for (const obj of listRes.Contents) {
            await r2Client.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET_NAME,
              Key: obj.Key
            }));
          }
        }
      } catch (r2Err) {
        console.warn(`R2 delete notice for ${userKey}:`, r2Err.message);
      }
    }

    // B. Delete local user directory
    const userDir = path.join(STORAGE_ROOT, APP_PACKAGE_NAME, userKey);
    if (fs.existsSync(userDir)) {
      try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    }

    // C. Remove entire user record from Firebase
    if (firebaseDb) {
      await firebaseDb.ref(`users/${userKey}`).remove();
    }

    // Remove from localDb fallback
    delete localDb.users[userKey];
    delete localDb.files[userKey];

    res.json({ success: true, message: `User ${userKey} and all associated data permanently deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 DialerVault Central Cloud Backend running on port ${port}`);
});
