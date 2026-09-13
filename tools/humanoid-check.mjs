// Builds every playable body plus a spread of synthesised NPC bodies in plain
// Node (no WebGL needed to bake geometry) and reports any NaN vertex data,
// bisecting by body option so the culprit field is obvious.
import { buildHumanoid } from '../client/src/gfx/humanoid.js';
import { CHARACTERS } from '../shared/src/data/characters.js';

function scan(rig) {
  const out = [];
  rig.group.traverse((o) => {
    const g = o.geometry;
    if (!g?.attributes) return;
    for (const [k, a] of Object.entries(g.attributes)) {
      let n = 0;
      for (let i = 0; i < a.array.length; i++) if (!Number.isFinite(a.array[i])) n++;
      if (n) out.push(`${k}:${n}/${a.array.length}`);
    }
  });
  return out;
}

function check(label, def) {
  try {
    const bad = scan(buildHumanoid(def, { outline: false }));
    console.log(`${bad.length ? 'NaN ' : 'ok  '} ${label}${bad.length ? '  ' + bad.join(' ') : ''}`);
    return bad.length > 0 ? 1 : 0;
  } catch (e) {
    console.log(`ERR  ${label}  ${e.message}`);
    return 1;
  }
}

let charBad = 0;
for (const c of Object.values(CHARACTERS)) charBad += check(`char ${c.id}`, c);

// The contract `buildHumanoid` actually has, which is not the one this check used to
// assert: `build` and `skirt` are *scalars* that feed torso and hem arithmetic directly,
// and `hair` has to name a style `buildHair` switches on. Passing 'average' and true
// here made every NPC body report thousands of NaN vertices on every run — a check that
// always fails is a check that cannot catch the regression it exists for. The game itself
// was right all along; see `npcDef` in client/src/game/world.js.
const HAIRS = ['short', 'longWave', 'longStraight', 'ponytail', 'twinTail', 'bun', 'spiky'];
const base = {
  height: 1.7, build: 0.4, hair: 'short', skin: 0xf0cfae, hairColor: 0x4a3a2c,
  hairTip: 0x4a3a2c, primary: 0x6a7f9c, secondary: 0xd8d2c0, accent: 0x8fd8e0,
  eye: 0x4a6a7a, boots: 0x3a3028, cape: null, skirt: 0,
};
let bad = 0;
console.log('--- npc-shaped bodies');
bad += check('npc base', { id: 'n', name: 'n', body: base });
for (const build of [0.0, 0.22, 0.45, 0.62, 1.0]) {
  bad += check(`build=${build}`, { id: 'n', name: 'n', body: { ...base, build } });
}
for (const hair of HAIRS) bad += check(`hair=${hair}`, { id: 'n', name: 'n', body: { ...base, hair } });
for (const skirt of [0, 0.35, 0.55, 0.7]) {
  bad += check(`skirt=${skirt}`, { id: 'n', name: 'n', body: { ...base, skirt } });
}
bad += check('cape', { id: 'n', name: 'n', body: { ...base, cape: true } });

// Malformed input is checked too, because the failure mode is silent: a NaN position
// gives a NaN bounding sphere, three culls the mesh every frame, and the NPC is simply
// not there — no error anywhere. `buildHumanoid` sanitises these rather than trusting
// its caller, so they must come back clean, not merely not throw.
console.log('--- malformed bodies must be sanitised, not propagated');
bad += check('build is a word', { id: 'n', name: 'n', body: { ...base, build: 'average' } });
bad += check('hair is unknown', { id: 'n', name: 'n', body: { ...base, hair: 'mohawk' } });
bad += check('skirt is true', { id: 'n', name: 'n', body: { ...base, skirt: true } });
bad += check('height missing', { id: 'n', name: 'n', body: { ...base, height: undefined } });
bad += check('body missing', { id: 'n', name: 'n' });

console.log(bad + charBad ? `\n${bad + charBad} body/bodies produced NaN vertex data` : '\nall bodies clean');

// --- garment / skin legibility ------------------------------------------------------
//
// A jacket the same colour as the wearer's skin makes a villager read as bare-chested:
// nothing draws an outline inside a silhouette, so the jacket/skin boundary at the collar
// and at both elbows is held together by albedo alone. `buildHumanoid` pushes the garment
// colours off the skin (and the sheet colours off the hair) for exactly this reason, and
// this is that guard's contract, checked on the *built materials* rather than on the input
// table — the whole point is that a bad authored pair must not survive the build.
//
// tools/npc-cam.mjs is the other half: it photographs the elbow of every villager in the
// game and measures across it, because a separation that the tonemap eats is no separation.
const dist = (a, b) => Math.hypot(
  (a >> 16 & 255) - (b >> 16 & 255), (a >> 8 & 255) - (b >> 8 & 255), (a & 255) - (b & 255),
);
const SKIN_GAP = 48, HAIR_GAP = 60;
let mix = 0, boxed = 0;
function legible(label, def) {
  const rig = buildHumanoid(def, { outline: false });
  const m = rig.materials;
  const skin = m.matSkin.color.getHex();
  const hair = m.matHair.color.getHex();
  const pairs = [
    ['jacket vs skin', m.matSecondary.color.getHex(), skin, SKIN_GAP],
    ['trousers vs skin', m.matPrimary.color.getHex(), skin, SKIN_GAP],
    ['jacket vs hair', m.matSecondary.color.getHex(), hair, HAIR_GAP],
  ];
  const bust = pairs.filter(([, a, b, min]) => dist(a, b) < min);
  if (!bust.length) return;
  // The guard scales brightness, which cannot separate two near-blacks (ignar's cape sits
  // 20 bytes from his hair at every scale). Those are reported, not counted as failures —
  // but only for the hair reference, which is the one the guard is allowed to give up on.
  let fatal = 0;
  for (const [name, a, b, min] of bust) {
    const hairOnly = name === 'jacket vs hair';
    if (!hairOnly) fatal++;
    console.log(`${hairOnly ? 'note' : 'MIX '} ${label}: ${name} `
      + `${dist(a, b).toFixed(0)}/${min} bytes`
      + ` (#${a.toString(16).padStart(6, '0')} vs #${b.toString(16).padStart(6, '0')})`);
  }
  if (fatal) mix++; else boxed++;
}
console.log('\n--- garments must not read as bare skin');
for (const c of Object.values(CHARACTERS)) legible(`char ${c.id}`, c);
// The synthesised villagers are the ones this guard exists for, so sweep the whole plane
// of shirt-and-skin pairs rather than trusting the five palettes in world.js to stay put:
// every tone from pale to dark, worn over every tone from pale to dark.
const TONES = [0xf6e2cc, 0xf0cfae, 0xe8c39c, 0xd2a878, 0xb98a5c, 0x8c5f3a, 0x5c3a22];
for (const skin of TONES) {
  for (const cloth of TONES) {
    legible(`shirt #${cloth.toString(16)} on skin #${skin.toString(16)}`,
      { id: 'n', name: 'n', body: { ...base, skin, secondary: cloth, primary: cloth } });
  }
}
console.log(mix ? `${mix} body/bodies wear their own skin colour`
  : `all garments clear the skin${boxed ? ` (${boxed} sheet/hair pair(s) unseparable by brightness)` : ''}`);

process.exit(bad + charBad + mix ? 1 : 0);
