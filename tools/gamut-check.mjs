// Which albedos in the palette survive ACES, and how much saturation each one has to
// give up to survive it.
//
// The problem this exists to stop being re-argued. The renderer tonemaps with
// ACESFilmicToneMapping, and ACES is not a curve — it is a change of primaries with a
// curve in the middle. Its output matrix (AP1 back to sRGB) has large negative
// off-diagonal terms:
//
//   r_out =  1.60475*r - 0.53108*g - 0.07367*b
//
// so for a colour where green dominates hard enough, r_out goes negative and `saturate()`
// clamps it to zero. The channel does not merely get dark, it gets *deleted*, and a
// surface with one channel deleted has no hue left to shade — that is the "neon green
// plastic" look. No lighting or shading parameter can undo it, because it happens after
// all of them.
//
// Measured, not theorised: the oak leaf albedo 0x4e7a30 renders with blue exactly 0 at
// every light level from a quarter to full, and the pine needle 0x2f5a3a renders
// [7,52,15] at half light, which is the [4,51,15] a gameplay screenshot actually
// measured. That agreement is why this tool is trusted to speak for the renderer.
//
// Two rounds of work were lost to reading that dark red channel as a lighting bug — first
// the cel shadow floor, then `shadowTint`, then a x2 albedo brightening. Brightening does
// move the value, and the values it produced were kept, but it cannot restore a clamped
// channel: at L=1.0 the pre-desaturation leaf is [74,133,0], still zero blue. Saturation
// was the fault the whole time.
//
//   node tools/gamut-check.mjs            # scan the palette in client/src/gfx/props.js
//   node tools/gamut-check.mjs 4e7a30 ..  # check specific hexes
//
// A colour is reported BAD when some channel clamps to 0 while another is well lit, i.e.
// the hue is being destroyed rather than the colour merely being dark. For each bad
// colour the tool solves for the least desaturation toward that colour's own luma that
// clears the gamut across the working range — least, because desaturating further than
// necessary is how a forest turns grey.
import fs from 'node:fs';
import path from 'node:path';

const IN  = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.13383], [0.02840, 0.01566, 0.83777]];
const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const fit = (v) => v.map((x) => {
  const a = x * (x + 0.0245786) - 0.000090537;
  const b = x * (0.983729 * x + 0.432951) + 0.238081;
  return a / b;
});
/** Exactly three.js's ACESFilmicToneMapping, including its exposure/0.6 pre-scale. */
const aces = (c, exposure = 1.0) =>
  mul(OUT, fit(mul(IN, c.map((x) => x * exposure / 0.6)))).map((x) => Math.min(1, Math.max(0, x)));
const s2l = (b) => { const s = b / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const l2s = (x) => Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
const hex2lin = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255].map(s2l);
const lin2hex = (c) => c.map(l2s).reduce((a, v) => (a << 8) | Math.min(255, Math.max(0, v)), 0);

// The lighting range a surface actually experiences in these scenes: cel band 1 in shade
// through full sun with the rim term adding on top. A colour only has to be in gamut over
// the range it is used in, so testing beyond this would over-desaturate the palette.
const LEVELS = [0.25, 0.5, 1.0, 1.5, 2.0];

/** Rec.709 luma in linear light — the axis to desaturate along if value is to be kept. */
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Mix `f` of the way from a colour to its own luma: same brightness, less saturation. */
const desat = (c, f) => { const y = luma(c); return c.map((x) => x + (y - x) * f); };

/**
 * Worst-case damage across the lighting range.
 *
 * `dead` is the real defect: a channel clamped to zero while the frame is plainly lit.
 * The gate on the brightest channel is what separates "this colour is out of gamut" from
 * "this sample is simply black", which no amount of desaturation would help.
 *
 * The gate is 16 rather than 8 because at 8 the tool reported three of Dragonspine's dark
 * cliff browns as damaged. They render [8,4,0] at the darkest level — a colour nobody can
 * distinguish from black, where a missing blue channel is not a visible fault and the 8 %
 * desaturation "fix" changes nothing anyone can see. A checker that flags things not worth
 * fixing gets ignored, which is worse than one that misses a marginal case.
 */
