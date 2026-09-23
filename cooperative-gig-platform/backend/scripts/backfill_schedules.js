/**
 * backfill_schedules.js
 *
 * One-time (idempotent) migration: populate the absolute scheduling fields
 * (scheduledDate / scheduledStartTime / scheduledEndTime) for bookings created
 * before the scheduling/reliability phase. Without these, the reliability
 * scheduler cannot enforce job expiry / no-show detection for older bookings.
 *
 * Values are derived from requestedDate + timeSlot (or the emergency window),
 * using the same deriveScheduleWindow() the create flow uses. Already-scheduled
 * bookings are untouched.
 *
 * Usage:
 *   node scripts/backfill_schedules.js                 # fill only missing windows
 *   node scripts/backfill_schedules.js --force         # re-derive ALL non-emergency
 *                                                     # bookings in the app timezone
 *                                                     # (fixes windows stored under a
 *                                                     # wrong host timezone, e.g. UTC)
 */

const mongoose = require('mongoose');
require('../src/models/Booking');
const Booking = require('../src/models/Booking');
const { deriveScheduleWindow } = require('../src/utils/scheduleUtils');

const FORCE = process.argv.includes('--force');

(async () => {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cooperative_gig_platform';
  await mongoose.connect(uri);

  const query = FORCE
    ? { isEmergency: { $ne: true }, timeSlot: { $ne: null }, requestedDate: { $ne: null } }
    : {
        $or: [
          { scheduledStartTime: null, scheduledEndTime: null },
          { scheduledStartTime: { $exists: false }, scheduledEndTime: { $exists: false } },
        ],
        requestedDate: { $ne: null },
      };

  const candidates = await Booking.find(query).select(
    '_id bookingNumber requestedDate timeSlot isEmergency scheduledStartTime scheduledEndTime scheduledDate'
  );

  console.log(`${FORCE ? 'Rechecking' : 'Bookings missing a schedule'}: ${candidates.length}`);
  let filled = 0;
  let skipped = 0;
  let fixed = 0;

  for (const b of candidates) {
    const schedule = deriveScheduleWindow(b.requestedDate, b.timeSlot, {
      isEmergency: !!b.isEmergency,
    });
    if (!schedule.scheduledStartTime || !schedule.scheduledEndTime) {
      skipped++;
      continue;
    }

    const storedStart = b.scheduledStartTime ? b.scheduledStartTime.getTime() : null;
    const storedEnd = b.scheduledEndTime ? b.scheduledEndTime.getTime() : null;
    const derivedStart = schedule.scheduledStartTime.getTime();
    const derivedEnd = schedule.scheduledEndTime.getTime();

    if (!FORCE && storedStart !== null) continue; // legacy missing-only mode
    if (FORCE && storedStart === derivedStart && storedEnd === derivedEnd) {
      skipped++; // already correct
      continue;
    }

    await Booking.updateOne(
      { _id: b._id },
      {
        $set: {
          scheduledDate: schedule.scheduledDate,
          scheduledStartTime: schedule.scheduledStartTime,
          scheduledEndTime: schedule.scheduledEndTime,
        },
      }
    );
    if (storedStart === null) filled++;
    else fixed++;
  }

  const summary = [];
  if (filled) summary.push(`${filled} filled`);
  if (fixed) summary.push(`${fixed} corrected`);
  if (skipped) summary.push(`${skipped} skipped`);
  console.log(`✓ Done${summary.length ? ': ' + summary.join(', ') : ''}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.stack); process.exit(1); });