const admin = require('firebase-admin');
const path = require('path');
require('dotenv').config();

async function setupRazorpayInFirebase(customKeyId, customKeySecret) {
  let serviceAccount = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } else {
    serviceAccount = require('./firebase-service-account.json');
  }

  const databaseURL = process.env.FIREBASE_DATABASE_URL || 'https://dialervault-2193e-default-rtdb.firebaseio.com/';

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL
    });
  }

  const db = admin.database();

  const keyId = customKeyId || process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder_key_id';
  const keySecret = customKeySecret || process.env.RAZORPAY_KEY_SECRET || 'placeholder_key_secret';

  const razorpayConfig = {
    enabled: true,
    key_id: keyId,
    key_secret: keySecret,
    currency: 'INR',
    amount_in_paise: 1000, // ₹10.00
    plan_name: '100 GB Lifetime Cloud Vault',
    description: 'Permanent 100 GB High-Speed Encrypted Cloud Storage & Disaster Recovery',
    updated_at: new Date().toISOString()
  };

  // Update server_config.razorpay
  await db.ref('server_config/razorpay').update(razorpayConfig);
  console.log('✅ Successfully configured server_config/razorpay in Firebase Realtime Database!');

  const snapshot = await db.ref('server_config/razorpay').once('value');
  console.log('Current Razorpay Config in Firebase:', snapshot.val());
}

const argKeyId = process.argv[2];
const argKeySecret = process.argv[3];

setupRazorpayInFirebase(argKeyId, argKeySecret)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Failed to update Firebase:', err);
    process.exit(1);
  });
