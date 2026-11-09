import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const SDF = { 'sdf.html': 'SDF playground', 'sdf-gears.html': 'Gear train', 'sdf-released.html': 'SDF collision studies' } as const;
const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*?\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ({ href: m[1], text: m[2].replace(/<[^>]*>/g, '').trim() }));

test('each SDF page has a "Demo gallery" link, the brand mark, a "Page · three-avbd" title and no ↗ on same-tab links', () => {
  for (const [page, name] of Object.entries(SDF)) {
    const html = read(page);
    assert.match(html, new RegExp(`<title>${name} · three-avbd</title>`), page);
    assert.match(html, /<header><a class="brand" href="\/"><img src="\/favicon\.svg" width="24" height="24" alt="">three-avbd<\/a>/, `${page}: brand mark`);
    const links = anchors(html);
    assert.ok(links.some(l => l.href === '/examples/' && l.text === 'Demo gallery'), `${page}: Demo gallery`);
    for (const l of links) {
      if (/^https?:/.test(l.href)) continue; // the GitHub links open the source page
      assert.doesNotMatch(l.text, /↗/, `${page}: "${l.text}" is a same-tab link`);
    }
  }
});

test('the three pages cross-link by the names they are titled with, and the studies page has one name', () => {
  const nav = (page: string) => anchors(/<nav aria-label="Related pages">([\s\S]*?)<\/nav>/.exec(read(page))![1]).map(l => `${l.href} ${l.text}`);
  assert.deepEqual(nav('sdf.html'), ['/examples/ Demo gallery', '/sdf-gears.html Gear train', '/sdf-released.html SDF collision studies']);
  assert.deepEqual(nav('sdf-gears.html'), ['/examples/ Demo gallery', '/sdf.html SDF playground']);
  assert.deepEqual(nav('sdf-released.html'), ['/examples/ Demo gallery', '/sdf.html SDF playground']);
  for (const page of Object.keys(SDF)) assert.doesNotMatch(read(page), /Reference scenes|Interactive playground|Playground ↗/, page);
  assert.match(read('sdf-released.html'), /<h1>SDF collision studies\.<\/h1>/);
});

test('the gear page calls its input a drive and says what drives it', () => {
  const html = read('sdf-gears.html');
  assert.match(html, /Drive speed <output id="speed-value">/);
  assert.match(html, /Only the gold gear is driven, kinematically: its angle is set each step, with no motor torque\./);
  assert.doesNotMatch(html, /Motor speed|has a motor/);
  // The original limits stay: contacts do the rest
  assert.match(html, /no gear-ratio constraint or scripted follower angles/);
  assert.match(html, /experimental collision demo, not a precision mechanical simulator/);
  // Status is a sentence, not capitals
  const source = read('src/sdf-gears/main.ts');
  assert.match(source, /\$\{paused \? 'Paused' : automatic \? 'Auto drive' : 'Manual drive'\}/);
  assert.doesNotMatch(source, /'PAUSED'|'AUTO'|'MANUAL'/);
});

/** Rules of a flat or media-nested style sheet whose declarations set a font size in px. */
function fontSizes(css: string): { selector: string; px: number }[] {
  const out: { selector: string; px: number }[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const d of body.matchAll(/(?:^|;)\s*(?:font-size|font)\s*:\s*(?:[\w-]+\s+)*?(\d+(?:\.\d+)?)px/g)) out.push({ selector: selector.trim(), px: Number(d[1]) });
  }
  return out;
}

test('SDF text a visitor reads is at least 12px; only the decorative eyebrows are 11px', () => {
  const decorative = /(^|[\s,])(\.eyebrow|header span|header>span)$/;
  for (const file of ['src/sdf-showcase/style.css', 'src/sdf-gears/style.css', 'src/sdf-released/style.css']) {
    const sizes = fontSizes(read(file));
    assert.ok(sizes.length > 0, `${file}: parsed font sizes`);
    for (const { selector, px } of sizes) {
      if (px >= 12) continue;
      assert.ok(px >= 11 && selector.split(',').every(s => decorative.test(s.trim())), `${file}: ${selector} is ${px}px`);
    }
  }
  // The parser sees the rules it should: the status output and the gear legend
  assert.ok(fontSizes(read('src/sdf-showcase/style.css')).some(s => s.selector === 'output' && s.px === 12));
  assert.ok(fontSizes(read('src/sdf-gears/style.css')).some(s => s.selector.includes('.legend') && s.px === 12));
});

test('the SDF pages take their font and link and focus colours from the shared tokens, and never ask for a font that is not loaded', () => {
  const tokens = read('src/ui/tokens.css');
  for (const name of ['--avbd-font-ui', '--avbd-font-mono', '--avbd-dark-link', '--avbd-dark-focus']) assert.match(tokens, new RegExp(`${name}:`));
  for (const file of ['src/sdf-showcase/style.css', 'src/sdf-gears/style.css']) {
    const css = read(file);
    assert.match(css, /@import '\.\.\/ui\/tokens\.css';/, file);
    assert.match(css, /font(-family)?:\s*(14px )?var\(--avbd-font-ui\)/, file);
    assert.match(css, /outline:2px solid var\(--avbd-dark-focus\)/, file);
    assert.doesNotMatch(css, /font(-family)?:[^;}]*\bInter\b/, `${file} asked for a font nothing loads`);
  }
  // sdf-released imports the shared sheet, so it gets the same tokens
  assert.match(read('src/sdf-released/main.ts'), /import '\.\.\/sdf-showcase\/style\.css';/);
  // Bounded panels scroll instead of growing over the scene
  assert.match(read('src/sdf-showcase/style.css'), /aside\{[^}]*max-height:calc\(100dvh - 96px\);overflow:auto/);
  assert.match(read('src/sdf-gears/style.css'), /aside\{[^}]*max-height:calc\(100dvh - 190px\);overflow:auto/);
});

test('the dark comparison pages declare they are dark, share one sheet with the tokens, and have usable controls', () => {
  const css = read('src/comparison/compare.css');
  assert.match(css, /@import '\.\.\/ui\/tokens\.css';/);
  assert.match(css, /:root\s*\{\s*color-scheme:\s*dark;/);
  assert.match(css, /button, select, input\[type=number\]\s*\{\s*min-height:\s*(2[4-9]|[3-9]\d)px/);
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--avbd-dark-focus\)/);
  for (const [page, title] of [['compare-side.html', 'Rapier and AVBD side by side'], ['compare-frame.html', 'Rendered workflow benchmark']] as const) {
    const html = read(page);
    assert.match(html, new RegExp(`<title>${title} · three-avbd</title>`), page);
    assert.match(html, /<link rel="stylesheet" href="\/src\/comparison\/compare\.css"/, page);
    assert.doesNotMatch(html, /<style>/, `${page}: no private colour scheme`);
    assert.match(html, /<h1><img src="\/favicon\.svg" width="24" height="24" alt="[^"]*" ?\/?>/, `${page}: brand mark`);
    assert.ok(anchors(html).some(l => l.href === '/examples/' && l.text === 'Demo gallery'), `${page}: Demo gallery`);
  }
});
