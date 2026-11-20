const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;

if (!reduceMotion && finePointer) {
  let glowFrame = 0;
  window.addEventListener("pointermove", (event) => {
    if (glowFrame) return;
    glowFrame = requestAnimationFrame(() => {
      document.documentElement.style.setProperty("--cursor-x", `${event.clientX / innerWidth * 100}%`);
      document.documentElement.style.setProperty("--cursor-y", `${event.clientY / innerHeight * 100}%`);
      glowFrame = 0;
    });
  }, { passive: true });
  const view = document.querySelector("#view");
  view?.addEventListener("pointermove", (event) => {
    const poster = event.target.closest(".hero-poster");
    if (poster) {
      const box = poster.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5;
      const y = (event.clientY - box.top) / box.height - .5;
      poster.style.setProperty("--tilt-x", `${-y * 7}deg`);
      poster.style.setProperty("--tilt-y", `${x * 8}deg`);
    }
    const cta = event.target.closest(".signin .btn-primary:not([disabled])");
    if (cta) {
      const box = cta.getBoundingClientRect();
      cta.style.setProperty("--mag-x", `${((event.clientX - box.left) / box.width - .5) * 7}px`);
      cta.style.setProperty("--mag-y", `${((event.clientY - box.top) / box.height - .5) * 5}px`);
    }
  }, { passive: true });
  view?.addEventListener("pointerleave", (event) => {
    const poster = event.target.closest?.(".hero-poster");
    poster?.style.setProperty("--tilt-x", "0deg");
    poster?.style.setProperty("--tilt-y", "0deg");
    const cta = event.target.closest?.(".signin .btn-primary");
    cta?.style.setProperty("--mag-x", "0px");
    cta?.style.setProperty("--mag-y", "0px");
  }, true);

  let frame = 0;
  window.addEventListener("scroll", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      const depth = `${Math.min(window.scrollY, 48) * .08}px`;
      document.querySelectorAll(".poster").forEach((poster) => poster.style.setProperty("--scroll-depth", depth));
      frame = 0;
    });
  }, { passive: true });
}

if (!reduceMotion && "IntersectionObserver" in window) {
  const reveal = new IntersectionObserver((entries, observer) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.dataset.depthVisible = "true";
    observer.unobserve(entry.target);
  }), { threshold: .08, rootMargin: "0px 0px -28px 0px" });

  const observeReveals = (scope = document) => {
    scope.querySelectorAll(".app > #view > *, .app > #join, .app > #scan, .app > footer").forEach((node) => {
      if (node.dataset.depthVisible === "true" || node.classList.contains("depth-enter")) return;
      node.classList.add("depth-enter");
      reveal.observe(node);
    });
  };
  observeReveals();
  const view = document.querySelector("#view");
  if (view) new MutationObserver(() => observeReveals(view)).observe(view, { childList: true });
}
