import mongoose from 'mongoose';

const callRecordSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true
  },
  callSid: {
    type: String,
    required: true,
    unique: true
  },
  conversationId: {
    type: String,
    sparse: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  location: {
    city: String,
    state: String,
    zip: String,
    country: String
  },
  transcript: mongoose.Schema.Types.Mixed,
  tokenDeployment: {
    name: String,
    ticker: String,
    description: String,
    fid: String,
    requestedAt: Date
  }
}, { timestamps: true });

export default mongoose.model('CallRecord', callRecordSchema); 