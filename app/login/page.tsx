"use client";
import { useState } from "react";
import { Sprout } from "lucide-react";
import { Btn, field } from "@/components/ui";

export default function Login() {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passcode: pass }) });
    if (r.ok) window.location.href = "/"; else setErr("Wrong passcode");
  }
  return (
    <form onSubmit={submit} className="mx-auto mt-32 w-full max-w-sm rounded-xl border border-line bg-panel p-6 shadow-card">
      <div className="mb-4 flex items-center gap-2 text-[16px] font-semibold"><Sprout size={18} className="text-accent" /> Freshroots</div>
      <input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passcode" className={field} aria-label="Passcode" />
      {err && <p className="mt-2 text-[12.5px] text-bad">{err}</p>}
      <Btn variant="primary" type="submit" className="mt-4 w-full">Enter</Btn>
    </form>
  );
}
