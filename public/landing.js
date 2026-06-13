/* Zaply — landing page motion */
"use strict";
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

document.body.classList.add("loaded");
$("#year").textContent = new Date().getFullYear();

/* ---------- Nav state + scroll progress (JS fallback) ---------- */
const nav = $("#nav");
const progress = $("#progress");
const supportsScrollTL = CSS && CSS.supports && CSS.supports("animation-timeline: scroll()");
function onScroll() {
  const y = window.scrollY;
  nav.classList.toggle("scrolled", y > 24);
  if (!supportsScrollTL && progress) {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
  }
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* ---------- Generic reveal on scroll ---------- */
if (reduce) {
  $$(".r").forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }
  }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
  $$(".r").forEach((el) => io.observe(el));
}

/* ---------- Hero phone: the animated "demo video" ---------- */
(function demo() {
  const body = $("#demoBody");
  if (!body) return;
  const script = [
    { who: "them", text: "Hi! What do you sell?" },
    { who: "me", text: "Hey! 👋 We help businesses run their whole WhatsApp on autopilot — replies, bookings, payments. What are you working on?" },
    { who: "them", text: "do you reply automatically even at night?" },
    { who: "me", text: "Yep, 24/7 — in your own tone 🙌 want me to show you a quick demo?" },
    { who: "them", text: "yes please" },
    { who: "me", text: "Great! I'll set you up — it takes about 60 seconds to connect your number ✨" },
  ];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function bubble(cls, text, tick) {
    const b = document.createElement("div");
    b.className = `bub ${cls}`;
    b.innerHTML = text + (tick ? ` <span class="tick">✓✓</span>` : "");
    body.appendChild(b);
    requestAnimationFrame(() => b.classList.add("show"));
    body.scrollTop = body.scrollHeight;
    return b;
  }
  function typing() {
    const t = document.createElement("div");
    t.className = "bub typing show";
    t.innerHTML = "<i></i><i></i><i></i>";
    body.appendChild(t);
    body.scrollTop = body.scrollHeight;
    return t;
  }
  async function run() {
    body.innerHTML = "";
    for (const m of script) {
      if (m.who === "me") {
        const t = typing();
        await wait(900 + Math.min(1400, m.text.length * 18));
        t.remove();
      } else {
        await wait(700);
      }
      bubble(m.who, m.text, m.who === "me");
      await wait(700);
    }
    await wait(3200);
  }
  if (reduce) {
    script.forEach((m) => bubble(m.who, m.text, m.who === "me"));
  } else {
    (async function loop() { for (;;) await run(); })();
  }
})();

/* ---------- Pinned "how it works": swap scene as steps cross center ---------- */
(function pinned() {
  const steps = $$("#pinSteps .pin-step");
  const scenes = $$(".pin-card .pin-scene");
  if (!steps.length || !scenes.length || reduce) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const i = +e.target.dataset.step;
        scenes.forEach((s) => s.classList.toggle("active", +s.dataset.scene === i));
      }
    }
  }, { threshold: 0.6 });
  steps.forEach((s) => io.observe(s));
})();

/* ---------- Count-up stats ---------- */
(function counters() {
  const nums = $$(".num[data-count]");
  if (!nums.length) return;
  const animate = (el) => {
    const target = +el.dataset.count;
    const pre = el.dataset.prefix || "";
    const suf = el.dataset.suffix || "";
    if (pre === "∞") { el.textContent = "∞"; return; }
    if (reduce) { el.textContent = pre + target + suf; return; }
    const dur = 1300, t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = pre + Math.round(target * eased) + suf;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { animate(e.target); io.unobserve(e.target); }
  }, { threshold: 0.6 });
  nums.forEach((n) => io.observe(n));
})();

/* ---------- Language greeting cycler ---------- */
(function langs() {
  const host = $("#hello");
  if (!host) return;
  const words = ["Hello", "Hola", "مرحبا", "Bonjour", "नमस्ते", "Olá", "السلام علیکم", "Ciao", "Привет", "你好"];
  words.forEach((w, i) => {
    const s = document.createElement("span");
    s.textContent = w;
    if (i === 0) s.classList.add("on");
    host.appendChild(s);
  });
  if (reduce) { host.children[0].classList.add("on"); return; }
  const spans = [...host.children];
  let i = 0;
  setInterval(() => {
    const cur = spans[i];
    cur.classList.remove("on"); cur.classList.add("out");
    i = (i + 1) % spans.length;
    const next = spans[i];
    next.classList.remove("out");
    void next.offsetWidth;
    next.classList.add("on");
    setTimeout(() => cur.classList.remove("out"), 500);
  }, 2200);
})();

/* ---------- Smooth-scroll for in-page anchors ---------- */
$$('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    if (id.length < 2) return;
    const t = document.querySelector(id);
    if (!t) return;
    e.preventDefault();
    t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });
});
