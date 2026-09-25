// The demos' controls: a dock of icon buttons with a scene picker and a settings popover (styles
// in controls.css). The scene picker lists the scenes in collapsible sections by kind, the
// current one's open; settings are declarative rows, with the rest under a closed "Advanced".
// One popover is open at a time; Esc or a click elsewhere closes it.

import './controls.css';
import type { SceneMenu } from './scene-menu.ts';

export type Setting =
  | { kind: 'range'; label: string; min: number; max: number; step?: number; log?: boolean; get(): number; set(v: number): void; format?(v: number): string }
  | { kind: 'toggle'; label: string; get(): boolean; set(v: boolean): void }
  | { kind: 'select'; label: string; options: { label: string; value: string }[]; get(): string; set(v: string): void }
  | { kind: 'action'; label: string; run(): void }
  | { kind: 'section'; label: string; items: Setting[] };

export interface DockButton {
  label: string;
  /** SVG markup inside a 24 × 24 viewBox (strokes). */
  icon: string | (() => string);
  onClick(): void;
  pressed?(): boolean;
}

export interface ControlsOptions {
  scenes: SceneMenu;
  onScene(value: string): void;
  buttons: DockButton[];
  settings: Setting[];
}

export const ICONS = {
  play: '<polygon points="7 4 19 12 7 20 7 4"/>',
  pause: '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  box: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  ball: '<circle cx="11" cy="13" r="7"/><path d="M7.5 11a4 4 0 0 1 3-3"/><path d="M16 6l2.5-2.5M17.5 8.5l3-.5M14 4.5l.5-3"/>',
  focus: '<circle cx="12" cy="12" r="4"/><path d="M3 12h3M18 12h3M12 3v3M12 18v3"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  step: '<polygon points="5 5 13 12 5 19 5 5"/><line x1="17" y1="5" x2="17" y2="19"/>',
  /** GitHub's mark (filled, unlike the others). */
  github:
    '<g transform="translate(2 2) scale(1.25)"><path fill="currentColor" stroke="none" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></g>',
};

/** The project's source. */
export const REPO_URL = 'https://github.com/sbobyn/three-avbd';
export const openRepo = (): void => void window.open(REPO_URL, '_blank', 'noopener');
const CHEVRON_DOWN = '<polyline points="6 9 12 15 18 9"/>';
const CHEVRON_RIGHT = '<polyline points="9 6 15 12 9 18"/>';
const svg = (inner: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...children);
  return e;
}

/** A section with a header button that shows and hides its body. */
function section(label: string, count: string, open: boolean): { root: HTMLElement; head: HTMLButtonElement; body: HTMLElement } {
  const head = el('button', { class: 'section-head', type: 'button' });
  head.innerHTML = `${svg(CHEVRON_RIGHT)}<span></span><span class="count"></span>`;
  head.children[1].textContent = label;
  head.children[2].textContent = count;
  const body = el('div', { class: 'section-body' });
  const root = el('div', { class: 'section' }, head, body);
  const set = (o: boolean) => {
    head.setAttribute('aria-expanded', String(o));
    body.hidden = !o;
  };
  set(open);
  head.addEventListener('click', () => set(body.hidden));
  return { root, head, body };
}

export class Controls {
  readonly root = el('div', { class: 'avbd-ui' });
  private readonly sceneLabel = el('span');
  private readonly scenePopover = el('div', { class: 'popover', role: 'dialog' });
  private readonly settingsPopover = el('div', { class: 'popover', role: 'dialog' });
  private readonly sceneButton: HTMLButtonElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly dockButtons: { spec: DockButton; button: HTMLButtonElement }[] = [];
  private readonly sceneItems = new Map<string, { item: HTMLButtonElement; open(): void; label: string }>();
  private readonly refreshers: (() => void)[] = [];
  private current = '';

