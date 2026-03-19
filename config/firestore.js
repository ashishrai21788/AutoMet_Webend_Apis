const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Firebase Admin SDK - used only for FCM (push notifications). No Firestore DB usage.
let firebaseInitialized = false;

function resolveServiceAccountPath(envPath) {
  if (!envPath || typeof envPath !== 'string') return null;
  const trimmed = envPath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return trimmed;
  const projectRoot = path.join(__dirname, '..');
  return path.resolve(projectRoot, trimmed);
}

const initializeFirestore = () => {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

    if (admin.apps.length === 0) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      }
      else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const resolvedPath = resolveServiceAccountPath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        if (resolvedPath && fs.existsSync(resolvedPath)) {
          const serviceAccount = require(resolvedPath);
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
          });
        } else {
          console.warn('⚠️  FCM: FIREBASE_SERVICE_ACCOUNT_PATH set but file not found:', resolvedPath || process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
          return null;
        }
      }
      else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault()
        });
      }
      else if (process.env.FIREBASE_PROJECT_ID) {
        admin.initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID
        });
      }
      else {
        const envPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
        const projectRoot = path.join(__dirname, '..');
        const defaultPath = path.join(projectRoot, 'automet-89e4b-firebase-adminsdk-fbsvc-973c0f0fdd.json');
        console.warn('⚠️  FCM not configured. Set one of these in your .env (for push notifications):');
        console.warn('    FIREBASE_SERVICE_ACCOUNT_PATH=./automet-89e4b-firebase-adminsdk-fbsvc-973c0f0fdd.json');
        if (!envPath || !envPath.trim()) {
          console.warn('    (FIREBASE_SERVICE_ACCOUNT_PATH is missing or empty. Expected file:', defaultPath + ')');
        }
        return null;
      }
    }

    firebaseInitialized = true;
    console.log('✅ FCM (Firebase) initialized for push notifications');
    return admin.apps[0];
  } catch (error) {
    console.error('❌ FCM initialization error:', error.message);
    return null;
  }
};

const getAdmin = () => {
  if (!firebaseInitialized && admin.apps.length === 0) {
    initializeFirestore();
  }
  return admin.apps.length > 0 ? admin : null;
};

/**
 * Send a push notification via FCM (Firebase Cloud Messaging). FCM token from MongoDB (drivers.fcmToken / users.fcmToken).
 * @param {string} fcmToken - Device FCM token from MongoDB (driver or user document)
 * @param {{ title: string, body?: string, data?: Record<string, string>, channelId?: string }} payload - title, body, optional data (values stringified), optional channelId (Android; default 'default')
 * @returns {{ success: true, messageId: string } | { success: false, error: string }}
 */
const sendFCMNotification = async (fcmToken, payload) => {
  try {
    const adm = getAdmin();
    if (!adm || !adm.messaging) {
      return { success: false, error: 'Firebase Admin not initialized or FCM unavailable. Set FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_SERVICE_ACCOUNT_PATH.' };
    }
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return { success: false, error: 'FCM token is required' };
    }
    const channelId = (payload.channelId && typeof payload.channelId === 'string') ? payload.channelId.trim() : 'default';
    const message = {
      token: fcmToken.trim(),
      notification: {
        title: payload.title || 'Notification',
        body: payload.body || ''
      },
      android: {
        priority: 'high',
        notification: {
          channelId,
          sound: 'default',
          priority: 'high',
          defaultVibrateTimings: true
        }
      },
      data: {}
    };
    if (payload.data && typeof payload.data === 'object') {
      for (const [k, v] of Object.entries(payload.data)) {
        message.data[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    const messageId = await adm.messaging().send(message);
    return { success: true, messageId };
  } catch (error) {
    const msg = error.message || String(error);
    const errorCode = error.code || (error.errorInfo && error.errorInfo.code) || null;
    if (process.env.NODE_ENV === 'development') {
      console.error('[FCM] Send error:', msg, errorCode || '');
    }
    return { success: false, error: msg, errorCode };
  }
};

module.exports = {
  initializeFirestore,
  getAdmin,
  sendFCMNotification
};
