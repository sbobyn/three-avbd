// Private experimental metadata, NOT the published body/filter/contact ABI.
import { PRELUDE_3D } from './layout.ts';

export const SENSOR_PROOF_METADATA_VERSION = 1;
// Standard features use bits0..25 and STICK31. SDF uses bit26: never apply there.
export const STANDARD_SENSOR_BIT = 0x04000000;
export const sensorPreparationWGSL = /* wgsl */ `
${PRELUDE_3D}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> aux: array<vec4f>;
@group(0) @binding(3) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(4) var<storage, read> counters: array<u32>;
@group(0) @binding(5) var<storage, read_write> contacts: array<Contact>;

@compute @workgroup_size(64)
fn prepareSensors(@builtin(global_invocation_id) gid: vec3u) {
  let m = gid.x;
  if (m >= min(counters[C_MANIFOLDS], min(params.manifoldCapacity, arrayLength(&manifolds)))) { return; }
  let mf = manifolds[m];
  if (mf.ids.x >= params.bodyCount || mf.ids.y >= params.bodyCount ||
      mf.ids.x >= arrayLength(&bodies) || mf.ids.y >= arrayLength(&bodies) ||
      mf.ids.x >= arrayLength(&aux) || mf.ids.y >= arrayLength(&aux)) { return; }
  let cap = min(params.contactCapacity, arrayLength(&contacts));
  let count = pairCount(mf);
  if (count == 0u || mf.ids.z >= cap || count > cap - mf.ids.z) { return; }
  let sensor = aux[mf.ids.x].w == 1.0 || aux[mf.ids.y].w == 1.0;
  for (var c = mf.ids.z; c < mf.ids.z + count; c++) {
    if (sensor) {
      contacts[c].key = (contacts[c].key & ~STICK_BIT) | 0x04000000u;
      contacts[c].lam = vec3f(0.0);
      contacts[c].pen = vec3f(0.0);
    } else {
      contacts[c].key &= ~0x04000000u;
    }
  }
}
`;
