// Refreshes the Supabase session cookie on each request and sends signed-out visitors to /login.
// This is a convenience gate only: every page and server action re-verifies the user itself.

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/public-env";

const PUBLIC_PATHS = ["/login"];

// Machine-to-machine endpoints. Providers and the scheduler never carry a user session, so a
// redirect to /login would silently drop every webhook and job run. Each route authenticates every
// request itself (provider signature, or the jobs bearer secret) and fails closed.
const MACHINE_PATHS = ["/api/webhooks/", "/api/internal/"];

export async function proxy(request: NextRequest) {
  if (MACHINE_PATHS.some((p) => request.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next({ request });
  }

  const { supabaseUrl, supabaseAnonKey } = publicEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet)
          response.cookies.set(name, value, options);
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
