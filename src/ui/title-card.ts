// The demos' title card (#card in index.html and 2d.html; styles in page.css): collapsible
// by clicking anywhere on its title bar, collapsed state remembered per viewer, and collapsed
// from the start on narrow screens.

const NARROW = 760;

export function titleCard(storageKey: string): void {
  const card = document.querySelector<HTMLDivElement>('#card');
  const toggle = document.querySelector<HTMLButtonElement>('#card-toggle');
  const head = document.querySelector<HTMLElement>('#card-head');
  if (!card || !toggle || !head) return;
  const set = (collapsed: boolean) => {
    card.classList.toggle('collapsed', collapsed);
    toggle.textContent = collapsed ? '+' : '–';
    toggle.title = collapsed ? 'About this demo' : 'Hide';
  };
  try {
    set(localStorage.getItem(storageKey) === '1' || window.innerWidth < NARROW);
  } catch {
    set(window.innerWidth < NARROW);
  }
  // The whole title bar toggles (the button inside it too, by bubbling)
  head.onclick = () => {
    const collapsed = !card.classList.contains('collapsed');
    set(collapsed);
    try {
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
    } catch {
      // Storage unavailable: the card just doesn't remember
    }
  };
}
