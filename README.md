# Document Search
 
Internal company document search. Static frontend on **Cloudflare Pages**,
data + auth + files on **Supabase** (Postgres, Auth, Storage). No custom
backend, no Workers, no D1, no R2 — the browser talks directly to Supabase.

## Layout

```
docsearch-app/
├── frontend/                Static site deployed to Cloudflare Pages
│   ├── login.html           Sign-in page
│   ├── reset-password.html  Forgot-password (code → new password → login)
│   ├── index.html           App shell (Library sidebar + Admin tab)
│   ├── css/styles.css
│   ├── js/
│   │   ├── config.js                  Reads window.__SUPABASE_URL__ etc.
│   │   ├── supabaseClient.js          Single SDK client + constants
│   │   ├── auth.js                    signIn / signOut / role lookup
│   │   ├── api.js                     documents / categories / users / Edge Fn
│   │   ├── search.js                  Live search (debounce, AbortController)
│   │   ├── admin.js                   Upload / edit / categories / users
│   │   ├── detail.js                  Document detail modal + preview
│   │   ├── reset-password.js          Forgot-password flow
│   │   ├── app.js                     Shell + sidebar toggle + bootstrap
│   │   └── login.js                   Sign-in form
│   └── build-config.js                Substitutes env vars into a runtime config
└── supabase/
    ├── migrations/
    │   ├── 0001_schema.sql            profiles, categories, documents
    │   ├── 0002_trigger.sql           auto-create profile on auth.users insert
    │   ├── 0003_rls.sql               row-level security policies
    │   ├── 0004_indexes_fts.sql       indexes + tsvector full-text search
    │   ├── 0005_storage.sql           Storage RLS for the documents bucket
    │   ├── 0006_drive.sql             swap Storage for Google Drive
    │   ├── 0007_soft_delete.sql       deleted_at on documents
    │   └── 0008_updated_at.sql        updated_at + trigger for documents
    ├── functions/
    │   ├── create-user/    Edge Function for admin user creation
    │   └── delete-user/    Edge Function for admin user removal
    └── scripts/seed-admin.ts          Bootstrap the first admin
```

## Setup

### 1. Create the Supabase project

1. Sign up at <https://supabase.com/> (free tier is fine).
2. New project → choose a region close to your team.
3. **Settings → API** — note `Project URL` and `anon` key (used by the
   frontend) and `service_role` key (used by the Edge Function and the
   seed script; **never** put this in frontend code).

### 2. Apply migrations

From the repo root:

```sh
# Link your project (one-time)
supabase login
supabase link --project-ref <your-project-ref>

# Apply schema, trigger, RLS, indexes, storage policies
supabase db push
```

Or paste each migration file into the SQL editor in the Supabase
dashboard, in numeric order.

### 3. Create the Storage bucket

Dashboard → Storage → **New bucket**:

- Name: `documents`
- Public: **off** (private)

The policies in `0005_storage.sql` apply automatically once the bucket
exists; the file also documents an INSERT you can run to create the
bucket via SQL if you prefer.

### 4. Deploy the Edge Function

```sh
supabase functions deploy create-user --no-verify-jwt
```

The function reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY` from the Edge Function runtime — the
service_role key is auto-injected by Supabase when you deploy, so you
don't need to set it yourself.

### 5. Seed the bootstrap admin

```sh
export SUPABASE_URL=https://<your-project>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
export SEED_ADMIN_EMAIL=you@example.com
export SEED_ADMIN_PASSWORD=<a strong one>

