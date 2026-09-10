const admin = require('firebase-admin');

async function updateBackendUrl(newUrl) {
  const serviceAccount = require('./firebase-service-account.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://dialervault-2193e-default-rtdb.firebaseio.com/'
  });

  const db = admin.database();
  await db.ref('server_config').update({
    backend_url: newUrl,
    status: 'active',
    updated_at: new Date().toISOString()
  });

  console.log('Successfully updated Firebase server_config.backend_url to:', newUrl);
  const snap = await db.ref('server_config').once('value');
  console.log('Current value in Firebase:', snap.val());
}

const targetUrl = process.argv[2] || 'https://twyla-fragmented-viscerally.ngrok-free.dev';
updateBackendUrl(targetUrl).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
