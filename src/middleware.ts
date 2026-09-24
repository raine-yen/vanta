import { NextRequest, NextResponse } from "next/server";

// Minimal middleware — just passes requests through.
// Auth is enforced in src/app/(app)/layout.tsx via mysqlServer().
// MySQL-backed session cookies are handled by the server components directly.
export function middleware(request: NextRequest) {
  return NextResponse.next({ request });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
