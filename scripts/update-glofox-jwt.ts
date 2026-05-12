// Update the GLOFOX_DASHBOARD_JWT Supabase secret with a fresh token from
// the dashboard. Run this once per day (or whenever you grab a fresh JWT
// from Chrome DevTools) so the groupon-rotate-cron can keep working.
//
// Usage:
//   # Option 1: paste the JWT as a CLI arg
//   deno run --allow-net --allow-env --allow-run \
//     scripts/update-glofox-jwt.ts "eyJhbGc...your-token..."
//
//   # Option 2: paste it via env var
//   export GLOFOX_DASHBOARD_JWT="eyJhbGc..."
//   deno run --allow-net --allow-env --allow-run scripts/update-glofox-jwt.ts
//
// What it does:
//   1. Validates the JWT (decodes, checks `exp` claim — refuses if expired)
//   2. Fetches the Supabase access token from macOS keychain
//   3. Sets the secret via Supabase Management API
//   4. Reports the new expiry so you know when to refresh again

const PROJECT_REF = "pygbvcqjpwfodmoqkhos";

// --- 1. Read JWT from arg or env ---

const jwt = (Deno.args[0] ?? Deno.env.get("GLOFOX_DASHBOARD_JWT") ?? "").trim();
if (!jwt) {
  console.error(
    "error: pass JWT as arg or set GLOFOX_DASHBOARD_JWT env var",
  );
  Deno.exit(1);
}

// --- 2. Decode JWT to validate ---

function decodeJwt(jwt: string): { exp: number | null; iat: number | null } {
  try {
    const [, payload] = jwt.split(".");
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return {
      exp: typeof json.exp === "number" ? json.exp : null,
      iat: typeof json.iat === "number" ? json.iat : null,
    };
  } catch {
    return { exp: null, iat: null };
  }
}
const { exp, iat } = decodeJwt(jwt);
if (!exp) {
  console.error("error: JWT does not contain a valid `exp` claim");
  Deno.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const secsLeft = exp - now;
if (secsLeft <= 0) {
  console.error(`error: JWT already expired ${Math.floor(-secsLeft / 60)} min ago`);
  Deno.exit(1);
}
const issued = iat ? new Date(iat * 1000).toISOString() : "?";
const expires = new Date(exp * 1000).toISOString();
console.error(
  `JWT looks valid:\n` +
    `  issued:  ${issued}\n` +
    `  expires: ${expires} (${Math.floor(secsLeft / 3600)}h ${Math.floor((secsLeft % 3600) / 60)}m from now)`,
);

// --- 3. Fetch Supabase PAT from keychain ---

const patProc = new Deno.Command("security", {
  args: ["find-generic-password", "-s", "Servous Supabase PAT", "-w"],
  stdout: "piped",
  stderr: "piped",
});
const patOut = await patProc.output();
const supabasePat = new TextDecoder().decode(patOut.stdout).trim();
if (!supabasePat) {
  console.error(
    "error: could not read Supabase PAT from keychain 'Servous Supabase PAT'.\n" +
      "Verify with: security find-generic-password -s 'Servous Supabase PAT' -w",
  );
  Deno.exit(1);
}

// --- 4. Set the secret ---

console.error(`Updating GLOFOX_DASHBOARD_JWT in Supabase project ${PROJECT_REF}…`);
const res = await fetch(
  `https://api.supabase.com/v1/projects/${PROJECT_REF}/secrets`,
  {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${supabasePat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ name: "GLOFOX_DASHBOARD_JWT", value: jwt }]),
  },
);
if (!res.ok && res.status !== 201) {
  console.error(`error: ${res.status} ${await res.text()}`);
  Deno.exit(1);
}

console.log(`✓ GLOFOX_DASHBOARD_JWT updated. Cron will pick it up on next run.`);
console.log(`  Refresh by this time: ${expires}`);
