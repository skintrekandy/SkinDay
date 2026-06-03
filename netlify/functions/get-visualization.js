// Netlify Function (SYNCHRONOUS, fast): /.netlify/functions/get-visualization?jobId=...
// Place in netlify/functions/.
//
// Polled by the browser until the background worker finishes. Reads only the
// small status object each tick; returns the result image once state === 'done'.
//
// Required env: BETA_ACCESS_PASSWORD
// Required package: @netlify/blobs   (npm i @netlify/blobs)

const { getStore } = require('@netlify/blobs');

function checkKey(event) {
  const expected = process.env.BETA_ACCESS_PASSWORD;
  if (!expected) return false;
  const provided = event.headers['x-beta-key'] || event.headers['X-Beta-Key'] || '';
  return provided === expected;
}

const json = (obj) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (!checkKey(event)) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid beta access password', code: 'INVALID_KEY' }) };
  }

  const jobId = (event.queryStringParameters && event.queryStringParameters.jobId) || '';
  if (!jobId) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing jobId' }) };
  }

  try {
    const store = getStore('visualize-jobs');
    const status = await store.get(jobId + ':status', { type: 'json' });

    // No status yet: the start function may not have written it in the split
    // second before the first poll. Treat as pending and keep polling.
    if (!status) return json({ state: 'pending' });

    if (status.state === 'done') {
      const image = await store.get(jobId + ':result', { type: 'text' });
      if (!image) return json({ state: 'pending' }); // result not yet flushed
      return json({ state: 'done', image });
    }
    if (status.state === 'error') {
      return json({ state: 'error', error: status.error || 'Generation failed', code: status.code || 'error' });
    }
    return json({ state: 'pending' });
  } catch (err) {
    console.error('get-visualization failed:', (err && err.message) || err);
    // Don't kill the poll loop on a transient Blobs read error.
    return json({ state: 'pending' });
  }
};
