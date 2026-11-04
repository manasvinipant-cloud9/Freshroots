// Shared-passcode gate. Set APP_PASSCODE to turn it on; when unset the app stays open (local dev).
export const COOKIE = "freshroots_auth";

export async function tokenFor(passcode: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`freshroots:${passcode}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
