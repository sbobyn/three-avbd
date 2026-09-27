// three-avbd: GPU rigid-body physics for Three.js (WebGPU), on Augmented Vertex Block Descent
// (Giles, Diaz and Yuksel, SIGGRAPH 2025). See docs/API.md.

export { World, Body, Joint, recommendedLimits } from './world.ts';
export type { WorldOptions, BodyState, BodyOptions, BoxOptions, SphereOptions, HullOptions, RayHit, RaycastOptions, JointOptions, SpringOptions, ContactEvent, Vec3, Quat } from './world.ts';
export { BodyMesh, hullGeometry } from './mesh.ts';
export type { Ray } from './raycast.ts';
export { convexHull, type HullShape } from '../avbd3d/shapes.ts';
export type { BodyMeshOptions } from './mesh.ts';
