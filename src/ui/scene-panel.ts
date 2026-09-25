// A scene's own little panel (bottom right, as the flag's wind panel): the one or two things
// worth trying in that scene, declared as choices (segmented buttons), actions and live
// readouts. Styles in controls.css.

import './controls.css';

export type PanelItem =
  | { kind: 'choice'; label: string; options: { label: string; value: number }[]; get(): number; set(value: number): void }
  | { kind: 'select'; label: string; options: { label: string; value: number }[]; get(): number; set(value: number): void }
  /** A slider (logarithmic from min to max with `log`); `format` shows the value beside it. */
  | { kind: 'range'; label: string; min: number; max: number; log?: boolean; get(): number; set(value: number): void; format(value: number): string }
  /** A button: the accent colour, or outlined when `secondary`. */
  | { kind: 'action'; label: string; icon?: string; secondary?: boolean; run(): void }
  | { kind: 'readout'; label: string; value(): string }
  /** A rule and a caption that folds the items after it away (folded at first on phones). */
  | { kind: 'heading'; label: string };

export interface PanelSpec {
  title: string;
  items: PanelItem[];
}

/** SVG markup (24 × 24, strokes) for actions. */
export const PANEL_ICONS = {
  replay: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
};

export class ScenePanel {
  readonly root = document.createElement('div');
  private refreshers: (() => void)[] = [];
  /** Headings folded or unfolded by hand, by label (kept from scene to scene). */
  private readonly folded = new Map<string, boolean>();
  /** The panel shows live readouts (so the app keeps their data fresh). */
  hasReadouts = false;

  constructor() {
    this.root.className = 'avbd-panel';
    this.root.hidden = true;
    document.body.append(this.root);
  }

  /** Show `spec`'s panel (null hides it). */
  show(spec: PanelSpec | null): void {
    this.root.replaceChildren();
    this.refreshers = [];
    this.root.hidden = spec === null;
    this.hasReadouts = spec?.items.some((i) => i.kind === 'readout') ?? false;
    if (!spec) return;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = spec.title;
    this.root.append(title);
    let parent: HTMLElement = this.root;
    for (const item of spec.items) {
      if (item.kind === 'heading') {
        parent = this.fold(item.label);
        continue;
      }
      parent.append(this.build(item));
    }
    this.refresh();
  }

  /** Re-read choices and readouts. */
  refresh(): void {
    if (!this.root.hidden) for (const r of this.refreshers) r();
  }

  /** A heading that shows or hides what follows it; returns the element to put that in. */
  private fold(label: string): HTMLElement {
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'heading';
    head.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    head.append(label);
    const body = document.createElement('div');
    const set = (folded: boolean) => {
      body.hidden = folded;
      head.setAttribute('aria-expanded', String(!folded));
    };
    set(this.folded.get(label) ?? matchMedia('(max-width: 760px)').matches);
    head.addEventListener('click', () => {
      this.folded.set(label, !body.hidden);
      set(!body.hidden);
    });
    this.root.append(head, body);
    return body;
  }

  private build(item: PanelItem): HTMLElement {
    switch (item.kind) {
      case 'choice': {
        const field = document.createElement('div');
        field.className = 'field';
        const label = document.createElement('label');
        label.textContent = item.label;
        const row = document.createElement('div');
        row.className = 'segmented';
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', item.label);
        const buttons = item.options.map((o) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = o.label;
          b.addEventListener('click', () => {
            item.set(o.value);
            this.refresh();
          });
          row.append(b);
          return { b, value: o.value };
        });
        this.refreshers.push(() => {
          for (const { b, value } of buttons) b.setAttribute('aria-pressed', String(value === item.get()));
        });
        field.append(label, row);
        return field;
      }
      case 'select': {
        const field = document.createElement('div');
        field.className = 'field';
        const label = document.createElement('label');
        label.textContent = item.label;
        const select = document.createElement('select');
        select.setAttribute('aria-label', item.label);
        for (const o of item.options) select.append(new Option(o.label, String(o.value)));
        select.addEventListener('change', () => {
          item.set(Number(select.value));
          this.refresh();
        });
        this.refreshers.push(() => (select.value = String(item.get())));
        field.append(label, select);
        return field;
      }
      case 'range': {
        const field = document.createElement('div');
        field.className = 'field';
        const label = document.createElement('label');
        const value = document.createElement('b');
        label.append(item.label, value);
        const input = document.createElement('input');
        input.type = 'range';
        input.setAttribute('aria-label', item.label);
        const log = item.log === true;
        const to = (v: number) => (log ? (1000 * Math.log(v / item.min)) / Math.log(item.max / item.min) : v);
        const from = (t: number) => (log ? item.min * Math.pow(item.max / item.min, t / 1000) : t);
        input.min = String(log ? 0 : item.min);
        input.max = String(log ? 1000 : item.max);
        input.step = log ? '1' : 'any';
        input.addEventListener('input', () => {
          item.set(from(Number(input.value)));
          value.textContent = item.format(item.get());
        });
        this.refreshers.push(() => {
          input.value = String(to(item.get()));
          value.textContent = item.format(item.get());
        });
        field.append(label, input);
        return field;
      }
      case 'action': {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = item.secondary ? 'action secondary' : 'action';
        b.innerHTML = item.icon ? `<svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>` : '';
        b.append(item.label);
        b.addEventListener('click', () => item.run());
        return b;
      }
      case 'heading':
        return this.fold(item.label);
      case 'readout': {
        const row = document.createElement('div');
        row.className = 'readout';
        const value = document.createElement('b');
        row.append(item.label, value);
        this.refreshers.push(() => (value.textContent = item.value()));
        return row;
      }
    }
  }
}
