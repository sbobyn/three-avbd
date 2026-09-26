// three-avbd: GPU rigid-body physics for Three.js (WebGPU), on Augmented Vertex Block Descent
// (Giles, Diaz and Yuksel, SIGGRAPH 2025). See docs/API.md.

export { World, Body, Joint } from './world.ts';
export type { WorldOptions, BodyState, BodyOptions, BoxOptions, SphereOptions, JointOptions, Vec3, Quat } from './world.ts';
export { BodyMesh } from './mesh.ts';
export type { BodyMeshOptions } from './mesh.ts';
