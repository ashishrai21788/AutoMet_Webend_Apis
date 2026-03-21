const crypto = require('crypto');
const { createModel } = require('../models/dynamicModel');
const { sendFCMNotification } = require('../config/firestore');
const UserOTP = require('../models/userOtpModel');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required. Refusing to start with insecure fallback.');
}

// Helper to ensure all user fields are present in response (excluding passwordHash)
const ensureAllUserFields = (user) => {
  if (!user) return user;
  const u = typeof user.toObject === 'function' ? user.toObject() : { ...user };
  delete u.passwordHash;
  const defaults = {
    userId: null,
    firstName: null,
    lastName: null,
    phone: null,
    email: null,
    profilePhoto: null,
    isPhoneVerified: false,
    isLoggedin: false,
    accessToken: null,
    fcmToken: null,
    deviceId: null,
    lastActive: null,
    role: 'user',
    createdAt: null,
    updatedAt: null
  };
  const complete = { ...defaults, ...u };
  delete complete.passwordHash;
  complete.fullName = `${complete.firstName || ''} ${complete.lastName || ''}`.trim();
  complete.id = complete._id;
  return complete;
};

// Generate unique userId (same pattern as driverId)
const generateUniqueUserId = async (UserModel) => {
  let userId;
  let isUnique = false;
  let attempts = 0;
  const maxAttempts = 10;

  while (!isUnique && attempts < maxAttempts) {
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    userId = timestamp + random;

    const existing = await UserModel.findOne({ userId });
    if (!existing) isUnique = true;
    attempts++;
  }

  if (!isUnique) throw new Error('Unable to generate unique userId after multiple attempts');
  return userId;
};

// User Registration - collection: users
exports.registerUser = async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: name, phone',
        data: { missingFields: { name: !name, phone: !phone } }
      });
    }

    const nameParts = name.trim().split(/\s+/);
    const firstName = nameParts[0] || name;
    const lastName = nameParts.slice(1).join(' ') || name;
    const phoneTrim = phone.trim();
    const emailLower = email ? email.toLowerCase().trim() : null;

    const UserModel = createModel('users');

    const existingPhone = await UserModel.findOne({ phone: phoneTrim });
    if (existingPhone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number already registered',
        data: { field: 'phone', value: phoneTrim }
      });
    }

    if (emailLower) {
      const existingEmail = await UserModel.findOne({ email: emailLower });
      if (existingEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email already registered',
          data: { field: 'email', value: email }
        });
      }
    }

    const userId = await generateUniqueUserId(UserModel);
    const defaultPassword = Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12);
    const passwordHash = await bcrypt.hash(defaultPassword, 10);

    const userData = {
      userId,
      firstName,
      lastName,
      phone: phoneTrim,
      email: emailLower,
      passwordHash,
      profilePhoto: null,
      isPhoneVerified: false,
      isLoggedin: false,
      accessToken: null,
      fcmToken: null,
      deviceId: null,
      lastActive: new Date(),
      role: 'user'
    };

    const user = new UserModel(userData);
    await user.save();

    // Create OTP for phone verification
    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    const otpRecord = new UserOTP({
      userId,
      phoneNumber: phoneTrim,
      email: emailLower,
      otp,
      isUsed: false,
      expiresAt
    });
    await otpRecord.save();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(201).json({
      success: true,
      message: 'User registered successfully. OTP sent for verification.',
      data: {
        user: ensureAllUserFields(user),
        otp: { expiresAt, message: 'Verify using the OTP sent to your phone.' }
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Phone or email already exists',
        data: { details: error.keyPattern }
      });
    }
    console.error('registerUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration',
      data: { details: error.message }
    });
  }
};

// User Login - find by phone in users, create OTP in users_otp
exports.loginUser = async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: phoneNumber',
        data: { missingFields: { phoneNumber: true } }
      });
    }

    const UserModel = createModel('users');
    const user = await UserModel.findOne({ phone: phoneNumber });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found with this phone number',
        data: { phoneNumber }
      });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    let otpRecord = await UserOTP.findOne({ userId: user.userId, phoneNumber, isUsed: false });
    if (otpRecord) {
      otpRecord.otp = otp;
      otpRecord.expiresAt = expiresAt;
      await otpRecord.save();
    } else {
      otpRecord = new UserOTP({
        userId: user.userId,
        phoneNumber,
        email: user.email || null,
        otp,
        isUsed: false,
        expiresAt
      });
      await otpRecord.save();
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'OTP sent to your registered phone number',
      data: {
        user: ensureAllUserFields(user),
        otp: { expiresAt, message: 'Verify OTP to complete login.' }
      }
    });
  } catch (error) {
    console.error('loginUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
      data: { details: error.message }
    });
  }
};

