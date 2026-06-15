import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  // Fail loud and early rather than producing confusing 401s later.
  throw new Error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env.local and fill them in.",
  );
}

// The anon (publishable) key is safe in the client: every table has RLS, so a
// query only ever returns the logged-in user's rows. The RPCs default
// p_user_id to auth.uid(), so the app never has to pass a user id.
export const supabase = createClient(url, anonKey);
