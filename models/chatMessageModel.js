const mongoose = require('../lib/db/mongoose');

/**
 * One message in a ride's chat between its rider and its driver. The server is the only writer: it checks that the sender is one of
 * the trip's two people, that the ride is still on, and which business it belongs to, then stores the message and tells the other
 * person's app. `clientId` is made by the sending app so a retry after a lost answer never stores the message twice.
 */
const chatMessageSchema = new mongoose.Schema({
  tenantId: { type: String, default: null, index: true },
  messageId: { type: String, required: true, unique: true },
  tripId: { type: String, required: true },
  senderRole: { type: String, enum: ['rider', 'driver'], required: true },
  senderId: { type: String, required: true },
  recipientId: { type: String, required: true },
  text: { type: String, required: true },
  clientId: { type: String, required: true }, // from the app; the server fills one in when the app sends none
  createdAt: { type: Date, default: Date.now },
  readAt: { type: Date, default: null }
}, { collection: 'chat_messages' });
chatMessageSchema.index({ tripId: 1, createdAt: 1 });
chatMessageSchema.index({ tripId: 1, senderId: 1, clientId: 1 }, { unique: true });

module.exports = { ChatMessage: mongoose.models.ChatMessage || mongoose.model('ChatMessage', chatMessageSchema) };