// Verify OTP - users_otp, update users (isLoggedin, isPhoneVerified, accessToken, deviceId, fcmToken)
exports.verifyUserOtp = async (req, res) => {
  try {
    const { userId, otp, device_id, fcm_id } = req.body;

    if (!userId || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: userId, otp',
        data: { missingFields: { userId: !userId, otp: !otp } }
      });
    }

    const otpRecord = await UserOTP.findOne({
      userId,
      otp,
      isUsed: false,
      expiresAt: { $gt: new Date() }
    });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP',
        data: { userId, otp }
      });
    }

    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId }
      });
    }

    otpRecord.isUsed = true;
    await otpRecord.save();

    const jwtSecret = process.env.JWT_SECRET;
    const tokenPayload = {
      userId: user.userId,
      phone: user.phone,
      email: user.email,
      role: 'user',
      loginTime: new Date().toISOString()
    };
    const accessToken = jwt.sign(tokenPayload, jwtSecret, { expiresIn: '7d' });

    const updateFields = {
      isLoggedin: true,
      isPhoneVerified: true,
      lastActive: new Date(),
      accessToken,
      updatedAt: new Date()
    };
    if (device_id != null && typeof device_id === 'string' && device_id.trim()) {
      updateFields.deviceId = device_id.trim();
    }
    if (fcm_id != null && typeof fcm_id === 'string' && fcm_id.trim()) {
      updateFields.fcmToken = fcm_id.trim();
    }
    await UserModel.findByIdAndUpdate(user._id, updateFields);

    const updatedUser = await UserModel.findOne({ userId }).lean();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'OTP verified successfully',
      data: {
        user: ensureAllUserFields(updatedUser),
        accessToken,
        loginTime: new Date().toISOString(),
        sessionInfo: { isLoggedin: true, isPhoneVerified: true, tokenExpiresIn: '7d' }
      }
    });
  } catch (error) {
    console.error('verifyUserOtp error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during OTP verification',
      data: { details: error.message }
    });
  }
};

/**
 * Update FCM token and/or device ID for user (call when token refreshes on mobile).
 * POST /api/users/update-token
 * Body: userId (required), fcm_id (optional), device_id (optional). At least one of fcm_id or device_id.
 */
exports.updateUserToken = async (req, res) => {
  try {
    const { userId, fcm_id, device_id } = req.body;
    const userIdValue = (userId != null && typeof userId === 'string') ? userId.trim() : '';
    if (!userIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: userId',
        data: { missingFields: { userId: true } }
      });
    }
    const hasFcm = fcm_id != null && typeof fcm_id === 'string' && fcm_id.trim() !== '';
    const hasDevice = device_id != null && typeof device_id === 'string' && device_id.trim() !== '';
    if (!hasFcm && !hasDevice) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one of: fcm_id, device_id',
        data: { missingFields: { fcm_id: !hasFcm, device_id: !hasDevice } }
      });
    }
    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId: userIdValue });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId: userIdValue }
      });
    }
    const updateFields = { updatedAt: new Date() };
    if (hasFcm) updateFields.fcmToken = fcm_id.trim();
    if (hasDevice) updateFields.deviceId = device_id.trim();
    await UserModel.findByIdAndUpdate(user._id, { $set: updateFields });
    const updated = await UserModel.findOne({ userId: userIdValue }).lean();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      success: true,
      message: 'Token updated successfully',
      data: {
        userId: userIdValue,
        fcmToken: updated.fcmToken != null,
        deviceId: updated.deviceId != null
      }
    });
  } catch (error) {
    console.error('updateUserToken error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating token',
      data: { details: error.message }
    });
  }
};

// Update User Profile - firstName, lastName, profilePhoto
exports.updateUserProfile = async (req, res) => {
  try {
    const { userId, firstName, lastName, profilePhoto } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: userId',
        data: { missingFields: { userId: true } }
      });
    }

    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId }
      });
    }

    const updateData = { updatedAt: new Date() };
    if (firstName !== undefined) {
      if (!firstName || String(firstName).trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'firstName cannot be empty',
          data: { field: 'firstName' }
        });
      }
      updateData.firstName = String(firstName).trim();
    }
    if (lastName !== undefined) {
      if (!lastName || String(lastName).trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: 'lastName cannot be empty',
          data: { field: 'lastName' }
        });
      }
      updateData.lastName = String(lastName).trim();
    }
    if (profilePhoto !== undefined) {
      if (profilePhoto !== null && (!profilePhoto || String(profilePhoto).trim().length === 0)) {
        return res.status(400).json({
          success: false,
          message: 'profilePhoto cannot be empty',
          data: { field: 'profilePhoto' }
        });
      }
      updateData.profilePhoto = profilePhoto == null ? null : String(profilePhoto).trim();
    }

    if (Object.keys(updateData).length === 1) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update. Provide at least one of: firstName, lastName, profilePhoto',
        data: { allowedFields: ['firstName', 'lastName', 'profilePhoto'] }
      });
    }

    const updated = await UserModel.findOneAndUpdate({ userId }, updateData, { new: true });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: { user: ensureAllUserFields(updated) }
    });
  } catch (error) {
    console.error('updateUserProfile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating profile',
      data: { details: error.message }
    });
  }
};

