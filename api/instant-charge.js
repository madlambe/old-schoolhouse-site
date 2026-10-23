
'use strict';
const { getBookingToken } = require('../lib/booking-auth.cjs');
const crypto = require('node:crypto');

const ORIGINS = new Set([
  'https://the-old-schoolhouse.webflow.io',
  'https://www.the-old-schoolhouse.com',
  'https://the-old-schoolhouse.com'
]);
const KEY_PREFIX = 'tosh:instant-charge:v1:';
const LOCK_SECONDS = 60 * 60 * 48;

function cors(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function str(value, limit = 200) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}
function safeStatus(value) { return str(value, 60).toUpperCase(); }
function paymentOutcome(data) {
  const r = data && data.reservation || {};
  const p = data && data.payment || {};
  const reservationId = str(r._id || r.id, 100);
  const confirmationCode = str(r.confirmationCode, 100);
  const reservationStatus = safeStatus(r.status);
  const paymentStatus = safeStatus(p.status);
  const checkInDate = str(r.checkInDateLocalized || r.stay?.[0]?.checkInDateLocalized, 10);
  const checkOutDate = str(r.checkOutDateLocalized || r.stay?.[0]?.checkOutDateLocalized, 10);
  // Guesty's documentation provides these objects, but exact live status
  // combinations still require validation before the live switch is enabled.
  const confirmed = reservationStatus === 'CONFIRMED';
  const paid = ['SUCCEEDED', 'SUCCESS', 'PAID', 'CAPTURED', 'COMPLETED'].includes(paymentStatus);
  return {
    verified: !!(reservationId && confirmationCode && confirmed && paid),
    reservationId, confirmationCode, reservationStatus, paymentStatus, checkInDate, checkOutDate,
    requiresAuthentication: ['PENDING_AUTH', 'REQUIRES_ACTION', 'REQUIRES_AUTHENTICATION'].includes(paymentStatus)
  };
}
async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Redis configuration unavailable');
  const response = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Redis HTTP error');
  const data = await response.json();
  if (data.error) throw new Error('Redis command failed');
  return data.result;
}
function keyFor(quoteId) {
  return KEY_PREFIX + crypto.createHash('sha256').update(quoteId).digest('hex');
}
function referenceId() { return crypto.randomBytes(12).toString('hex'); }

