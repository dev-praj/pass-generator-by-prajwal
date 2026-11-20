const root = document.documentElement;
const toggles = document.querySelectorAll("[data-theme-toggle]");

function syncThemeControls() {
  const dark = root.dataset.theme === "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#14100C" : "#F6EFE3");
  toggles.forEach((button) => {
    button.setAttribute("aria-pressed", String(dark));
    button.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  });
}

syncThemeControls();
toggles.forEach((button) => button.addEventListener("click", (event) => {
  const applyTheme = () => {
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    try { localStorage.setItem("gp.theme", root.dataset.theme); } catch {}
    syncThemeControls();
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduced && document.startViewTransition) {
    root.style.setProperty("--theme-x", `${event.clientX}px`);
    root.style.setProperty("--theme-y", `${event.clientY}px`);
    document.startViewTransition(applyTheme);
  } else applyTheme();
}));
