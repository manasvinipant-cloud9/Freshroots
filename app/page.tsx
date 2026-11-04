import Link from "next/link";
import { ArrowRight, ClipboardCheck, FileClock, Gauge, ShieldCheck, Sprout, Sparkles, TriangleAlert } from "lucide-react";

export const metadata = { title: "Freshroots: rules-first demand planning" };

const SKUS = ["Mango Drink", "Oats Cookies", "Brown Rice", "Almond Milk", "Peanut Butter", "Multigrain Bread", "Quinoa", "Coconut Water"];
const eyebrow = "font-mono text-[11.5px] uppercase tracking-[0.18em] text-fr-ink3";
const h2 = "font-display text-[clamp(30px,4vw,46px)] font-extrabold leading-[1.05] tracking-tight text-fr-forest";
const accentWord = "font-serif italic font-semibold text-fr-terra";

export default function Landing() {
  return (
    <div className="min-h-screen bg-fr-bone font-sans text-fr-ink">
      {/* ---------- header ---------- */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-fr-line/70 bg-fr-bone/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between px-5 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[19px] font-extrabold tracking-tight text-fr-forest">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-fr-forest text-fr-bone"><Sprout size={19} /></span><span>Fresh<span className="text-fr-terra">Roots</span></span>
          </Link>
          <nav className="hidden items-center gap-8 text-[14.5px] text-fr-ink2 md:flex">
            {[["Philosophy", "#philosophy"], ["How it works", "#how"], ["Platform", "#platform"], ["Raghav", "#raghav"]].map(([l, h]) => <a key={h} href={h} className="hover:text-fr-forest">{l}</a>)}
          </nav>
          <div className="flex items-center gap-4">
            <span className="hidden font-mono text-[11px] uppercase tracking-widest text-fr-ink3 lg:block">Runs Mon + Thu 07:00 IST</span>
            <Link href="/planner" className="inline-flex h-10 items-center gap-2 rounded-full bg-fr-forest px-5 text-[14px] font-semibold text-fr-bone hover:bg-fr-deep">Enter Planner App <ArrowRight size={15} /></Link>
          </div>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="relative overflow-hidden pb-16 pt-[120px] lg:pb-24 lg:pt-[140px]">
        <div className="mx-auto grid max-w-[1240px] items-center gap-12 px-5 lg:grid-cols-[1.05fr_1fr] lg:px-8">
          <div className="fr-rise">
            <span className="inline-flex items-center gap-2.5 rounded-full border border-fr-line bg-white px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.2em] text-fr-ink2"><span className="h-2 w-2 rounded-full bg-fr-sage" /> Rules-first demand planning · AI at the edges</span>
            <h1 className="mt-6 font-display text-[clamp(44px,6.4vw,66px)] font-black leading-[1.02] tracking-tight text-fr-forest">Demand planning that honors <span className={accentWord}>reality.</span></h1>
            <p className="mt-6 max-w-[560px] text-[18px] leading-relaxed text-fr-ink2">Deterministic rules decide every reorder. Gemini forecasts and explains around them, but never changes a number. And Raghav approves every recommendation before anything becomes a purchase order draft.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/planner" className="inline-flex h-14 items-center gap-3 rounded-full bg-fr-forest pl-8 pr-3 text-[16px] font-semibold text-fr-bone shadow-lg shadow-fr-forest/20 hover:bg-fr-deep">Enter Live Planning App <span className="grid h-9 w-9 place-items-center rounded-full bg-fr-sage/90 text-fr-deep"><ArrowRight size={17} /></span></Link>
              <a href="#philosophy" className="inline-flex h-14 items-center rounded-full border border-fr-line bg-white px-7 text-[16px] font-semibold text-fr-forest hover:bg-fr-bone2">Explore the rules engine</a>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[520px]">
            <div className="relative aspect-[4/5] overflow-hidden rounded-[2.2rem] rounded-tr-[8rem] shadow-2xl shadow-fr-forest/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="https://images.unsplash.com/photo-1590779033100-9f60a05a013d?auto=format&fit=crop&w=1100&q=80" alt="Fresh produce from partner farms" className="h-full w-full object-cover" />
            </div>
            <div className="absolute -right-3 -top-4 h-28 w-28 sm:-right-8">
              <svg viewBox="0 0 120 120" className="fr-spin absolute inset-0 h-full w-full"><defs><path id="circ" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0" /></defs><circle cx="60" cy="60" r="60" fill="#d96b43" /><text fill="#faf8f5" fontSize="10.5" fontFamily="ui-monospace, monospace" letterSpacing="2.4"><textPath href="#circ">APPROVED · RAGHAV · APPROVED · RAGHAV ·</textPath></text></svg>
              <span className="absolute inset-0 grid place-items-center text-fr-bone"><ShieldCheck size={26} /></span>
            </div>
            <div className="absolute -left-4 top-14 flex items-center gap-3 rounded-2xl border border-fr-line bg-white/95 px-4 py-3 shadow-xl backdrop-blur sm:-left-10">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-fr-sagesoft text-fr-moss"><ShieldCheck size={18} /></span>
              <div><div className="text-[13.5px] font-bold text-fr-forest">0 POs without approval</div><div className="font-mono text-[10px] uppercase tracking-widest text-fr-ink3">Human gate · always</div></div>
            </div>
            <div className="absolute -bottom-6 left-3 right-3 rounded-2xl border border-fr-line bg-white p-5 shadow-xl sm:left-6 sm:right-auto sm:w-[340px]">
              <div className="flex items-center justify-between font-mono text-[10.5px] uppercase tracking-widest text-fr-ink3"><span>Festival month · rule outcome</span><Gauge size={14} /></div>
              <div className="mt-2 font-display text-[22px] font-extrabold text-fr-forest">Mango Drink 200ml</div>
              <div className="mt-1 font-mono text-[11.5px] uppercase tracking-wider text-fr-ink2">3.35 wks cover · +21.4% vs baseline</div>
              <div className="mt-3 flex items-center justify-between">
                <span className="rounded-md bg-fr-terra/10 px-2 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-fr-terradeep">Reorder now · 750 units</span>
                <span className="rounded-full bg-fr-sagesoft px-3 py-1 text-[12px] font-bold text-fr-moss">P1</span>
              </div>
              <div className="mt-3 border-t border-fr-line pt-2 text-[12px] text-fr-ink3">1.5 × standard 500 · awaiting Raghav&apos;s approval</div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- marquee ---------- */}
      <section className="overflow-hidden border-y border-fr-line bg-fr-bone2 py-7" aria-label="Example SKUs">
        <div className="fr-marquee-track flex gap-12 font-display text-[22px] font-bold text-fr-forest/80">
          {[...SKUS, ...SKUS, ...SKUS, ...SKUS].map((s, i) => <span key={i} className="flex items-center gap-12 whitespace-nowrap">{s}<span className="text-fr-terra">✦</span></span>)}
        </div>
      </section>

      {/* ---------- philosophy ---------- */}
      <section id="philosophy" className="py-20 lg:py-28">
        <div className="mx-auto max-w-[1240px] px-5 lg:px-8">
          <div className={eyebrow}>The philosophy</div>
          <h2 className={`${h2} mt-3 max-w-3xl`}>Three pillars of <span className={accentWord}>uncompromised</span> planning</h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              ["Pillar 01", "Rules-first core", "Raghav's documented logic runs as deterministic code: 4 and 12 week demand, stockout and overstock cover limits, perishable windows, a festival uplift and a quantity cap. The rules always outrank the model, and boundaries are exact: cover of exactly 6.0 weeks is not a stockout."],
              ["Pillar 02", "AI at the edges", "Gemini writes a 4 week forecast and a two sentence explanation for each flagged SKU, and says what looks unusual in an exception. It never changes a flag, action or quantity, and if it differs from the statistical baseline by more than 40% the row says so."],
              ["Pillar 03", "Raghav approves every action", "Approve, reject or edit each recommendation. Rejections and edits need a reason code. Nothing becomes a purchase order draft without an explicit approval, and one kill switch halts runs and PO creation."],
            ].map(([k, t, d], i) => (
              <article key={k} className={`rounded-3xl border border-fr-line p-7 ${i === 1 ? "bg-fr-forest text-fr-bone" : "bg-white"}`}>
                <div className={`font-mono text-[11px] uppercase tracking-[0.2em] ${i === 1 ? "text-fr-sage" : "text-fr-terra"}`}>{k}</div>
                <h3 className={`mt-4 font-display text-[25px] font-extrabold leading-tight ${i === 1 ? "text-fr-bone" : "text-fr-forest"}`}>{t}</h3>
                <p className={`mt-3 text-[15px] leading-relaxed ${i === 1 ? "text-fr-bone/80" : "text-fr-ink2"}`}>{d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="how" className="border-y border-fr-line bg-fr-bone2 py-20 lg:py-28">
        <div className="mx-auto max-w-[1240px] px-5 lg:px-8">
          <div className={eyebrow}>How it works</div>
          <h2 className={`${h2} mt-3 max-w-3xl`}>From SAP export to an <span className={accentWord}>approved</span> order draft</h2>
          <ol className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            {[
              ["01", "SAP exports in", "Sales, inventory, SKU and calendar files are mapped by column. A missing column fails the run loudly instead of guessing."],
              ["02", "Cleanup and quality gates", "Hard stops end the run as FAILED with no recommendations. Soft fixes and every fallback are logged in a data-quality report."],
              ["03", "Rules decide", "Weeks of cover, recent versus baseline demand, the decision table, capped quantities, exceptions and a ranked queue, twice a week."],
              ["04", "Gemini explains, Raghav approves", "Approved reorders become a Zoho-ready draft. Every run, decision and edit lands in the audit log."],
            ].map(([n, t, d]) => (
              <li key={n} className="rounded-3xl border border-fr-line bg-white p-6">
                <div className="font-display text-[34px] font-black text-fr-terra/90">{n}</div>
                <h3 className="mt-2 font-display text-[19px] font-extrabold text-fr-forest">{t}</h3>
                <p className="mt-2 text-[14.5px] leading-relaxed text-fr-ink2">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- platform ---------- */}
      <section id="platform" className="py-20 lg:py-28">
        <div className="mx-auto max-w-[1240px] px-5 lg:px-8">
          <div className={eyebrow}>The platform</div>
          <h2 className={`${h2} mt-3 max-w-3xl`}>Built for the <span className={accentWord}>exceptions</span> as much as the rules</h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-6">
            <article className="rounded-3xl border border-fr-line bg-white p-7 lg:col-span-4">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fr-terra"><Gauge size={14} /> Exact rule boundaries</div>
              <h3 className="mt-3 font-display text-[26px] font-extrabold text-fr-forest">Stock cover, with perishables held to a tighter window</h3>
              <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-fr-ink2">Standard SKUs reorder under 6 weeks of cover and pause above 14. Perishables use 3 and 4. A festival month lifts demand 25% before cover is measured, which is why Oats Cookies show 11.5 weeks of cover in October instead of 14.3.</p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {[["Almond Milk", "1.80 wks", "Reorder now · 150", "bg-fr-terra/10 text-fr-terradeep"], ["Coconut Water", "4.08 wks", "Pause · over 4 wk cap", "bg-fr-ochre/20 text-fr-ink2"], ["Mango Drink", "+21.4%", "High demand · 750", "bg-fr-sagesoft text-fr-moss"]].map(([n, v, t, c]) => (
                  <div key={n} className="rounded-2xl border border-fr-line bg-fr-bone p-4"><div className="text-[13px] font-semibold text-fr-ink">{n}</div><div className="mt-1 font-mono text-[18px] font-semibold text-fr-forest">{v}</div><span className={`mt-2 inline-block rounded-md px-2 py-1 font-mono text-[10.5px] uppercase tracking-wider ${c}`}>{t}</span></div>
                ))}
              </div>
            </article>
            <article className="rounded-3xl border border-fr-line bg-fr-forest p-7 text-fr-bone lg:col-span-2">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fr-sage"><ClipboardCheck size={14} /> One approval queue</div>
              <h3 className="mt-3 font-display text-[23px] font-extrabold">Ranked, explained, decided</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-fr-bone/80">P1 stockouts first, perishables ahead of the rest. Approve, reject or edit the quantity, with a reason code on every override so the next phase can learn from them.</p>
            </article>
            <article className="rounded-3xl border border-fr-line bg-white p-7 lg:col-span-2">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fr-terra"><TriangleAlert size={14} /> Exceptions, not guesses</div>
              <h3 className="mt-3 font-display text-[22px] font-extrabold text-fr-forest">Judgment calls get their own queue</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-fr-ink2">New SKUs, dead stock, sudden spikes, rule conflicts and unusual distributors are sent to Raghav with what looks unusual and what to check.</p>
            </article>
            <article className="rounded-3xl border border-fr-line bg-white p-7 lg:col-span-2">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fr-terra"><Sparkles size={14} /> Gemini, on a leash</div>
              <h3 className="mt-3 font-display text-[22px] font-extrabold text-fr-forest">Notes, never numbers</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-fr-ink2">Facts go in, validated JSON comes out. If Gemini fails, the run still completes rules-only and the row says &quot;AI note unavailable&quot;.</p>
            </article>
            <article className="rounded-3xl border border-fr-line bg-white p-7 lg:col-span-2">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-fr-terra"><FileClock size={14} /> Fully auditable</div>
              <h3 className="mt-3 font-display text-[22px] font-extrabold text-fr-forest">Every action on the record</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-fr-ink2">Runs, approvals, rejections, quantity edits and kill switch changes are logged with who and when. Approved reorders become dry-run Zoho drafts. Nothing is sent automatically.</p>
            </article>
          </div>
        </div>
      </section>

      {/* ---------- Raghav ---------- */}
      <section id="raghav" className="overflow-hidden border-y border-fr-line bg-fr-bone2 py-20 lg:py-28">
        <div className="mx-auto grid max-w-[1240px] items-center gap-12 px-5 lg:grid-cols-2 lg:px-8">
          <div>
            <div className={eyebrow}>The human in the loop</div>
            <h2 className={`${h2} mt-3`}>Raghav approves every <span className={accentWord}>recommendation.</span></h2>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-fr-ink2">Today Raghav spends about two days a month pulling SAP data into Excel. Freshroots runs the same analysis twice a week with his rules and hands him one queue: what to reorder, why, and what needs his judgment. He decides. Only then does a draft purchase order exist.</p>
            <Link href="/planner" className="mt-7 inline-flex h-12 items-center gap-2 rounded-full bg-fr-forest px-6 text-[15px] font-semibold text-fr-bone hover:bg-fr-deep">Open the queue <ArrowRight size={16} /></Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {[["0", "purchase orders without an approval"], ["2×", "runs every week, Mon and Thu"], ["5", "reason codes on every override"]].map(([v, l]) => (
              <div key={l} className="rounded-3xl border border-fr-line bg-white p-6"><div className="font-display text-[48px] font-black leading-none text-fr-forest">{v}</div><div className="mt-2 text-[14px] text-fr-ink2">{l}</div></div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className="relative overflow-hidden bg-fr-deep py-24 text-fr-bone">
        <div className="mx-auto max-w-[900px] px-5 text-center">
          <div className="font-mono text-[11.5px] uppercase tracking-[0.2em] text-fr-sage">Ready when you are</div>
          <h2 className="mt-4 font-display text-[clamp(36px,5.5vw,60px)] font-black leading-[1.03] tracking-tight">Ship the right amount of <span className={accentWord}>fresh.</span></h2>
          <p className="mx-auto mt-5 max-w-xl text-[17px] leading-relaxed text-fr-bone/75">Step into the planner: real rules, real recommendations, one approval queue.</p>
          <Link href="/planner" className="mt-9 inline-flex h-14 items-center gap-3 rounded-full bg-fr-bone pl-8 pr-3 text-[16px] font-semibold text-fr-forest hover:bg-white">Enter the planner app <span className="grid h-9 w-9 place-items-center rounded-full bg-fr-terra text-white"><ArrowRight size={17} /></span></Link>
        </div>
      </section>

      <footer className="bg-fr-bone py-8">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-5 text-[13px] text-fr-ink3 lg:px-8">
          <span className="flex items-center gap-2 font-display font-extrabold text-fr-forest"><Sprout size={16} /> Freshroots</span>
          <span className="font-mono text-[11px] uppercase tracking-widest">Rules-first demand planning · AI at the edges</span>
          <Link href="/planner" className="hover:text-fr-forest">Planner portal</Link>
        </div>
      </footer>
    </div>
  );
}