cd supabase
npx tsx scripts/seed-admin.ts
```

This creates the auth user (or promotes an existing one) and sets their
profile role to `admin`.

### 6. Deploy the frontend to Cloudflare Pages

1. Push this repo to GitHub.
2. Pages → **Create application** → **Pages** → **Connect to Git**.
3. Build command: `cd frontend && node build-config.js` (or leave blank
   if you prefer to hardcode the keys — see below).
4. Build output: `frontend`.
5. **Environment variables** (Production + Preview):
   - `SUPABASE_URL` — your project URL
   - `SUPABASE_ANON_KEY` — the anon key

The build step writes `frontend/js/config.runtime.js`, which sets
`window.__SUPABASE_URL__` / `window.__SUPABASE_ANON_KEY__` before the
app scripts load.

> **No build step?** Hardcode the values in `frontend/config.template.html`
> and inline it into both HTML pages instead. Either way, only the
> **anon** key ships to the browser.

### 7. Wire auth redirects

Dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://<your-pages-domain>` (e.g. `https://waghete-docs.pages.dev`)
- **Redirect URLs**: add the same domain (and `http://localhost:8080` if
  you serve locally for testing).

This stops the dreaded "redirect URL not allowed" error after sign-in
AND makes sure the password-recovery email links point at the deployed
app instead of `localhost:3000`. If your Site URL is left as a local
address, the magic link in the recovery email will fail to land on a
working page.

### 8. Connect Resend for transactional email (recommended)

Supabase's built-in email sender has low rate limits (2–4 emails/hour)
and often lands in spam. Resend gives you 3,000 free emails/month with
proper deliverability. Here's how to wire it up.

#### In the Supabase dashboard

1. Go to **Authentication → Providers → Email**.
2. Enable **Custom SMTP**.
3. Fill in the fields:
   - **SMTP Host**: `smtp.resend.com`
   - **SMTP Port**: `465`
   - **SMTP User**: your Resend API key (format: `re_xxxx`)
   - **SMTP Password**: your Resend API key (same value)
   - **Sender Email**: your verified sending domain (e.g. `noreply@yourdomain.com`)
   - **Sender Name**: `Waghete Docs` (or your preferred name)
4. Save.

#### In Resend

1. Create an account at [resend.com](https://resend.com).
2. Add and verify a domain (Resend → **Domains** → Add). You need access
   to the domain's DNS to add the TXT/MX/SPF records. Without domain
   verification, Resend only lets you send to the account owner's email.
3. Once verified, go to **API Keys** and create a key with "Sending"
   permissions. Copy it.
4. Paste the API key into the Supabase SMTP fields above.

That's it — Supabase now sends all auth emails (sign-in confirmations,
password recovery, email change confirmations) through Resend. The rate
limit jumps to 3,000 emails/month and delivery rates are much better
than the default.

## Local dev

Serve the `frontend/` folder with any static server:

```sh
cd frontend
npx http-server -p 8080
# open http://localhost:8080
```

Set the Site URL above to include `http://localhost:8080` so the auth
flow works locally.

## Roles

Two roles, stored in `profiles.role`:

- **admin** — can upload, edit, delete, and create users. (Sees the
  Admin tab.)
- **viewer** — search / view / download only.

A user can never escalate themselves: the only path to `admin` is the
`create-user` Edge Function or the `seed-admin` script, both of which
hold the service_role key server-side.

## Security model

- **Frontend UI** hides admin buttons from viewers — that's UX, not
  security.
- **RLS policies** (in `0003_rls.sql` and `0005_storage.sql`) are the
  real boundary. A viewer with the SDK can still call `insert()` on
  `documents` and the database will reject it.
- **Storage** bucket is private. The browser fetches a **signed URL**
  (5-minute TTL) after Supabase Auth confirms the user is signed in.
- **service_role key** is never present in any frontend file or build
  output. It lives only in Edge Function secrets and the seed script's
  env.

## Search behaviour

- Text input + tag input are debounced **250 ms** after the last
  keystroke.
- Category + date range + sort fire immediately on change.
- Each query uses an `AbortController` — a newer keystroke supersedes
  any in-flight request, so the UI never flashes stale results.
- A "Searching…" indicator appears only if a request takes **>200 ms**.
- Tag filter is **AND-match** — a doc must contain every entered tag.
- Sort options: date modified (newest/oldest), date uploaded, name
  (A→Z / Z→A), file type, file size (largest/smallest). Default is
  date modified newest first.
- Results are capped at 100 (300 when a text query is active).

