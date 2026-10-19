
'use strict';

const crypto = require('node:crypto');

const PREFIX = 'tosh:redis-lock-test:v1:';
const LOCK_SECONDS = 120;

async function redis(command) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    throw new Error('REDIS_NOT_CONFIGURED');
  }

  const response = await fetch(url.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error('REDIS_HTTP_ERROR');
  }

  const data = await response.json();

  if (data.error) {
    throw new Error('REDIS_COMMAND_ERROR');
  }

  return data.result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Temporary diagnostic endpoint. No public access.
  const origin = req.headers.origin;
  if (origin) {
    return res.status(403).json({
      success: false,
      errorCode: 'BROWSER_ACCESS_NOT_ALLOWED'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      errorCode: 'METHOD_NOT_ALLOWED'
    });
  }

  try {
    // Unique key for this test; does not touch real booking locks.
    const testId = crypto.randomUUID();
    const key = PREFIX + testId;

    // Two concurrent requests compete for the same Redis lock.
    const results = await Promise.all([
      redis(['SET', key, 'attempt-A', 'NX', 'EX', LOCK_SECONDS]),
      redis(['SET', key, 'attempt-B', 'NX', 'EX', LOCK_SECONDS])
    ]);

    const successfulLocks = results.filter(
      result => result === 'OK'
    ).length;

    const storedValue = await redis(['GET', key]);

    // Remove only this temporary test key.
    await redis(['DEL', key]);

    const passed =
      successfulLocks === 1 &&
      (storedValue === 'attempt-A' ||
       storedValue === 'attempt-B');

    return res.status(passed ? 200 : 500).json({
      success: passed,
      test: 'REDIS_ATOMIC_DUPLICATE_PROTECTION',
      results: {
        simultaneousAttempts: 2,
        locksAcquired: successfulLocks,
        duplicateBlocked: successfulLocks === 1,
        storedValueVerified: Boolean(
          storedValue === 'attempt-A' ||
          storedValue === 'attempt-B'
        )
      },
      message: passed
        ? 'PASS: Redis accepted one attempt and blocked the duplicate.'
        : 'FAIL: Redis duplicate protection did not behave as expected.'
    });

  } catch (error) {
    console.error('Redis lock test failed', {
      error: error.message
    });

    return res.status(503).json({
      success: false,
      errorCode: 'REDIS_LOCK_TEST_FAILED',
      message: 'Redis test failed. Check Vercel function logs.'
    });
  }
};
