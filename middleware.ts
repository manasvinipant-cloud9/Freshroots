import { NextResponse, type NextRequest } from "next/server";
import { COOKIE, tokenFor } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return NextResponse.next();
  if ((req.cookies.get(COOKIE)?.value ?? "") === (await tokenFor(passcode))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", req.url));
}

// The cron route authenticates itself with CRON_SECRET, so it bypasses the passcode.
export const config = { matcher: ["/((?!login|api/login|api/cron|_next/static|_next/image|favicon.ico).*)"] };
