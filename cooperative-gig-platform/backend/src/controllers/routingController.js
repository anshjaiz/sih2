/**
 * routingController.js
 *
 * Proxies OSRM (Open Source Routing Machine) driving routes through the
 * backend so the frontend never talks to an external routing service
 * directly. Supports:
 *
 *   GET /api/routes?fromLng=..&fromLat=..&toLng=..&toLat=..
 *       Generic route between two validated coordinate pairs (auth required).
 *
 *   GET /api/routes?fromLng=..&fromLat=..&bookingId=..
 *       Secure job route: `to` is resolved SERVER-SIDE from the booking's own
 *       location, and the caller must be the authorised worker of an active,
 *       not-expired booking. Job coordinates are never trusted from the client.
 *
 * Responses contain only what the map needs: distance (m), duration (s) and a
 * GeoJSON LineString geometry.
 */

const Booking = require('../models/Booking');
const Worker = require('../models/WorkerProfile');
const { asyncHandler, ApiError } = require('../middleware/errorMiddleware');
const { resolveScheduleTimes, getNavigationTimes, formatTimeLabel } = require('../utils/scheduleUtils');
const env = require('../config/env');

const NAVIGABLE_STATUSES = ['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'];
const COORD_MAX = 360;
const OSRM_TIMEOUT_MS = 6000;

const toNumber = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isValidLng = (n) => n >= -180 && n <= 180;
const isValidLat = (n) => n >= -90 && n <= 90;

const validateCoord = (lng, lat, label = 'coordinate') => {
  const ll = toNumber(lng);
  const la = toNumber(lat);
  if (ll === null || la === null || !isValidLng(ll) || !isValidLat(la)) {
    throw new ApiError(`Invalid ${label}`, 400);
  }
  return { lng: ll, lat: la, key: `${ll.toFixed(6)},${la.toFixed(6)}` };
};

const askOSRM = async (from, to) => {
  const url = `${env.osrmBaseUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new ApiError('Routing service is temporarily unavailable. Please try again.', 502);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new ApiError('Routing service returned an invalid response. Please try again.', 502);
  }

  if (!res.ok || body.code !== 'Ok' || !body.routes || !body.routes.length) {
    throw new ApiError('No route could be found to this job.', 404);
  }

  const route = body.routes[0];
  const geometry = route.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    throw new ApiError('No route could be found to this job.', 404);
  }

  return {
    distance: Math.round(route.distance || 0),
    duration: Math.round(route.duration || 0),
    geometry: {
      type: 'LineString',
      coordinates: geometry.coordinates.map(([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]),
    },
  };
};

const getRoute = asyncHandler(async (req, res) => {
  const { fromLng, fromLat, toLng, toLat, bookingId } = req.query;

  const from = validateCoord(fromLng, fromLat, 'origin coordinate');

  let to;
  if (bookingId) {
    const worker = await Worker.findOne({ user: req.user._id });
    if (!worker) throw new ApiError('Worker profile not found', 404);

    const booking = await Booking.findById(bookingId);
    if (!booking) throw new ApiError('Booking not found', 404);
    if (!booking.worker || booking.worker.toString() !== worker._id.toString()) {
      throw new ApiError('You are not assigned to this job', 403);
    }
    if (!NAVIGABLE_STATUSES.includes(booking.status)) {
      throw new ApiError('This job is not navigable in its current state', 400);
    }

    const { scheduledEndTime } = resolveScheduleTimes(booking);
    const now = new Date();
    if (!booking.workerCheckInAt && scheduledEndTime && scheduledEndTime.getTime() < now.getTime()) {
      throw new ApiError('This job has expired and is no longer active', 400);
    }

    // Pre-job navigation window: routing/travel requests are only served once
    // the navigation window opens (scheduled start minus the configured buffer).
    const { navigationAvailableTime } = getNavigationTimes(booking, env.preJobNavigationBufferMins);
    if (navigationAvailableTime && now < navigationAvailableTime) {
      throw new ApiError(
        `Navigation is available from ${formatTimeLabel(navigationAvailableTime)}.`,
        400
      );
    }

    const coords = booking.location && Array.isArray(booking.location.coordinates)
      ? booking.location.coordinates
      : null;
    if (!coords || coords.length < 2) {
      throw new ApiError('This job has no location coordinates', 400);
    }
    to = validateCoord(coords[0], coords[1], 'destination coordinate');
  } else {
    to = validateCoord(toLng, toLat, 'destination coordinate');
  }

  const route = await askOSRM(from, to);
  res.json({ success: true, data: route });
});

module.exports = { getRoute };