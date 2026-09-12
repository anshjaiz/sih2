const mongoose = require('mongoose');

const workerProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    bio: {
      type: String,
      maxlength: 500,
      default: '',
    },
    // Location structure: { type: 'Point', coordinates: [lng, lat] }
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number],
        default: [78.4867, 17.385], // Default Hyderabad
      },
    },
    address: {
      type: String,
      default: '',
    },
    area: {
      type: String,
      default: '',
    },
    city: {
      type: String,
      default: '',
    },
    skills: [
      {
        skill: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Skill',
        },
        name: String, // denormalized for quick display
        // Admin-approved skill. Only verified skills qualify for job matching.
        verified: {
          type: Boolean,
          default: false,
        },
        verifiedAt: Date,
        yearsOfExperience: {
          type: Number,
          default: 0,
        },
      },
    ],
    experienceYears: {
      type: Number,
      default: 0,
    },
    languages: {
      type: [String],
      default: [],
    },
    serviceAreaRadiusKm: {
      type: Number,
      default: 15,
    },
    // Service area as a polygon/points
    serviceAreas: {
      type: [String],
      default: [],
    },
    verificationStatus: {
      type: String,
      enum: ['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED'],
      default: 'PENDING',
    },
    verificationRemark: {
      type: String,
      default: '',
    },
    // Administrative suspension (safety/high-severity complaints)
    suspensionNote: {
      type: String,
      default: '',
    },
    suspendedFrom: Date,
    suspendedUntil: Date,
    // 3-strike tracking: counts administrative suspensions toward permanent termination
    suspensionCount: {
      type: Number,
      default: 0,
    },
    terminatedAt: Date,
    terminationReason: {
      type: String,
      default: '',
    },
    // Disciplinary history
    warnings: [
      {
        title: String,
        reason: String,
        complaint: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Complaint',
        },
        at: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    certificates: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Certificate',
      },
    ],
    // Rating/statistics (denormalized for performance)
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
    completedJobs: {
      type: Number,
      default: 0,
    },
    totalEarnings: {
      type: Number,
      default: 0,
    },
    // Collaborator network / team collaboration profile
    collaborationsCount: {
      type: Number,
      default: 0,
    },
    collaborationRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    punctuality: {
      type: Number,
      default: 0, // percent 0-100
      max: 100,
    },
    reliability: {
      type: Number,
      default: 100, // percent 0-100
      max: 100,
      min: 0,
    },
    // Denormalized alias kept in sync with `reliability` for cancellation
    // outcomes/metrics; never used as the source of truth.
    meritScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    // Reliability lifecycle status driven by the merit score. This is SEPARATE
    // from administrative suspension (isActive / suspensionUntil) which is
    // handled by complaintService. Low-reliability states here only restrict
    // earning (job acceptance, matching) — see reliabilityService / workerStatus.
    accountStatus: {
      type: String,
      enum: [
        'ACTIVE',
        'WARNING',
        'LOW_RELIABILITY',
        'TEMPORARILY_SUSPENDED',
        'DEACTIVATION_REVIEW',
      ],
      default: 'ACTIVE',
    },
    // Worker-side cancellation strikes used for automatic merit suspension.
    autoSuspended: {
      type: Boolean,
      default: false,
    },
    // Count of AUTOMATIC (repeated-eligible-cancellation) suspensions. Kept
    // separate from `suspensionCount` (which tracks administrative/complaint
    // suspensions toward termination) so the two systems never conflict.
    // Drives escalating durations: 1st = first, 2nd = second, 3rd+ = repeated.
    autoSuspensionCount: {
      type: Number,
      default: 0,
    },
    cancellationStats: {
      strikes: [
        {
          at: Date,
          booking: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Booking',
          },
          reason: String,
          stage: String,
        },
      ],
      eligibleCancellationCount: {
        type: Number,
        default: 0,
      },
      cancelledCount: {
        type: Number,
        default: 0,
      },
      lastCancelledAt: Date,
    },
    // Welfare status
    insuranceActive: {
      type: Boolean,
      default: false,
    },
    welfareEnrolled: {
      type: Boolean,
      default: false,
    },
    emergencyContact: {
      type: String,
      default: '',
    },
    // ID verification fields
    aadhaarVerified: {
      type: Boolean,
      default: false,
    },
    documents: [
      {
        type: String, // file paths
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    joinedDate: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Geospatial index for nearby worker queries
workerProfileSchema.index({ location: '2dsphere' });
workerProfileSchema.index({ 'skills.skill': 1 });
workerProfileSchema.index({ 'skills.verified': 1 });
workerProfileSchema.index({ verificationStatus: 1 });
workerProfileSchema.index({ accountStatus: 1 });
workerProfileSchema.index({ city: 1 });

module.exports = mongoose.model('Worker', workerProfileSchema);