// Resend OTP - users_otp
exports.resendUserOtp = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: userId',
        data: { missingFields: { userId: true } }
      });
    }

    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId }
      });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await UserOTP.deleteMany({ userId });
    const otpRecord = new UserOTP({
      userId,
      phoneNumber: user.phone,
      email: user.email || null,
      otp,
      isUsed: false,
      expiresAt
    });
    await otpRecord.save();

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'OTP resent successfully',
      data: {
        user: ensureAllUserFields(user),
        otp: { expiresAt, message: 'New OTP sent to your registered phone number.' }
      }
    });
  } catch (error) {
    console.error('resendUserOtp error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while resending OTP',
      data: { details: error.message }
    });
  }
};

// Get User Detail by userId - collection: users
exports.getUserByUserId = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: userId',
        data: { missingFields: { userId: true } }
      });
    }

    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId }
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'User detail retrieved successfully',
      data: { user: ensureAllUserFields(user) }
    });
  } catch (error) {
    console.error('getUserByUserId error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving user detail',
      data: { details: error.message }
    });
  }
};

// User Logout - collection: users
exports.logoutUser = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: userId',
        data: { missingFields: { userId: true } }
      });
    }

    const UserModel = createModel('users');
    const updated = await UserModel.findOneAndUpdate(
      { userId },
      {
        isLoggedin: false,
        lastActive: new Date(),
        fcmToken: null,
        deviceId: null,
        accessToken: null,
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId }
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'User logged out successfully',
      data: {
        user: ensureAllUserFields(updated),
        logoutTime: new Date().toISOString(),
        sessionInfo: { isLoggedin: false, lastActive: updated.lastActive, fcmToken: null, deviceId: null }
      }
    });
  } catch (error) {
    console.error('logoutUser error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during logout',
      data: { details: error.message }
    });
  }
};

// Send push notification to a user (FCM, Android-standard payload) and save to users_notification
exports.sendUserNotification = async (req, res) => {
  try {
    const { user_id, userId, title, body, data, channelId } = req.body;
    const userIdValue = (user_id || userId || '').toString().trim();
    if (!userIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: userId (or user_id)',
        data: { missingFields: { userId: true } }
      });
    }
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: title',
        data: { missingFields: { title: true } }
      });
    }
    const UserModel = createModel('users');
    const user = await UserModel.findOne({ userId: userIdValue }).lean();
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
        data: { userId: userIdValue }
      });
    }
    const fcmToken = user.fcmToken;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'User has no FCM token. Ask the user app to register the device token.',
        data: { userId: userIdValue }
      });
    }
    const payload = {
      title: title.trim(),
      body: (body && typeof body === 'string') ? body.trim() : '',
      channelId: (channelId && typeof channelId === 'string') ? channelId.trim() : 'user_notifications'
    };
    if (data && typeof data === 'object') payload.data = data;
    const result = await sendFCMNotification(fcmToken, payload);
    if (!result.success) {
      return res.status(502).json({
        success: false,
        message: 'Failed to send push notification',
        data: { error: result.error }
      });
    }
    const mongoose = require('mongoose');
    const coll = mongoose.connection.db.collection('users_notification');
    const now = new Date();
    const doc = {
      userId: userIdValue,
      title: payload.title,
      description: payload.body || '',
      date: now.toISOString(),
      isUnread: true,
      type: (data && data.type) || 'Informational',
      createdAt: now,
      updatedAt: now
    };
    try {
      await coll.insertOne(doc);
    } catch (insertErr) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[sendUserNotification] Could not save to users_notification:', insertErr.message);
      }
    }
    res.status(200).json({
      success: true,
      message: 'Push notification sent successfully',
      data: {
        messageId: result.messageId,
        userId: userIdValue,
        title: payload.title
      }
    });
  } catch (error) {
    console.error('Send user notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while sending notification',
      data: { details: error.message }
    });
  }
};

