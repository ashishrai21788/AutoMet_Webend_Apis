const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const connectDB = async () => {
  try {
    // Build MongoDB URI from environment variables
    const username = process.env.MONGODB_USERNAME;
    const password = process.env.MONGODB_PASSWORD;
    const cluster = process.env.MONGODB_CLUSTER;
    const dbName = process.env.DB_NAME;
    
    // Validate required environment variables
    if (!username || !password || !cluster || !dbName) {
      throw new Error('Missing required MongoDB environment variables. Please check your .env file.');
    }
    
    // URL encode username and password to handle special characters
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    
    const mongoURI = `mongodb+srv://${encodedUsername}:${encodedPassword}@${cluster}/${dbName}?retryWrites=true&w=majority&appName=AshishRai`;
    
    // Configure mongoose connection options
    const options = {
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 10000, // Keep trying to send operations for 10 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      retryWrites: true,
      w: 'majority',
      connectTimeoutMS: 10000 // 10 second connection timeout
    };
    
    await mongoose.connect(mongoURI, options);
    console.log(`✅ MongoDB connected to database: ${dbName}`);
    
    // Set up connection event listeners
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
    console.error('❌ MongoDB connection error:', error.message);
    throw error; // Re-throw to let the calling function handle it
  }
};

module.exports = connectDB; 