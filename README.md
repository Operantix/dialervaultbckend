# DialerVault Central Cloud Backup Backend (Railway, Google Drive & Firebase)

This backend server connects:
1. **Developer Central Google Drive**: Stores all files categorized neatly into folders (`user@email.com / Photos`, `user@email.com / Videos`, etc.).
2. **Firebase Realtime Database**: Stores the active backend server URL (`server_config/backend_url`), file metadata catalogs, and user quota tracking.
3. **Railway / Render**: Hosts this lightweight Node.js Express server.

---

## 🛡️ Zero-Downtime Guarantee (If Railway Goes Down)

You store your active server URL in Firebase Realtime Database:
```json
{
  "server_config": {
    "backend_url": "https://dialervault-production.up.railway.app"
  }
}
```

If Railway ever goes down:
1. Deploy this code to **Render.com** (Free) or **Koyeb.com** (Free).
2. Go to your **Firebase Console** -> Realtime Database -> Change `backend_url` to:
   `https://dialervault.onrender.com`
3. **All users' apps instantly switch to the new host without requiring an app update!**

---

## 📁 Google Drive Structure
Files uploaded by users are saved directly into your developer Google Drive in this clean hierarchy:
```text
📁 DialerVault_Central_Backups/
   └── 📁 user_john_doe@gmail.com/
       ├── 📁 Photos/
       │   └── 3a2f8b.enc
       ├── 📁 Videos/
       │   └── 7c9d1e.enc
       ├── 📁 Documents/
       │   └── e4f5a6.enc
       └── 📄 vault_index.json
```

---

## 🚀 Setup & Deployment (5 Minutes)

### Step 1: Google Cloud Service Account
1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Drive API**.
3. Create a Service Account (e.g. `dialervault-drive-bot`).
4. Generate a JSON Key (`credentials.json`).
5. Open your central Google Drive, create folder `DialerVault_Central_Backups`, and share it with the Service Account email as **Editor**.
6. Copy the Folder ID from the Drive URL.

### Step 2: Firebase Realtime Database
1. Go to [Firebase Console](https://console.firebase.google.com/).
2. Create a project and enable **Realtime Database**.
3. Create the node `server_config`:
   ```json
   {
     "server_config": {
       "backend_url": "https://your-railway-app.up.railway.app"
     }
   }
   ```
4. Generate Firebase Service Account Key (Project Settings -> Service Accounts -> Generate Private Key).

### Step 3: Deploy to Railway
Add these Environment Variables in Railway settings:
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Paste entire Google Drive Service Account JSON.
- `GOOGLE_DRIVE_FOLDER_ID`: Your Google Drive root folder ID.
- `FIREBASE_DATABASE_URL`: `https://your-project-id-default-rtdb.firebaseio.com`
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Paste entire Firebase Service Account JSON.
- `PORT`: `3000`
