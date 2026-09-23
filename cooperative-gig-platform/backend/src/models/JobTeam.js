const mongoose = require('mongoose');

const jobTeamSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      unique: true,
    },
    leadWorker: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Worker',
      required: true,
    },
    collaborationRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CollaborationRequest',
      index: true,
    },
    members: [
      {
        worker: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Worker',
          required: true,
        },
        role: {
          type: String,
          default: 'Helper',
        },
        status: {
          type: String,
          enum: ['INVITED', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'NO_SHOW'],
          default: 'INVITED',
        },
        paymentEstimate: {
          type: Number,
          default: 0,
        },
        // How much the lead worker has actually paid to this member.
        paidAmount: {
          type: Number,
          default: 0,
        },
        // When this member was last paid (reset only by a fresh disbursement).
        paymentPaidAt: Date,
        invitedAt: Date,
        acceptedAt: Date,
        joinedAt: Date,
        noShowDetectedAt: Date,
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: { type: [Number], default: undefined },
        },
        lastLocationUpdate: Date,
      },
    ],
    completed: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

jobTeamSchema.index({ leadWorker: 1 });

module.exports = mongoose.model('JobTeam', jobTeamSchema);