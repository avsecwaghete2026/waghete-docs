// Bootstrap the first admin.
//
// This script:
//   1. Creates a Supabase Auth user with email + password from env.
//   2. Promotes the resulting profile to role='admin'.
//
// Run after the migrations have been applied.
//
// Usage:
//   export SUPABASE_URL=https://<project>.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
//   export SEED_ADMIN_EMAIL=you@example.com
//   export SEED_ADMIN_PASSWORD=<strong password>
//   npx tsx scripts/seed-admin.ts
//
// The service_role key here is fine — this is an admin script, not
// browser code. Do NOT bundle this into the frontend.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.SEED_ADMIN_EMAIL;
const password = process.env.SEED_ADMIN_PASSWORD;

if (!url || !serviceKey || !email || !password) {
  console.error(
    'Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD',
  );
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // Create (or fetch) the auth user. Supabase returns the existing user
  // if the email is already taken.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  let userId: string | undefined = created?.user?.id;

  if (createErr) {
    const msg = createErr.message.toLowerCase();
    const alreadyExists =
      msg.includes('already') || msg.includes('registered') || msg.includes('duplicate');
    if (!alreadyExists) throw createErr;

    const { data: list, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw listErr;
    const found = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!found) throw new Error(`User exists but could not be located: ${createErr.message}`);
    userId = found.id;
    console.log(`User ${email} already exists, promoting existing row.`);
  }

  // Promote to admin. The on_auth_user_created trigger inserted a
  // 'viewer' row; we upsert over it.
  const { error: upsertErr } = await admin
    .from('profiles')
    .upsert({ id: userId, email, role: 'admin' });

  if (upsertErr) throw upsertErr;
  console.log(`Seeded admin: ${email} (id=${userId})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});