/** Small-screen menu: closes when a link in it is used, on Escape, or on a click outside it. */
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest(".s-menu a");
  if (a) a.closest("details")?.removeAttribute("open");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelector(".s-menu[open]")?.removeAttribute("open");
});
document.addEventListener("pointerdown", (e) => {
  const open = document.querySelector(".s-menu[open]");
  if (open && !open.contains(e.target as Node)) open.removeAttribute("open");
});
