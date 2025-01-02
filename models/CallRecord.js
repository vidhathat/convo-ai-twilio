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
  timestamp: {
    type: Date,
    default: Date.now
  },
  location: {
    city: String,
    state: String,
    zip: String,
    country: String
  }
});

export default mongoose.model('CallRecord', callRecordSchema); 