## Out of scope (easy to add later)

- Email verification (currently bypassed with `email_confirm: true` in
  the seed script and Edge Function).
- Audit log of downloads.
- Per-document ACLs.

## Useful commands

```sh
# Apply a single migration file directly (no CLI)
# → paste into Supabase dashboard SQL editor

# Reset the database (local only — wipes profiles + docs)
supabase db reset

# Tail function logs
supabase functions logs create-user
supabase functions logs drive-upload
supabase functions logs drive-download
supabase functions logs drive-delete
```

---

## File storage: Google Drive

Files live in **Google Drive** (15 GB free, no credit card) instead of
Supabase Storage (1 GB free). Your browser never talks to Drive
directly — every file fetch goes through a Supabase Edge Function that
holds an OAuth refresh token server-side. Files stay private to your
Drive account; no public links are ever created.

### One-time setup (~20 minutes)

#### 1. Google Cloud project + OAuth client

1. Go to <https://console.cloud.google.com/> and create a project (free,
   no card).
2. **APIs & Services → Library** → search "Google Drive API" →
   **Enable**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
   - Application type: **Desktop app** (or **Web application** with
     `http://localhost:8089/callback` as an authorized redirect URI).
   - Note the **Client ID** and **Client Secret**.

> Desktop-app clients work cleanly with the local OAuth script below.
> If you choose Web app, add the redirect URI shown in the script
> output.

#### 2. Generate a refresh token

```sh
export GOOGLE_OAUTH_CLIENT_ID=<your-client-id>
export GOOGLE_OAUTH_CLIENT_SECRET=<your-client-secret>

cd supabase
npx tsx scripts/google-oauth-setup.ts
```

The script opens the Google consent screen in your browser, catches the
redirect on `http://localhost:8089/callback`, and prints the refresh
token. Copy it.

#### 3. Optional: pin uploads to a specific Drive folder

1. In Google Drive, create a folder (e.g. "Doc Search uploads").
2. Right-click → **Share** → copy the folder ID from the URL.
3. You'll pass this as `GOOGLE_DRIVE_FOLDER_ID` below. If you skip
   this step, uploads go to your Drive root.

#### 4. Push the secrets to Supabase

```sh
supabase secrets set GOOGLE_OAUTH_CLIENT_ID=<client-id>
supabase secrets set GOOGLE_OAUTH_CLIENT_SECRET=<client-secret>
supabase secrets set GOOGLE_OAUTH_REFRESH_TOKEN=<refresh-token>
supabase secrets set GOOGLE_DRIVE_FOLDER_ID=<folder-id-or-empty>
```

> `GOOGLE_OAUTH_REFRESH_TOKEN` is the long-lived credential that lets
> the Edge Functions act on your behalf. **Anyone with this token can
> upload files to your Drive** until you revoke it from
> <https://myaccount.google.com/permissions>.

#### 5. Deploy the Edge Functions

```sh
supabase functions deploy drive-upload  --no-verify-jwt
supabase functions deploy drive-download --no-verify-jwt
supabase functions deploy drive-delete  --no-verify-jwt
```

#### 6. Apply the migration

Run `supabase/migrations/0006_drive.sql` in the SQL editor. It drops
the now-unused `storage_path` column and adds `drive_file_id`.

### What changed in the code

- `api.js` — uploads/downloads/deletes now call Edge Functions, not
  `supabase.storage`. The browser gets the file bytes as a blob from
  the Edge Function.
- `detail.js` — previews fetch through the Edge Function and render
  with PDF.js (PDFs) or `<img>` (images). Word/Excel files show a
  "Download to view" card.
- Migration `0006_drive.sql` — schema change.

### Quotas & limits

| | |
|---|---|
| Storage | 15 GB (your personal Drive) |
| Max upload | 25 MB (server-side cap) |
| API rate limit | ~12,000 req/min/user — plenty for an internal tool |
| Files per Drive folder | No documented limit |#   w a g h e t e - d o c s 
 
 #   w a g h e t e - d o c s 
 
 
