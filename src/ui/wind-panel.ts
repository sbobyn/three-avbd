// The wind panel, shown by scenes with wind (the flag): a dial whose arrow is the wind, its
// direction where the wind blows and its length the speed. The dial is the ground seen from
// the camera (up = into the view), so the arrow turns as the camera orbits and a drag always
// means what it looks like. Styles in controls.css.

import './controls.css';

export interface WindPanelOptions {
  /** Current wind: speed (m/s) and angle (rad from +x, about z). */
  get(): { speed: number; angle: number };
  set(speed: number, angle: number): void;
  /** The camera's heading on the ground: unit forward and right vectors (x, y). */
  basis(): { forward: [number, number]; right: [number, number] };
  max: number;
}

const SIZE = 120;
const C = SIZE / 2;
/** Dial radius (px) of the top speed. */
const R = 50;

export class WindPanel {
  readonly root = document.createElement('div');
  private readonly speed: HTMLSpanElement;
  private readonly arrow: SVGLineElement;
  private readonly head: SVGCircleElement;
  private readonly options: WindPanelOptions;

  constructor(options: WindPanelOptions) {
    this.options = options;
    this.root.className = 'avbd-wind';
    this.root.hidden = true;
    const rings = [1, 2, 3].map((k) => `<circle cx="${C}" cy="${C}" r="${(R * k) / 3}" class="ring"/>`).join('');
    this.root.innerHTML = `
      <div class="head"><span class="title">Wind</span><span class="speed"></span></div>
      <svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="slider" aria-label="Wind direction and speed" tabindex="0">
        ${rings}
        <line x1="${C}" y1="${C - R - 4}" x2="${C}" y2="${C + R + 4}" class="axis"/>
        <line x1="${C - R - 4}" y1="${C}" x2="${C + R + 4}" y2="${C}" class="axis"/>
        <line x1="${C}" y1="${C}" x2="${C}" y2="${C}" class="arrow"/>
        <circle cx="${C}" cy="${C}" r="7" class="knob"/>
      </svg>
      <div class="hint">Drag to steer · ${options.max} m/s at the rim</div>`;
    this.speed = this.root.querySelector('.speed')!;
    this.arrow = this.root.querySelector('.arrow')!;
    this.head = this.root.querySelector('.knob')!;
    document.body.append(this.root);

    const svg = this.root.querySelector('svg')!;
    const steer = (e: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      const dx = ((e.clientX - box.left) / box.width) * SIZE - C;
      const dy = C - ((e.clientY - box.top) / box.height) * SIZE;
      const speed = Math.min(Math.hypot(dx, dy) / R, 1) * options.max;
      const { forward: f, right: r } = options.basis();
      // Dial right is the camera's right, dial up its forward
      options.set(Math.round(speed * 2) / 2, Math.atan2(r[1] * dx + f[1] * dy, r[0] * dx + f[0] * dy));
      this.update();
    };
    svg.addEventListener('pointerdown', (e) => {
      svg.setPointerCapture(e.pointerId);
      steer(e);
    });
    svg.addEventListener('pointermove', (e) => svg.hasPointerCapture(e.pointerId) && steer(e));
    // Arrow keys: left/right turn by 15°, up/down change the speed by 1 m/s
    svg.addEventListener('keydown', (e) => {
      const { speed, angle } = options.get();
      const turn = { ArrowLeft: 1, ArrowRight: -1 }[e.key];
      const faster = { ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (turn === undefined && faster === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      options.set(Math.min(Math.max(speed + (faster ?? 0), 0), options.max), angle + ((turn ?? 0) * Math.PI) / 12);
      this.update();
    });
  }

  show(visible: boolean): void {
    this.root.hidden = !visible;
    if (visible) this.update();
  }

  /** Redraw from the current wind and camera (call as the camera moves). */
  update(): void {
    if (this.root.hidden) return;
    const { speed, angle } = this.options.get();
    const { forward: f, right: r } = this.options.basis();
    const [wx, wy] = [Math.cos(angle), Math.sin(angle)];
    const k = (Math.min(speed, this.options.max) / this.options.max) * R;
    const x = C + k * (wx * r[0] + wy * r[1]);
    const y = C - k * (wx * f[0] + wy * f[1]);
    this.arrow.setAttribute('x2', x.toFixed(1));
    this.arrow.setAttribute('y2', y.toFixed(1));
    this.head.setAttribute('cx', x.toFixed(1));
    this.head.setAttribute('cy', y.toFixed(1));
    this.speed.textContent = speed > 0 ? `${speed.toFixed(speed < 10 ? 1 : 0)} m/s` : 'calm';
  }
}
