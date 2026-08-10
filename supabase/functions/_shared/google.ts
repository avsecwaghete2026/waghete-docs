// Google OAuth helper for Edge Functions.
//
// Uses the OAuth 2.0 refresh-token flow so the Edge Function never has
// to interact with a browser or store a long-lived user token.
//
// Required environment variables (set via `supabase secrets set`):
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REFRESH_TOKEN
//
// Optional:
//   GOOGLE_DRIVE_FOLDER_ID  — uploads land in this folder; defaults to
//                             the authenticated user's Drive root.
//
// Required OAuth scopes:
//   https://www.googleapis.com/auth/drive.file
//
// `drive.file` is the most permissive *non-full-drive* scope: it lets
// the app create files in the user's Drive and access only those files.
// We use this (not `drive`) so a stolen refresh token can't enumerate
// or modify every file in the account.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES_URL  = 'https://www.googleapis.com/drive/v3/files';

interface DriveTokens {
  access_token: string;
  expires_in: number;
  expires_at: number; // ms epoch
}

let cachedTokens: DriveTokens | null = null;

export async function getAccessToken(): Promise<string> {
  if (cachedTokens && cachedTokens.expires_at > Date.now() + 60_000) {
    return cachedTokens.access_token;
  }

  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
  const refreshToken = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google OAuth env vars missing.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  cachedTokens = {
    access_token: json.access_token,
    expires_in: json.expires_in,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  return cachedTokens.access_token;
}

// ----- Drive API helpers --------------------------------------------------

export async function uploadToDrive(
  bytes: Uint8Array,
  metadata: { name: string; mimeType: string },
): Promise<string> {
  const accessToken = await getAccessToken();
  const folderId = Deno.env.get('GOOGLE_DRIVE_FOLDER_ID');

  // Multipart upload: metadata + bytes in one request. Using the simple
  // upload path (not resumable) because our files cap at 25 MB.
  const boundary = '-------docsearch' + crypto.randomUUID();
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify({
      name: metadata.name,
      mimeType: metadata.mimeType,
      ...(folderId ? { parents: [folderId] } : {}),
    }) +
    delimiter +
    `Content-Type: ${metadata.mimeType}\r\n` +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    bytesToB64(bytes) +
    closeDelim;

  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${text}`);
  }
  const json = await res.json();
  return json.id as string;
}

export async function downloadFromDrive(fileId: string): Promise<{
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: string | null;
}> {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new Error(`Drive download failed (${res.status}): ${text}`);
  }
  return {
    body: res.body,
    contentType: res.headers.get('Content-Type') ?? 'application/octet-stream',
    contentLength: res.headers.get('Content-Length'),
  };
}

export async function deleteFromDrive(fileId: string): Promise<void> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 204 = success, 404 = already gone — both are fine for our use case.
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Drive delete failed (${res.status}): ${text}`);
  }
}

export async function renameFileInDrive(fileId: string, newName: string): Promise<void> {
  const accessToken = await getAccessToken();
  const url = `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: newName }),
  });
  if (!res.ok) {
    const text = await res.text();
    const status = res.status;
    throw new Error(`Drive rename failed (${status}): ${text}\nURL: ${url}`);
  }
}

// ----- utils --------------------------------------------------------------

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}