  constructor(options: ControlsOptions) {
    this.sceneButton = el('button', { class: 'scene-button', type: 'button', title: 'Choose a scene' });
    this.sceneButton.append(this.sceneLabel);
    this.sceneButton.insertAdjacentHTML('beforeend', svg(CHEVRON_DOWN));
    this.sceneButton.addEventListener('click', () => this.toggle(this.scenePopover, this.sceneButton));

    const dock = el('div', { class: 'dock' }, this.sceneButton, el('div', { class: 'separator' }));
    for (const spec of options.buttons) {
      const button = el('button', { class: 'icon', type: 'button', title: spec.label });
      button.setAttribute('aria-label', spec.label);
      button.addEventListener('click', () => {
        spec.onClick();
        this.refresh();
      });
      this.dockButtons.push({ spec, button });
      dock.append(button);
    }
    this.settingsButton = el('button', { class: 'icon', type: 'button', title: 'Settings' });
    this.settingsButton.setAttribute('aria-label', 'Settings');
    this.settingsButton.innerHTML = svg(ICONS.settings);
    this.settingsButton.addEventListener('click', () => this.toggle(this.settingsPopover, this.settingsButton));
    dock.append(this.settingsButton);

    this.buildScenes(options.scenes, options.onScene);
    for (const s of options.settings) this.settingsPopover.append(this.buildSetting(s));
    this.scenePopover.hidden = this.settingsPopover.hidden = true;
    this.root.append(dock, this.scenePopover, this.settingsPopover);
    document.body.append(this.root);

    document.addEventListener('pointerdown', (e) => {
      if (!this.root.contains(e.target as Node)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.refresh();
  }

  /** Show `value` as the current scene (and its section as the open one next time). */
  setScene(value: string): void {
    this.sceneItems.get(this.current)?.item.classList.remove('current');
    this.current = value;
    const entry = this.sceneItems.get(value);
    this.sceneLabel.textContent = entry?.label ?? value;
    if (!entry) return;
    entry.item.classList.add('current');
    entry.open();
  }

  /** Re-read every setting and button state (after keyboard shortcuts, scene changes...). */
  refresh(): void {
    for (const { spec, button } of this.dockButtons) {
      const icon = typeof spec.icon === 'function' ? spec.icon() : spec.icon;
      if (button.dataset.icon !== icon) {
        button.innerHTML = svg(icon);
        button.dataset.icon = icon;
      }
      if (spec.pressed) button.setAttribute('aria-pressed', String(spec.pressed()));
    }
    if (!this.settingsPopover.hidden) for (const r of this.refreshers) r();
  }

  close(): void {
    for (const [popover, button] of [
      [this.scenePopover, this.sceneButton],
      [this.settingsPopover, this.settingsButton],
    ] as const) {
      popover.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    }
  }

  private toggle(popover: HTMLElement, button: HTMLButtonElement): void {
    const open = popover.hidden;
    this.close();
    if (!open) return;
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (popover === this.settingsPopover) for (const r of this.refreshers) r();
  }

  private buildScenes(menu: SceneMenu, onScene: (value: string) => void): void {
    const heads: { head: HTMLButtonElement; body: HTMLElement }[] = [];
    // Accordion: opening a section closes the others
    const exclusive = (s: { head: HTMLButtonElement; body: HTMLElement }) => {
      heads.push(s);
      s.head.addEventListener('click', () => {
        if (s.body.hidden) return;
        for (const o of heads) {
          if (o === s) continue;
          o.body.hidden = true;
          o.head.setAttribute('aria-expanded', 'false');
        }
      });
      return () => {
        for (const o of heads) {
          o.body.hidden = o !== s;
          o.head.setAttribute('aria-expanded', String(o === s));
        }
      };
    };
    const addItem = (body: HTMLElement, label: string, value: string, open: () => void) => {
      const item = el('button', { class: 'item', type: 'button' }, label);
      item.addEventListener('click', () => {
        this.close();
        onScene(value);
      });
      body.append(item);
      this.sceneItems.set(value, { item, open, label });
    };
    for (const group of menu.own) {
      const s = section(group.label, String(group.items.length), false);
      const open = exclusive(s);
      for (const item of group.items) addItem(s.body, item.label, item.value, open);
      this.scenePopover.append(s.root);
    }
    const count = menu.other.groups.reduce((n, g) => n + g.items.length, 0);
    const other = section(menu.other.title, `${count} scenes`, false);
    const openOther = exclusive(other);
    for (const group of menu.other.groups) {
      other.body.append(el('div', { class: 'subhead' }, group.label));
      for (const item of group.items) addItem(other.body, item.label, item.value, openOther);
    }
    this.scenePopover.append(other.root);
  }

  private buildSetting(s: Setting): HTMLElement {
    switch (s.kind) {
      case 'section': {
        const sec = section(s.label, '', false);
        for (const item of s.items) sec.body.append(this.buildSetting(item));
        return sec.root;
      }
      case 'action': {
        const b = el('button', { class: 'action', type: 'button' }, s.label);
        b.addEventListener('click', () => {
          s.run();
          for (const r of this.refreshers) r();
        });
        return b;
      }
      case 'toggle': {
        const sw = el('button', { class: 'switch', type: 'button', role: 'switch' });
        sw.setAttribute('aria-label', s.label);
        sw.addEventListener('click', () => {
          s.set(!s.get());
          sw.setAttribute('aria-checked', String(s.get()));
        });
        this.refreshers.push(() => sw.setAttribute('aria-checked', String(s.get())));
        return el('div', { class: 'row' }, el('label', {}, s.label), sw);
      }
      case 'select': {
        const select = el('select');
        select.setAttribute('aria-label', s.label);
        for (const o of s.options) select.append(el('option', { value: o.value }, o.label));
        select.addEventListener('change', () => {
          s.set(select.value);
          for (const r of this.refreshers) r();
        });
        this.refreshers.push(() => (select.value = s.get()));
        return el('div', { class: 'row' }, el('label', {}, s.label), select);
      }
      case 'range': {
        // Log sliders run over 0..1000 and map exponentially from min to max
        const input = el('input', { type: 'range' });
        input.setAttribute('aria-label', s.label);
        const log = s.log === true;
        const toSlider = (v: number) => (log ? (1000 * Math.log(v / s.min)) / Math.log(s.max / s.min) : v);
        const fromSlider = (t: number) => (log ? s.min * Math.pow(s.max / s.min, t / 1000) : t);
        input.min = String(log ? 0 : s.min);
        input.max = String(log ? 1000 : s.max);
        input.step = log ? '1' : String(s.step ?? (s.max - s.min) / 200);
        const value = el('span', { class: 'value' });
        const format = s.format ?? ((v: number) => (Math.abs(v) >= 1000 ? v.toExponential(1) : Number(v.toPrecision(3)).toString()));
        input.addEventListener('input', () => {
          s.set(fromSlider(Number(input.value)));
          value.textContent = format(s.get());
        });
        this.refreshers.push(() => {
          input.value = String(toSlider(s.get()));
          value.textContent = format(s.get());
        });
        return el('div', { class: 'row' }, el('label', {}, s.label), value, input);
      }
    }
  }
}
