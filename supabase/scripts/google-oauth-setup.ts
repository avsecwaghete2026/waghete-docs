// One-time OAuth setup: prints a refresh token you paste into Edge
// Function secrets. Run this once per project (not per user).
//
// Usage:
//   export GOOGLE_OAUTH_CLIENT_ID=...
//   export GOOGLE_OAUTH_CLIENT_SECRET=...
//   npx tsx scripts/google-oauth-setup.ts
//
// What it does:
//   1. Opens the Google consent screen in your browser.
//   2. Spins up a tiny HTTP server on localhost:8089 to catch the
//      redirect with the authorization code.
//   3. Exchanges the code for an access token + refresh token.
//   4. Prints the refresh token (and the access token, for debugging).
//
// After running once, you can revoke this app from
// https://myaccount.google.com/permissions at any time. The refresh
// token stays valid until you do.
//
// Required scope: https://www.googleapis.com/auth/drive.file
//   - Lets the app create/access only files it created.
//   - Does NOT let it read every file in your Drive.

import { createServer } from 'node:http';
import { URL } from 'node:url';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_PORT = 8089;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET');
  process.exit(1);
}

async function main() {
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // force a new refresh token

  console.log('\nOpen this URL in your browser and grant access:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for redirect on http://localhost:' + REDIRECT_PORT + '/callback ...\n');

  const code = await waitForCode();
  console.log('Got auth code, exchanging for tokens...');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    console.error('Token exchange failed:', res.status, await res.text());
    process.exit(1);
  }

  const json = await res.json();
  console.log('Refresh token:');
  console.log(json.refresh_token);
  console.log('\nAccess token (debug only, expires in ~1h):');
  console.log(json.access_token);
  console.log('\nNow run:');
  console.log('  supabase secrets set GOOGLE_OAUTH_CLIENT_ID=' + CLIENT_ID);
  console.log('  supabase secrets set GOOGLE_OAUTH_CLIENT_SECRET=' + CLIENT_SECRET);
  console.log('  supabase secrets set GOOGLE_OAUTH_REFRESH_TOKEN=' + json.refresh_token);
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/callback') {
          res.writeHead(404); res.end(); return;
        }
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h1>OAuth error: ${err}</h1>`);
          server.close();
          reject(new Error(err));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Missing code</h1>');
          server.close();
          reject(new Error('Missing code'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>OK — you can close this tab.</h1><p>Refresh token printed in the terminal.</p>');
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.listen(REDIRECT_PORT, () => {});
  });
}

main().catch((e) => { console.error(e); process.exit(1); });