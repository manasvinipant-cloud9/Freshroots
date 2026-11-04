"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, BarChart3, ClipboardList, Database, Moon, ShieldAlert, ShieldCheck, Sprout, Sun, Truck } from "lucide-react";
import KillSwitch from "./KillSwitch";
import RunNow from "./RunNow";
import { useActor } from "@/lib/client";
import { cn } from "./ui";
import type { KillState } from "@/lib/killswitch";

const NAV = [
  { href: "/planner", label: "Recommended actions", icon: ClipboardList },
  { href: "/exceptions", label: "Exceptions queue", icon: ShieldAlert },
  { href: "/status", label: "Status and POs", icon: Truck },
  { href: "/runs", label: "Data quality and runs", icon: Database },
  { href: "/impact", label: "Impact", icon: BarChart3 },
];

export default function Shell({ kill, lastRun, schedule, children }: { kill: KillState; lastRun: string | null; schedule: string; children: React.ReactNode }) {
  const path = usePathname();
  const [light, setLight] = useState(false);
  const [actor, setActor] = useActor();
  useEffect(() => setLight(document.documentElement.classList.contains("light")), []);
  const toggle = () => { const n = !light; setLight(n); document.documentElement.classList.toggle("light", n); try { localStorage.setItem("theme", n ? "light" : "dark"); } catch {} };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-sidebar p-3 md:flex">
        <Link href="/" className="mb-4 flex items-center gap-2 px-2 pt-1 text-[15px] font-semibold"><Sprout size={18} className="text-accent" /> Freshroots</Link>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(({ href, label, icon: I }) => {
            const active = path.startsWith(href);
            return <Link key={href} href={href} className={cn("flex h-9 items-center gap-2.5 rounded-lg px-3 text-[13.5px]", active ? "bg-raised font-semibold text-ink" : "text-ink-3 hover:bg-hover hover:text-ink")}><I size={16} />{label}</Link>;
          })}
        </nav>
        <div className="mt-auto space-y-3 px-2 pb-1 text-[12px] text-ink-4">
          <label className="block"><span className="mb-1 block">Your name (audit log)</span>
            <input value={actor} onChange={(e) => setActor(e.target.value)} className="h-8 w-full rounded-lg border border-line-ctl bg-sunken px-2 text-[13px] text-ink" /></label>
          <div className="flex items-center gap-1.5"><Activity size={12} /> Runs {schedule}</div>
          <div>{lastRun ? `Last successful run ${lastRun}` : "No successful run yet"}</div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-line bg-sidebar/95 px-4 py-2 backdrop-blur">
          <nav className="flex gap-1 md:hidden">{NAV.map(({ href, label, icon: I }) => <Link key={href} href={href} aria-label={label} className={cn("rounded-lg p-2", path.startsWith(href) ? "bg-raised text-ink" : "text-ink-3")}><I size={16} /></Link>)}</nav>
          <div className="ml-auto flex items-center gap-2">
            <RunNow killEngaged={kill.engaged} />
            <KillSwitch state={kill} />
            <button onClick={toggle} aria-label="Toggle theme" className="rounded-lg border border-line-ctl p-2 text-ink-3 hover:bg-hover">{light ? <Moon size={15} /> : <Sun size={15} />}</button>
          </div>
        </header>
        <main className="mx-auto max-w-[1500px] p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
export { ShieldCheck };
