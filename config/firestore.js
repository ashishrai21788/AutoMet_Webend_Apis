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
  deleteDriverFromFirestore
};
