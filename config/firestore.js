const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
let firestoreInitialized = false;

const initializeFirestore = () => {
  try {
    // Check if Firebase Admin is already initialized
    if (admin.apps.length === 0) {
      // Initialize with service account credentials from environment variable
      // Option 1: Using service account JSON (recommended for production)
      if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      }
      // Option 2: Using service account file path
      else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
      }
      // Option 3: Using default credentials (for Google Cloud environments)
      else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault()
        });
      }
      // Option 4: Using project ID (for development/testing)
      else if (process.env.FIREBASE_PROJECT_ID) {
        admin.initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID
        });
      }
      else {
        console.warn('⚠️  Firestore not configured. Set FIREBASE_SERVICE_ACCOUNT_KEY, FIREBASE_SERVICE_ACCOUNT_PATH, GOOGLE_APPLICATION_CREDENTIALS, or FIREBASE_PROJECT_ID in environment variables.');
        return null;
      }
    }
    
    firestoreInitialized = true;
    console.log('✅ Firestore initialized successfully');
    return admin.firestore();
  } catch (error) {
    console.error('❌ Firestore initialization error:', error.message);
    return null;
  }
};

// Get Firestore instance
const getFirestore = () => {
  if (!firestoreInitialized) {
    return initializeFirestore();
  }
  return admin.firestore();
};

// Get Firebase Admin instance (for FCM messaging)
const getAdmin = () => {
  if (!firestoreInitialized && admin.apps.length === 0) {
    initializeFirestore();
  }
  return admin.apps.length > 0 ? admin : null;
};

/**
 * Send a push notification via FCM to a single device token (Android-standard payload).
 * Uses Android config: high priority, notification channel, so messages display correctly on Android.
 * @param {string} fcmToken - Device FCM token (from driver/user fcmToken field)
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
    if (process.env.NODE_ENV === 'development') {
      console.error('[FCM] Send error:', msg);
    }
    return { success: false, error: msg };
  }
};

// Delete driver from Firestore
const deleteDriverFromFirestore = async (driverId) => {
  try {
    const db = getFirestore();
    if (!db) {
      console.warn('⚠️  Firestore not initialized. Skipping driver deletion from Firestore.');
      return { success: false, message: 'Firestore not initialized' };
    }

    // Get the collection name from environment or use default
    const collectionName = process.env.FIRESTORE_DRIVERS_COLLECTION || 'drivers';
    
    // Delete the driver document
    const driverRef = db.collection(collectionName).doc(driverId);
    await driverRef.delete();
    
    console.log(`✅ Driver ${driverId} deleted from Firestore collection: ${collectionName}`);
    return { success: true, message: 'Driver deleted from Firestore' };
  } catch (error) {
    // If document doesn't exist, that's okay - just log it
    if (error.code === 5) { // NOT_FOUND error code
      console.log(`ℹ️  Driver ${driverId} not found in Firestore (may have already been deleted)`);
      return { success: true, message: 'Driver not found in Firestore (already deleted or never existed)' };
    }
    console.error(`❌ Error deleting driver ${driverId} from Firestore:`, error.message);
    return { success: false, message: error.message, error: error };
  }
};

module.exports = {
  initializeFirestore,
  getFirestore,
  getAdmin,
  sendFCMNotification,
  deleteDriverFromFirestore
};
