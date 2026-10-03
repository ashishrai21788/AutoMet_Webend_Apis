const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Firebase Admin SDK - used only for FCM (push notifications). No Firestore DB usage.
let firebaseInitialized = false;

// Coarse, secret-free reason FCM is (not) ready, exposed on /health so a misconfigured key can be diagnosed
// without access to the server logs. Only fixed codes go in here: never key material or raw error text.
//   OK | NOT_CONFIGURED | KEY_EMPTY | KEY_NOT_JSON | KEY_MISSING_FIELDS | KEY_REJECTED
//   PATH_NOT_FOUND | PROJECT_ID_ONLY | INIT_ERROR | NOT_INITIALIZED
let fcmStatus = 'NOT_INITIALIZED';
let fcmProjectId = null;

function fcmError(code, message) {
  const err = new Error(message);
  err.fcmCode = code;
  return err;
}

function resolveServiceAccountPath(envPath) {
  if (!envPath || typeof envPath !== 'string') return null;
  const trimmed = envPath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return trimmed;
  const projectRoot = path.join(__dirname, '..');
  return path.resolve(projectRoot, trimmed);
}

/**
 * Parse FIREBASE_SERVICE_ACCOUNT_KEY. Accepts either the raw service-account JSON or the same JSON base64-encoded
 * (base64 avoids quote/newline mangling when a multi-line JSON file is pasted into a hosting dashboard).
 * The private key's "\n" escape sequences are turned into real newlines, which firebase-admin requires.
 */
function parseServiceAccount(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) throw fcmError('KEY_EMPTY', 'FIREBASE_SERVICE_ACCOUNT_KEY is empty');
  if (!text.startsWith('{')) {
    text = Buffer.from(text, 'base64').toString('utf8').trim();
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(text);
  } catch (e) {
    throw fcmError(
      'KEY_NOT_JSON',
      'FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON (or valid base64 of the JSON file): ' + e.message
    );
  }
  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw fcmError('KEY_MISSING_FIELDS', 'FIREBASE_SERVICE_ACCOUNT_KEY is missing project_id, client_email or private_key');
  }
  return serviceAccount;
}

const initializeFirestore = () => {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

    if (admin.apps.length === 0) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        let credential;
        try {
          credential = admin.credential.cert(serviceAccount);
        } catch (certError) {
          // firebase-admin refused the key (typically a malformed private_key)
          certError.fcmCode = 'KEY_REJECTED';
          throw certError;
        }
        admin.initializeApp({ credential });
        fcmProjectId = serviceAccount.project_id;
        console.log('✅ FCM: using service account for Firebase project', serviceAccount.project_id);
      }
      else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const resolvedPath = resolveServiceAccountPath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        if (resolvedPath && fs.existsSync(resolvedPath)) {
          const serviceAccount = require(resolvedPath);
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
          });
          fcmProjectId = serviceAccount.project_id || null;
        } else {
          console.warn('⚠️  FCM: FIREBASE_SERVICE_ACCOUNT_PATH set but file not found:', resolvedPath || process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
          fcmStatus = 'PATH_NOT_FOUND';
          return null;
        }
      }
      else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault()
        });
      }
      else if (process.env.FIREBASE_PROJECT_ID) {
        // projectId alone does not grant FCM send permissions — avoid a false "initialized" state
        console.warn(
          '⚠️  FCM: FIREBASE_PROJECT_ID is set but no service account credentials were found. ' +
            'Push will not work until you set FIREBASE_SERVICE_ACCOUNT_PATH, FIREBASE_SERVICE_ACCOUNT_KEY, or GOOGLE_APPLICATION_CREDENTIALS.'
        );
        fcmStatus = 'PROJECT_ID_ONLY';
        return null;
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
        fcmStatus = 'NOT_CONFIGURED';
        return null;
      }
    }

    firebaseInitialized = true;
    fcmStatus = 'OK';
    console.log('✅ FCM (Firebase) initialized for push notifications');
    return admin.apps[0];
  } catch (error) {
    fcmStatus = error.fcmCode || 'INIT_ERROR';
    console.error('❌ FCM initialization error:', error.message);
    return null;
  }
};

/**
 * Secret-free FCM diagnostics for /health: a fixed status code and the Firebase project id of the key in use
 * (the project id is not secret; it is embedded in every app's google-services.json).
 */
const getFcmStatus = () => ({ status: fcmStatus, projectId: fcmProjectId });

const getAdmin = () => {
  if (!firebaseInitialized && admin.apps.length === 0) {
    initializeFirestore();
  }
  return admin.apps.length > 0 ? admin : null;
};

/**
 * True if Firebase Admin is initialized and FCM send() can be used.
 * Call before creating a trip so we fail fast with a clear error instead of creating then deleting the trip.
 */
const isFcmReady = () => {
  if (admin.apps.length === 0) {
    initializeFirestore();
  }
  return admin.apps.length > 0;
};

/**
 * Send a push notification via FCM (Firebase Cloud Messaging). FCM token from MongoDB (drivers.fcmToken / users.fcmToken).
 * @param {string} fcmToken - Device FCM token from MongoDB (driver or user document)
 * @param {{ title: string, body?: string, data?: Record<string, string>, channelId?: string }} payload - title, body, optional data (values stringified), optional channelId (Android; default 'default')
 * @param {{ dataOnly?: boolean }} [options] - If dataOnly=true, omit top-level `notification` so Android always invokes onMessageReceived (high-priority data message). title/body/channel_id are copied into `data` for client display.
 * @returns {{ success: true, messageId: string } | { success: false, error: string }}
 */
const sendFCMNotification = async (fcmToken, payload, options = {}) => {
  try {
    const adm = getAdmin();
    if (!adm || !adm.messaging) {
      return { success: false, error: 'Firebase Admin not initialized or FCM unavailable. Set FIREBASE_SERVICE_ACCOUNT_KEY or FIREBASE_SERVICE_ACCOUNT_PATH.' };
    }
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return { success: false, error: 'FCM token is required' };
    }
    const dataOnly = options.dataOnly === true;
    const channelId = (payload.channelId && typeof payload.channelId === 'string') ? payload.channelId.trim() : 'default';
    const title = payload.title || 'Notification';
    const body = payload.body || '';

    const message = {
      token: fcmToken.trim(),
      android: {
        priority: 'high'
      },
      data: {}
    };

    if (payload.data && typeof payload.data === 'object') {
      for (const [k, v] of Object.entries(payload.data)) {
        message.data[String(k)] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }

    if (dataOnly) {
      if (message.data.title == null || message.data.title === '') message.data.title = title;
      if (message.data.body == null || message.data.body === '') message.data.body = body;
      if (message.data.channel_id == null || message.data.channel_id === '') message.data.channel_id = channelId;
    } else {
      message.notification = { title, body };
      message.android.notification = {
        channelId,
        sound: 'default',
        priority: 'high',
        defaultVibrateTimings: true
      };
    }

    const messageId = await adm.messaging().send(message);
    return { success: true, messageId };
  } catch (error) {
    const msg = error.message || String(error);
    const errorCode = error.code || (error.errorInfo && error.errorInfo.code) || null;
    console.warn('[FCM] Send failed:', msg, errorCode || '');
    return { success: false, error: msg, errorCode };
  }
};

module.exports = {
  initializeFirestore,
  getAdmin,
  isFcmReady,
  sendFCMNotification,
  parseServiceAccount,
  getFcmStatus
};