// Get User Notifications - collection: users_notification
exports.getUserNotifications = async (req, res) => {
  try {
    const { userId, user_id } = req.query;
    const userIdValue = userId || user_id;

    const mongoose = require('mongoose');
    const db = mongoose.connection.db;
    const coll = db.collection('users_notification');

    const query = {};
    if (userIdValue) query.userId = userIdValue;

    const list = await coll.find(query).sort({ date: -1 }).toArray();
    const formatted = list.map(n => ({
      id: n._id.toString(),
      notification_id: n.notification_id || n._id.toString(),
      title: n.title || '',
      description: n.description || '',
      date: n.date || '',
      isUnread: n.isUnread !== undefined ? n.isUnread : true,
      type: n.type || 'Informational',
      userId: n.userId || null,
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'Notifications retrieved successfully',
      data: {
        notifications: formatted,
        totalCount: formatted.length,
        unreadCount: formatted.filter(x => x.isUnread === true).length
      }
    });
  } catch (error) {
    console.error('getUserNotifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while retrieving notifications',
      data: { details: error.message }
    });
  }
};

// Mark User Notifications as Read - collection: users_notification
exports.updateUserNotificationReadStatus = async (req, res) => {
  try {
    const { user_id, userId, notificationIds } = req.body;
    const userIdValue = user_id || userId;

    if (!userIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: user_id',
        data: { missingFields: { user_id: true } }
      });
    }
    if (!notificationIds) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: notificationIds',
        data: { missingFields: { notificationIds: true } }
      });
    }
    if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'notificationIds must be a non-empty array',
        data: { notificationIds }
      });
    }

    const mongoose = require('mongoose');
    const ObjectId = mongoose.Types.ObjectId;
    const db = mongoose.connection.db;
    const coll = db.collection('users_notification');

    const validIds = [];
    const invalidIds = [];
    for (const id of notificationIds) {
      if (ObjectId.isValid(id)) validIds.push(new ObjectId(id));
      else invalidIds.push(id);
    }
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID format(s)',
        data: { invalidIds, validIds: validIds.map(i => i.toString()) }
      });
    }

    const filter = { _id: { $in: validIds }, userId: userIdValue };
    const updateResult = await coll.updateMany(filter, {
      $set: { isUnread: false, updatedAt: new Date() }
    });

    const updated = await coll.find(filter).toArray();
    const formatted = updated.map(n => ({
      id: n._id.toString(),
      notification_id: n.notification_id || n._id.toString(),
      title: n.title || '',
      description: n.description || '',
      date: n.date || '',
      isUnread: false,
      type: n.type || 'Informational',
      userId: n.userId || null,
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'Notification read status updated successfully',
      data: {
        updatedCount: updateResult.modifiedCount,
        matchedCount: updateResult.matchedCount,
        notifications: formatted,
        summary: {
          totalRequested: notificationIds.length,
          successfullyUpdated: updateResult.modifiedCount,
          alreadyRead: updateResult.matchedCount - updateResult.modifiedCount
        }
      }
    });
  } catch (error) {
    console.error('updateUserNotificationReadStatus error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating notification read status',
      data: { details: error.message }
    });
  }
};

// Delete a User Notification - collection: users_notification
exports.deleteUserNotification = async (req, res) => {
  try {
    const { userId, user_id, notificationId, notification_id } = req.query;
    const userIdValue = userId || user_id;
    const notificationIdValue = notificationId || notification_id;

    if (!userIdValue || !notificationIdValue) {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameters: userId, notificationId',
        data: { missingFields: { userId: !userIdValue, notificationId: !notificationIdValue } }
      });
    }

    const mongoose = require('mongoose');
    const ObjectId = mongoose.Types.ObjectId;
    const db = mongoose.connection.db;
    const coll = db.collection('users_notification');

    if (!ObjectId.isValid(notificationIdValue)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID format',
        data: { notificationId: notificationIdValue }
      });
    }

    const deleteResult = await coll.deleteOne({
      _id: new ObjectId(notificationIdValue),
      userId: userIdValue
    });

    if (deleteResult.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found or does not belong to this user',
        data: { userId: userIdValue, notificationId: notificationIdValue }
      });
    }

    // Return remaining notifications
    const notifications = await coll
      .find({ userId: userIdValue })
      .sort({ date: -1 })
      .toArray();

    const formatted = notifications.map(n => ({
      id: n._id.toString(),
      notification_id: n.notification_id || n._id.toString(),
      title: n.title || '',
      description: n.description || '',
      date: n.date || '',
      isUnread: n.isUnread !== undefined ? n.isUnread : true,
      type: n.type || 'Informational',
      userId: n.userId || null,
      createdAt: n.createdAt || null,
      updatedAt: n.updatedAt || null
    }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully',
      data: {
        notifications: formatted,
        totalCount: formatted.length,
        unreadCount: formatted.filter(n => n.isUnread === true).length
      }
    });
  } catch (error) {
    console.error('deleteUserNotification error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting notification',
      data: { details: error.message }
    });
  }
};
