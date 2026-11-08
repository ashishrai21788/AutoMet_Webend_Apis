const mongoose = require('../lib/db/mongoose');
const { isPostgres } = require('../lib/db/engine');
const dotenv = require('dotenv');
dotenv.config();

const connectDB = async () => {
  try {
    // Standard Engine: PostgreSQL (see docs/POSTGRES_ENGINE.md)
    if (isPostgres) {
      const dbUrl = process.env.DATABASE_URL || process.env.PROD_POOLER_URL;
      if (!dbUrl) {
        throw new Error('Missing required DATABASE_URL environment variable for PostgreSQL.');
      }
      await mongoose.connect(dbUrl);
      console.log('✅ PostgreSQL connected');
      return;
    }

    // Legacy Fallback only (when explicitly set to DB_ENGINE=mongo)
    const username = process.env.MONGODB_USERNAME;
    const password = process.env.MONGODB_PASSWORD;
    const cluster = process.env.MONGODB_CLUSTER;
    const dbName = process.env.DB_NAME;
    
    const useUri = process.env.DB_USE_URI === '1' && !!process.env.MONGODB_URI;

    if (!useUri && (!username || !password || !cluster || !dbName)) {
      throw new Error('Missing required MongoDB environment variables. Please check your .env file or use DB_ENGINE=postgres (default).');
    }
    
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    
    const mongoURI = useUri
      ? process.env.MONGODB_URI
      : `mongodb+srv://${encodedUsername}:${encodedPassword}@${cluster}/${dbName}?retryWrites=true&w=majority&appName=AshishRai`;
    
    const options = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxIdleTimeMS: 30000,
      retryWrites: true,
      w: 'majority',
      connectTimeoutMS: 10000
    };
    
    await mongoose.connect(mongoURI, options);
    console.log(`✅ MongoDB connected (legacy fallback) to database: ${dbName}`);
    
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err);
    });
    
    mongoose.connection.on('disconnected', () => {
      console.log('⚠️  MongoDB disconnected');
    });
    
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });
    
  } catch (error) {
    console.error('❌ Database connection error:', error.message);
    throw error;
  }
};

module.exports = connectDB;
