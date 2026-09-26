import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { publicEnv } from "@/lib/public-env";
import type { AuthProvider } from "./provider";

async function supabaseServerClient() {
  const { supabaseUrl, supabaseAnonKey } = publicEnv();
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet)
            cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the proxy refreshes the session instead.
        }
      },
    },
  });
}

export const supabaseAuth: AuthProvider = {
  async getUser() {
    const supabase = await supabaseServerClient();
    // getUser() validates the access token with Supabase Auth; getSession() would not.
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  },

  async signInWithPassword(email, password) {
    const supabase = await supabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ? { error: "Invalid email or password." } : {};
  },

  async signUp(email, password) {
    const supabase = await supabaseServerClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message };
    return data.session ? {} : { needsConfirmation: true };
  },

  async signOut() {
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
  },
};
