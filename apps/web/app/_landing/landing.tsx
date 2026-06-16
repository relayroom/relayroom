import { Fragment } from "react"
import Link from "next/link"
import { COPY, type Locale, type Rich } from "./copy"
import { SiteNav } from "@/components/nav/site-nav"
import { HeroAnimation } from "./hero-animation"
import { ICONS, IconOk, IconX, RRMark } from "./icons"
import { Reveal } from "./reveal"
import "./relayroom-landing.css"

/** Render an inline Rich run (plain / bold / mono) as server HTML. */
function R({ segs }: { segs: Rich }) {
  return (
    <>
      {segs.map((seg, i) => {
        if (typeof seg === "string") return <Fragment key={i}>{seg}</Fragment>
        if ("b" in seg) return <b key={i}>{seg.b}</b>
        return (
          <span key={i} className="mono">
            {seg.mono}
          </span>
        )
      })}
    </>
  )
}

const SIGN_IN = "/account/sign-in"
const DASHBOARD = "/dashboard"

export function Landing({ locale }: { locale: Locale }) {
  const c = COPY[locale]
  const home = locale === "en" ? "/" : "/ko"

  return (
    <>
      <SiteNav locale={locale} surface="landing" />
      <Reveal>
        {/* HERO */}
        <header className="wrap hero">
        <span className="hero-badge reveal">
          <i />
          {c.hero.badge}
        </span>
        <h1 className="reveal d1">
          {c.hero.title.lead}
          <br />
          {c.hero.title.emPre}
          <em>{c.hero.title.em}</em>
          {c.hero.title.emPost}
        </h1>
        <p className="lede reveal d2">
          <R segs={c.hero.lede} />
        </p>
        <div className="cta-row reveal d3">
          <Link className="btn btn--primary btn--lg" href={SIGN_IN}>
            {c.hero.ctaPrimary}
          </Link>
          <a className="btn btn--ghost btn--lg" href="#how">
            {c.hero.ctaSecondary}
          </a>
        </div>
        <p className="trust mono reveal d4">{c.hero.trust}</p>

        <div className="hero-visual">
          <div className="hero-glow" />
          <div className="reveal d5" style={{ width: "100%", maxWidth: 760 }}>
            <HeroAnimation board={c.hero.board} />
          </div>
        </div>
      </header>

      {/* PROBLEM */}
      <section className="problem" id="problem">
        <div className="wrap">
          <span className="sec-tag">{c.problem.tag}</span>
          <h2 className="sec-h">{c.problem.h}</h2>
          <div className="prob-grid">
            <p className="prob-quote">
              <R segs={c.problem.quote} />
            </p>
            <div className="loop">
              {c.problem.loop.map((step, i) => (
                <div className="step" key={i}>
                  <span className={step.you === "from" ? "who you" : "who"}>{step.from}</span>
                  <span className="arrow">→</span>
                  <span className={step.you === "to" ? "who you" : "who"}>{step.to}</span>
                  <span className="txt">{step.txt}</span>
                </div>
              ))}
              <div className="loop__cap">{c.problem.cap}</div>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how" id="how">
        <div className="wrap">
          <span className="sec-tag">{c.how.tag}</span>
          <h2 className="sec-h">{c.how.h}</h2>
          <p className="sec-sub">{c.how.sub}</p>
          <div className="steps">
            {c.how.steps.map((step) => (
              <div className="step-card" key={step.n}>
                <div className="n">{step.n}</div>
                <h3>{step.title}</h3>
                <p>
                  <R segs={step.body} />
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features">
        <div className="wrap">
          <span className="sec-tag">{c.features.tag}</span>
          <h2 className="sec-h">{c.features.h}</h2>
          <div className="feat-grid">
            {c.features.items.map((f, i) => (
              <div className="feat" key={i}>
                <div className="ic">{ICONS[f.icon]}</div>
                <h3>{f.title}</h3>
                <p>
                  <R segs={f.body} />
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ONE SEAT */}
      <section className="seat" id="seat">
        <div className="wrap" style={{ textAlign: "center" }}>
          <span className="sec-tag">{c.seat.tag}</span>
          <h2 className="sec-h" style={{ marginLeft: "auto", marginRight: "auto" }}>
            {c.seat.h}
          </h2>
          <p className="sec-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
            {c.seat.sub}
          </p>
          <div className="flow">
            <div className="node">
              <div className="box navy">
                <div className="lbl">You</div>
              </div>
              <div className="sub">{c.seat.flow.you}</div>
            </div>
            <div className="conn live" />
            <div className="node">
              <div className="box">
                <div className="lbl">{c.seat.flow.main}</div>
              </div>
              <div className="sub">{c.seat.flow.main}</div>
            </div>
            <div className="conn" />
            <div className="node">
              <div className="box">
                <div className="lbl">{c.seat.flow.board}</div>
              </div>
              <div className="sub mono">{c.seat.flow.boardMeta}</div>
            </div>
          </div>
          <div className="agents-fan">
            {c.seat.chips.map((chip, i) => (
              <div className="agent-chip" key={i}>
                <span className="dot" style={{ background: chip.color }} />
                <span className="p">{chip.part}</span>
                <span className="m">{chip.meta}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* COST */}
      <section className="cost" id="cost">
        <div className="wrap" style={{ textAlign: "center" }}>
          <span className="sec-tag">{c.cost.tag}</span>
          <h2 className="sec-h" style={{ marginLeft: "auto", marginRight: "auto" }}>
            {c.cost.h}
          </h2>
          <p className="sec-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
            <R segs={c.cost.sub} />
          </p>
          <div className="cost-grid">
            {c.cost.cards.map((card, i) => (
              <div className="cost-card" key={i}>
                <p className="kicker">{card.kicker}</p>
                <h3>{card.title}</h3>
                <div className="cost-line old">
                  <span className="mk no">{IconX}</span>
                  <span className="t">
                    <R segs={card.bad} />
                  </span>
                </div>
                <div className="cost-line yes">
                  <span className="mk yes">{IconOk}</span>
                  <span className="t">
                    <R segs={card.good} />
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div className="cost-foot">
            <span className="cost-stat">
              <R segs={c.cost.foot} />
            </span>
          </div>
          <p className="cost-note">
            {c.cost.note}{" "}
            <a href={c.cost.link.href} target="_blank" rel="noopener noreferrer">
              {c.cost.link.label}
            </a>
          </p>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="final" id="cta">
        <div className="wrap">
          <h2>{c.final.h}</h2>
          <p>{c.final.p}</p>
          <div className="cta-row">
            <Link className="btn btn--onnavy btn--lg" href={SIGN_IN}>
              {c.final.ctaPrimary}
            </Link>
            <Link
              className="btn btn--outline btn--lg"
              href={DASHBOARD}
              style={{ borderColor: "var(--rr-slate-700)", color: "#fff" }}
            >
              {c.final.ctaSecondary}
            </Link>
          </div>
          <p className="trust mono">{c.final.trust}</p>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <Link className="brand" href={home}>
            <RRMark />
            <b>RelayRoom</b>
          </Link>
          <div className="cols">
            {c.footer.links.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </div>
          <span className="legal">{c.footer.legal}</span>
        </div>
      </footer>
      </Reveal>
    </>
  )
}
