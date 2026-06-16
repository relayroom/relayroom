"use client"

import { type ReactNode, useEffect, useRef } from "react"

const SEC_SEL =
  ".sec-tag,.sec-h,.sec-sub,.prob-quote,.loop,.step-card,.feat,.cost-card,.cost-stat,.flow,.agents-fan,.final h2,.final p,.final .cta-row,.final .trust"

/**
 * Client wrapper that drives the scroll-reveal animation. The marketing markup
 * (its children) is rendered on the server — this only adds/observes CSS classes
 * on mount, so the page is full SSR HTML and works with JS disabled (the failsafe
 * forces the hero visible). It is the only client JS on the landing page.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.classList.add("is-mounted")

    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        root.querySelectorAll(".hero .reveal").forEach((el) => el.classList.add("in"))
      }),
    )

    const sections = Array.from(root.querySelectorAll(SEC_SEL))
    sections.forEach((el) => el.classList.add("reveal"))
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in")
            io.unobserve(e.target)
          }
        })
      },
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
    )
    sections.forEach((el) => io.observe(el))

    // Failsafe: if the hero reveal never fires, force it visible after 1.2s.
    const t = window.setTimeout(() => {
      root.querySelectorAll<HTMLElement>(".hero .reveal").forEach((el) => {
        el.classList.add("in")
        if (getComputedStyle(el).opacity === "0") {
          el.style.transition = "none"
          el.style.opacity = "1"
          el.style.transform = "none"
        }
      })
    }, 1200)

    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      window.clearTimeout(t)
    }
  }, [])

  return (
    <div className="rr-landing" ref={rootRef}>
      {children}
    </div>
  )
}
