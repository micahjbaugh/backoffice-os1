// Browser-safe configuration. Only NEXT_PUBLIC_* values may be read here; anything in this file
// can end up in the client bundle. Secrets live in src/server/env.ts.

export function publicEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  return { supabaseUrl, supabaseAnonKey };
}