module.exports = async function handler(req, res) {
  cors(req, res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({success:false,errorCode:'METHOD_NOT_ALLOWED'});

  // MUST remain absent/false until real checkout is fully verified.
  if (process.env.ENABLE_LIVE_INSTANT_CHARGE !== 'true') {
    return res.status(503).json({success:false,errorCode:'LIVE_CHECKOUT_DISABLED',message:'Live payments are not enabled.'});
  }
  if (!ORIGINS.has(req.headers.origin)) {
    return res.status(403).json({success:false,errorCode:'ORIGIN_NOT_ALLOWED'});
  }
  const {quoteId,ratePlanId,confirmationToken,guest} = req.body || {};
  const q = str(quoteId,100), plan = str(ratePlanId,100), ct = str(confirmationToken,250);
  const firstName = str(guest?.firstName,100), lastName = str(guest?.lastName,100);
  const email = str(guest?.email,254), phone = str(guest?.phone,50);
  if (!q || !plan || !/^ctoken_[A-Za-z0-9_]+$/.test(ct) || !firstName || !lastName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({success:false,errorCode:'INVALID_BOOKING_REQUEST'});
  }

  // Atomic SET NX prevents two parallel requests using the same quote.
  // Never release a lock automatically on Guesty failure or timeout:
  // payment may have been processed even when our response is unclear.
  const key = keyFor(q), attemptId = referenceId();
  try {
    const acquired = await redis(['SET', key, JSON.stringify({state:'processing',attemptId,at:new Date().toISOString()}), 'NX', 'EX', LOCK_SECONDS]);
    if (acquired !== 'OK') {
      return res.status(409).json({success:false,errorCode:'BOOKING_ATTEMPT_ALREADY_EXISTS',doNotRetry:true,message:'This booking has already been submitted. Please contact us before trying again.'});
    }
  } catch (err) {
    console.error('Payment blocked: Redis unavailable', {attemptId,reason:err.message});
    return res.status(503).json({success:false,errorCode:'PAYMENT_PROTECTION_UNAVAILABLE',doNotRetry:true});
  }

  const record = async (state, details = {}) => {
    try {
      await redis(['SET', key, JSON.stringify({state,attemptId,at:new Date().toISOString(),...details}), 'EX', LOCK_SECONDS]);
    } catch (err) {
      console.error('Payment record update failed', {attemptId,reason:err.message});
    }
  };

  try {
    const token = await getBookingToken();
    const response = await fetch(`https://booking.guesty.com/api/reservations/quotes/${encodeURIComponent(q)}/instant-charge`, {
      method:'POST',
      headers:{'Accept':'application/json','Content-Type':'application/json',Authorization:`Bearer ${token}`},
      body:JSON.stringify({ratePlanId:plan,confirmationToken:ct,reuse:true,guest:{firstName,lastName,email,...(phone?{phone}:{})}}),
      signal:AbortSignal.timeout(45000)
    });
    const requestId = response.headers.get('x-request-id') || response.headers.get('x-guesty-request-id') || null;
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { /* unknown response */ }
    const outcome = paymentOutcome(data);
    // Guesty may report a Stripe 3DS challenge in a payment attempt rather than
    // the top-level payment status. Do not treat it as a completed booking.
    const attempts = Array.isArray(data?.payment?.attempts) ? data.payment.attempts : [];
    const challenge = attempts.find(a => {
      const pi = a?.payload?.payment_intent;
      return pi?.status === 'requires_action' &&
        typeof pi?.client_secret === 'string' &&
        pi.client_secret.startsWith('pi_');
    });
    const needs3DS = Boolean(challenge);

    const metadata = {requestId,httpStatus:response.status,reservationId:outcome.reservationId || null,
      confirmationCode:outcome.confirmationCode || null,reservationStatus:outcome.reservationStatus,
      paymentStatus:outcome.paymentStatus};
    if (!response.ok) {
      await record('needs_reconciliation',metadata);
      console.error('Guesty payment response requires review',{attemptId,...metadata});
      return res.status(502).json({success:false,errorCode:'BOOKING_STATUS_UNKNOWN',doNotRetry:true,requiresVerification:true,attemptId});
    }
    if (needs3DS) {
      await record('3ds_requires_reconciliation', metadata);
      console.error('Guesty requires 3DS; reservation outcome must be reconciled', {attemptId,...metadata});
      // Do not return client_secret yet: a post-authentication Guesty finalisation
      // and status-verification protocol has not been established.
      return res.status(202).json({
        success:false,errorCode:'ADDITIONAL_AUTHENTICATION_REQUIRED',
        doNotRetry:true,requiresVerification:true,attemptId
      });
    }
    if (!outcome.verified) {
      await record('needs_reconciliation',metadata);
      console.error('Guesty payment status requires review',{attemptId,...metadata});
      return res.status(202).json({success:false,errorCode:outcome.requiresAuthentication?'ADDITIONAL_AUTHENTICATION_REQUIRED':'BOOKING_STATUS_UNVERIFIED',doNotRetry:true,requiresVerification:true,attemptId});
    }
    await record('verified',metadata);
    return res.status(200).json({success:true,paymentVerified:true,reservationVerified:true,
      reservationId:outcome.reservationId,confirmationCode:outcome.confirmationCode,checkInDate:outcome.checkInDate,checkOutDate:outcome.checkOutDate,attemptId});
  } catch (err) {
    await record('needs_reconciliation',{errorType:err.name || 'Error'});
    console.error('Guesty payment outcome unknown',{attemptId,reason:err.message});
    return res.status(503).json({success:false,errorCode:'BOOKING_STATUS_UNKNOWN',doNotRetry:true,requiresVerification:true,attemptId});
  }
};
