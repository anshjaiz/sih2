const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getCancellationReasons } = require('../services/cancellation/cancellationService');
const { getSettings } = require('../services/reliability/reliabilityConfig');
const { asyncHandler } = require('../middleware/errorMiddleware');

// Shared, authenticated discovery endpoint for the cancellation UI:
// the authoritative reason lists (with eligibility flags) and the effective
// policy (fees, thresholds, window, suspension duration).
router.get(
  '/reasons',
  protect,
  asyncHandler(async (req, res) => {
    const reasons = getCancellationReasons();
    const settings = await getSettings();
    res.json({
      success: true,
      data: {
        reasons,
        config: settings.cancellation,
      },
    });
  })
);

module.exports = router;