function damage(lin) {
  let dead = 0, worst = null;
  for (const L of LEVELS) {
    const out = aces(lin.map((x) => x * L)).map(l2s);
    const lit = Math.max(...out);
    const zeros = out.filter((v) => v === 0).length;
    if (zeros > 0 && lit >= 16) { dead++; if (!worst) worst = { L, out }; }
  }
  return { dead, worst };
}

/** Least desaturation (in 1 % steps) that clears the gamut over the whole range. */
function minFix(lin) {
  for (let f = 0; f <= 0.9; f += 0.01) {
    if (damage(desat(lin, f)).dead === 0) return f;
  }
  return null;
}

// `--tint RRGGBB` multiplies every colour by a tint before checking, which is the only way
// to see the defect that actually shipped. toon.js composes a cel shadow as
// `albedo * uShadowTint`, so the colour reaching the tonemap in shade is the *product*, and
// a product can be out of gamut when both factors are fine on their own. The foliage
// shadow tint 0x516e7a took needle albedos that this tool called `ok` and rendered them
// with red clamped to zero; four separate attempts to explain that as a lighting problem
// failed before anyone multiplied the two together.
//
//   node tools/gamut-check.mjs --tint 516e7a 437b51    # red clamped to zero
//   node tools/gamut-check.mjs --tint 646a73 437b51    # clears, in this model
//
// A warning about that second line, paid for in a wasted probe: it clears here and it did
// *not* clear on screen — the pine's red went from 3 to 4. `shadowCol` is only one of the
// albedo-proportional terms toon.js sums (it also adds sky ambient at 0.24 and ambient at
// 0.32), so a single tint is not the whole multiplier and this mode models only part of the
// expression. Treat a `--tint` verdict as "this factor is not the problem" when it is BAD,
// never as "fixed" when it is ok.
const argv = process.argv.slice(2);
let tint = null;
const ti = argv.indexOf('--tint');
if (ti >= 0) {
  tint = hex2lin(parseInt(argv[ti + 1].replace(/^0x/, ''), 16));
  argv.splice(ti, 2);
}
const applyTint = (lin) => (tint ? lin.map((x, i) => x * tint[i]) : lin);

let entries;
if (argv.length > 0) {
  entries = argv.map((h) => [h, parseInt(h.replace(/^0x/, ''), 16)]);
} else {
  // Scrape `name: () => once('name', () => someMat(0xRRGGBB` out of the palette. A regex
  // rather than an import because props.js pulls in three.js and a whole render stack.
  const src = fs.readFileSync(path.join(import.meta.dirname, '../client/src/gfx/props.js'), 'utf8');
  entries = [...src.matchAll(/once\('(\w+)',\s*\(\)\s*=>\s*\w+\(\s*(0x[0-9a-fA-F]{6})/g)]
    .map((m) => [m[1], parseInt(m[2], 16)]);
}

let bad = 0;
for (const [name, hex] of entries) {
  // The tint is folded in before every measurement, so `least fix` solves for the albedo
  // that survives *in shade*, which is the case that actually breaks.
  const lin = applyTint(hex2lin(hex));
  const { dead, worst } = damage(lin);
  const shots = LEVELS.map((L) => `${L}:[${aces(lin.map((x) => x * L)).map(l2s).join(',')}]`).join(' ');
  if (dead === 0) {
    console.log(`ok   ${name.padEnd(12)} #${hex.toString(16).padStart(6, '0')}  ${shots}`);
    continue;
  }
  bad++;
  const f = minFix(lin);
  const fixed = f === null ? null : lin2hex(desat(lin, f));
  console.log(`BAD  ${name.padEnd(12)} #${hex.toString(16).padStart(6, '0')}  ${shots}`);
  console.log(`     channel dead at ${dead}/${LEVELS.length} levels (worst L=${worst.L} -> [${worst.worst ?? worst.out}])`
    .replace('undefined', worst.out.join(',')));
  console.log(fixed === null
    ? '     no desaturation under 90 % clears it — pick a different hue'
    : `     least fix: desaturate ${(f * 100).toFixed(0)} % toward its own luma -> #${fixed.toString(16).padStart(6, '0')}`);
}
console.log(`\n${entries.length} colours, ${bad} out of gamut`);
process.exit(bad ? 1 : 0);
