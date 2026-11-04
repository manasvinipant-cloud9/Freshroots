"use client";
import { useEffect, useState } from "react";

const KEY = "freshroots_actor";
export function useActor(): [string, (v: string) => void] {
  const [actor, set] = useState("raghav");
  useEffect(() => { try { const v = localStorage.getItem(KEY); if (v) set(v); } catch {} }, []);
  return [actor, (v) => { set(v); try { localStorage.setItem(KEY, v); } catch {} }];
}
export const getActor = () => { try { return localStorage.getItem(KEY) || "raghav"; } catch { return "raghav"; } };

export async function post<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actor: getActor(), ...(body as object) }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`);
  return data;
}
