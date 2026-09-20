// Skinned-mesh assembly shared by every rigged model (characters and enemies).
//
// The whole art pipeline here is "author rigid primitives in bone space, then
// bake them into one skinned geometry": it keeps the vertex count low, gives one
// draw call per material for a whole creature however many bones it has, and
// still deforms properly because each part is bound to the bone it belongs to
// with a narrow blend into the child bone at the joint.

import * as THREE from 'three';
import { bakeOcclusion } from './occlusion.js';

/**
 * Build a bone hierarchy from a `[name, parentName]` list and resolve its rest
 * pose. `place(bones)` positions/orients the bones; it runs before the Skeleton
 * is constructed because the constructor derives boneInverses from the resolved
 * world matrices, and before the bones are parented under any SkinnedMesh, so
 * every matrix stays in the model's own local space — the space geometry is
 * baked into.
 */
export function makeRig(boneList, place) {
  const bones = {};
  for (const [name, parent] of boneList) {
    const b = new THREE.Bone();
    b.name = name;
    bones[name] = b;
    if (parent) bones[parent].add(b);
  }
  place(bones);
  boneList[0] && bones[boneList[0][0]].updateMatrixWorld(true);
  const ordered = boneList.map(([n]) => bones[n]);
  const skeleton = new THREE.Skeleton(ordered);
  const bindWorld = {};
  for (const [n] of boneList) bindWorld[n] = bones[n].matrixWorld.clone();
  const boneIndexOf = (name) => ordered.indexOf(bones[name]);
  return { bones, skeleton, ordered, bindWorld, boneIndexOf };
}


/**
 * Bake a set of primitive geometries — each bound to one bone — into a single
 * skinned BufferGeometry.
 *
 * Vertices must end up in *bind space* (the skinned mesh's local space with the
 * skeleton in its rest pose), because the skinning shader evaluates
 * `boneMatrix * bindMatrix * position` and boneMatrix is identity at rest. So
 * each part's local geometry is pre-multiplied by its bone's rest world matrix.
 *
 * Rigid binding per part keeps the vertex count low and reads cleanly for this
 * art style; a narrow blend to the child bone near each joint stops elbows and
 * knees from tearing.
 */
// Where along a part the blend to the child bone starts (0 = the part's own
// joint, 1 = the child joint). Keeping it late means only the last ~quarter of a
// limb segment shares influence, so bends stay crisp instead of rubbery.
const JOINT_BLEND_START = 0.72;
export function bakeSkinned(parts, ordered, boneIndexOf, bindWorld, opts = {}) {
  // Collect materials in first-seen order, then walk the parts material by
  // material. One geometry group per material means one draw call per material
  // for the whole character instead of one per body part.
  const materials = [];
  const matMap = new Map();
  for (const part of parts) {
    if (matMap.has(part.mat)) continue;
    matMap.set(part.mat, materials.length);
    materials.push(part.mat);
  }
  const ordering = parts
    .map((part, i) => ({ part, i, mi: matMap.get(part.mat) }))
    .sort((a, b) => a.mi - b.mi || a.i - b.i);

  let total = 0;
  for (const part of parts) total += part.geo.attributes.position.count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const groups = [];
  const indices = [];

  let vOff = 0;
  let groupMat = -1;
  let groupStart = 0;

  for (const { part, mi } of ordering) {
    const g = part.geo;
    const count = g.attributes.position.count;
    if (mi !== groupMat) {
      if (groupMat >= 0) groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex: groupMat });
      groupMat = mi;
      groupStart = indices.length;
    }

    // Lift the part out of the space its matrix is authored in (its driving bone
    // by default) and into bind space. `parentBone` lets a part be positioned
    // relative to one bone but driven by another — used for hair, which is laid
    // out in head space but skinned to the springy hair bones.
    const space = part.parentBone ?? part.bone;
    const mat = bindWorld[space].clone().multiply(part.matrix ?? new THREE.Matrix4());
    const nMat = new THREE.Matrix3().getNormalMatrix(mat);

    const pAttr = g.attributes.position;
    const nAttr = g.attributes.normal;
    const bi = boneIndexOf(part.bone);
    const biSoft = part.softBone != null ? boneIndexOf(part.softBone) : bi;

    const v = new THREE.Vector3();
    const nv = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pAttr, i).applyMatrix4(mat);
      position[(vOff + i) * 3] = v.x;
      position[(vOff + i) * 3 + 1] = v.y;
      position[(vOff + i) * 3 + 2] = v.z;
      nv.fromBufferAttribute(nAttr, i).applyMatrix3(nMat).normalize();
      normal[(vOff + i) * 3] = nv.x;
      normal[(vOff + i) * 3 + 1] = nv.y;
      normal[(vOff + i) * 3 + 2] = nv.z;

      // Soft blend at the *distal* end of the part, where the child bone sits,
      // so elbows/knees/waist bend without tearing. Local Y runs from 0 at the
      // part's own joint to ±softLen at the child joint (sign depends on which
      // way the primitive was generated, hence the abs).
      let w = 1.0;
      if (part.softBone != null && part.softLen) {
        const t = THREE.MathUtils.clamp(Math.abs(pAttr.getY(i)) / part.softLen, 0, 1);
        const start = part.softStart ?? JOINT_BLEND_START;
        const amt = part.softMax ?? 0.5;      // how much influence the child takes
        w = 1 - amt * THREE.MathUtils.smoothstep(t, start, 1.0);
      }
      skinIndex[(vOff + i) * 4] = bi;
      skinIndex[(vOff + i) * 4 + 1] = biSoft;
      skinWeight[(vOff + i) * 4] = w;
      skinWeight[(vOff + i) * 4 + 1] = 1 - w;
    }

    const idx = g.index;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vOff);
    } else {
      for (let i = 0; i < count; i++) indices.push(i + vOff);
    }
    vOff += count;
  }
  if (groupMat >= 0) groups.push({ start: groupStart, count: indices.length - groupStart, materialIndex: groupMat });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  geo.setIndex(indices);
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  // Occlusion, baked in bind space while the whole body is in one array and in its rest pose —
  // which is the only pose it is ever whole in. The sun's shadow map cannot resolve anything on
  // a body's own scale (one texel is a third of a head diameter), so a jaw shades no neck and a
  // fringe shades no forehead unless it is baked; `occlusion.js` carries the measurements. The
  // rest pose is a lie for a raised arm, but the parts that matter — the jaw over the neck, the
  // hair over the scalp, a pauldron over a shoulder, the inside of a skirt — do not move
  // relative to each other, and the alternative is nothing at all.
  let occStats = null;
  if (opts.occlusion !== false) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const { occ, stats } = bakeOcclusion(position, normal, indices, opts.occlusion || {});
    geo.setAttribute('aRigOcc', new THREE.BufferAttribute(occ, 1));
    occStats = { ...stats, ms: Math.round((typeof performance !== 'undefined' ? performance : Date).now() - t0) };
  }
  return { geo, materials, occlusion: occStats };
}
