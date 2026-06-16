"use client"

import { Fragment, useEffect, useState } from "react"
import type { LandingCopy, Rich } from "./copy"

/** Inline Rich renderer (client copy of landing.tsx's R). */
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

const Dots = () => (
  <span className="rr-dots">
    <i />
    <i />
    <i />
  </span>
)

// Phase timeline. Act 1 (terminals): 0..5. Act 2 (board): 6..10. Then it loops.
const STEPS = 11
const DUR = [900, 1000, 1500, 1000, 1400, 1100, 700, 700, 700, 900, 2000]
const FINAL = 10 // reduced-motion / static frame: the full board

/**
 * Hero animation — the RelayRoom loop in two acts:
 *  1. Two tmux panes (mobile, backend) ask and answer over MCP.
 *  2. The same exchange surfaces on the live dashboard board, where you confirm.
 *
 * Pure DOM + CSS (no video, no libs); both scenes cross-fade. Honors
 * prefers-reduced-motion by holding the final board frame. Decorative
 * (aria-hidden) — the copy carries the meaning for assistive tech.
 */
export function HeroAnimation({ board }: { board: LandingCopy["hero"]["board"] }) {
  const [phase, setPhase] = useState(FINAL)
  const [mobile, backend, you] = board.msgs

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)")
    if (m.matches) {
      setPhase(FINAL)
      return
    }
    let p = 0
    let timer: ReturnType<typeof setTimeout>
    const run = () => {
      setPhase(p)
      timer = setTimeout(() => {
        // First pass types the exchange (0-4). After that, loop 5..10 so the
        // terminals keep their conversation while the dashboard rises and falls.
        p = p >= STEPS - 1 ? 5 : p + 1
        run()
      }, DUR[p])
    }
    run()
    return () => clearTimeout(timer)
  }, [])

  const actBoard = phase >= 6

  return (
    <div className="rr-anim" data-board={actBoard} aria-hidden="true">
      {/* ── Act 2: the dashboard rises as a window over the still-running terminals ── */}
      <div className="rr-scene rr-scene--board" data-active={actBoard}>
        <div className="board">
          <div className="board__bar">
            <span className="board__dots">
              <i />
              <i />
              <i />
            </span>
            <span className="board__title">
              <R segs={board.title} />
            </span>
            <span className="pill pill--live">
              <i />
              {board.live}
            </span>
          </div>
          <div className="board__thread">
            <div className="ttl">
              {board.threadTitle}{" "}
              <span className="pill pill--open">
                <i />
                {board.open}
              </span>
            </div>
            <div className="meta mono">{board.meta}</div>
          </div>
          <div className="msgs">
            <BoardMsg m={mobile} show={phase >= 7} />
            <BoardMsg m={backend} show={phase >= 8} />
            <BoardMsg m={you} show={phase >= 9} />
          </div>
          <div className="typing rr-reveal" data-show={phase >= 9}>
            <span className="who">{board.typingWho}</span>
            <Dots />
            <span className="lbl">{board.typingLabel}</span>
          </div>
        </div>
      </div>

      {/* ── Act 1: two tmux panes talking (the base layer; stays put) ── */}
      <div className="rr-scene rr-scene--term">
        <div className="rr-terms">
          <Term
            who={mobile.from}
            cwd="~/app-mobile"
            cmd={["relayroom send ", { mono: "--to backend" }]}
            typing={phase === 1}
            msg={mobile.text}
            showMsg={phase >= 2}
          />
          <Term
            who={backend.from}
            cwd="~/api"
            cmd={["relayroom reply ", { mono: "#a1c" }]}
            typing={phase === 3}
            msg={backend.text}
            showMsg={phase >= 4}
            incoming={phase >= 2}
          />
        </div>
        <div className="rr-relay" data-on={phase >= 2 && phase <= 4} />
      </div>
    </div>
  )
}

function BoardMsg({ m, show }: { m: LandingCopy["hero"]["board"]["msgs"][number]; show: boolean }) {
  return (
    <div className={m.you ? "msg msg--you rr-reveal" : "msg rr-reveal"} data-show={show}>
      <span className={m.you ? "ava ava--you" : "ava"}>{m.ava}</span>
      <div className="body">
        <div className="head">
          <span className="from">{m.from}</span>
          {m.tag ? <span className="tag">{m.tag}</span> : null}
          {m.tagYou ? <span className="tag tag--you">you</span> : null}
          <span className="time">{m.time}</span>
        </div>
        <div className="text">
          <R segs={m.text} />
        </div>
      </div>
    </div>
  )
}

function Term({
  who,
  cwd,
  cmd,
  typing,
  msg,
  showMsg,
  incoming,
}: {
  who: string
  cwd: string
  cmd: Rich
  typing: boolean
  msg: Rich
  showMsg: boolean
  incoming?: boolean
}) {
  return (
    <div className="rr-term">
      <div className="rr-term__bar">
        <span className="rr-term__btns">
          <i />
          <i />
          <i />
        </span>
        <span className="who">{who}</span>
        <span className="cwd">{cwd}</span>
        {incoming ? <span className="rr-term__in">● msg</span> : null}
      </div>
      <div className="rr-term__body">
        <div className="rr-term__cmd">
          <span className="pmt">{who} ❯</span> <R segs={cmd} />
        </div>
        {typing ? (
          <div className="rr-term__typing">
            <Dots />
          </div>
        ) : null}
        <div className="rr-term__msg rr-reveal" data-show={showMsg}>
          <R segs={msg} />
        </div>
      </div>
    </div>
  )
}
