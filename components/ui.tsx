"use client";
import { useEffect } from "react";
import { X } from "lucide-react";

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

const TONES = {
  neutral: "bg-chip text-ink-2", good: "bg-good-bg text-good", warn: "bg-warn-bg text-warn border border-warn-line/40", bad: "bg-bad-bg text-bad", info: "bg-raised text-accent",
};
export type Tone = keyof typeof TONES;
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  return <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium", TONES[tone])}>{children}</span>;
}

export function Btn({ variant = "ghost", className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const v = { primary: "bg-btn text-btn-text font-semibold hover:opacity-90", ghost: "border border-line-ctl bg-panel text-ink-2 hover:bg-hover", danger: "border border-bad/50 text-bad hover:bg-bad-bg" }[variant];
  return <button {...p} className={cn("inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors", v, className)} />;
}

export function Card({ title, children, className, right }: { title?: React.ReactNode; children: React.ReactNode; className?: string; right?: React.ReactNode }) {
  return (
    <section className={cn("rounded-xl border border-line bg-panel shadow-card", className)}>
      {title && <header className="flex items-center justify-between border-b border-line-soft px-4 py-2.5"><h2 className="text-[13px] font-semibold text-ink-2">{title}</h2>{right}</header>}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-md rounded-xl border border-line bg-panel p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-[15px] font-semibold">{title}</h3><button onClick={onClose} aria-label="Close" className="text-ink-3 hover:text-ink"><X size={16} /></button></div>
        {children}
      </div>
    </div>
  );
}

export const field = "h-9 w-full rounded-lg border border-line-ctl bg-sunken px-3 text-[13px] text-ink placeholder:text-ink-4";
export const Label = ({ children }: { children: React.ReactNode }) => <label className="mb-1 mt-3 block text-[12px] text-ink-3">{children}</label>;

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4 shadow-card">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="tnum mt-1 text-[24px] font-semibold leading-tight">{value}</div>
      {sub && <div className="mt-1 text-[12px] text-ink-4">{sub}</div>}
    </div>
  );
}

export function Spark({ values, w = 120, h = 28 }: { values: (number | null)[]; w?: number; h?: number }) {
  const v = values.map((x) => x ?? 0);
  const max = Math.max(1, ...v);
  const pts = v.map((y, i) => `${(i / Math.max(1, v.length - 1)) * w},${h - (y / max) * (h - 3) - 1.5}`).join(" ");
  return <svg width={w} height={h} aria-hidden><polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" /></svg>;
}
