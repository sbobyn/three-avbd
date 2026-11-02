// three-avbd: GPU rigid-body physics for Three.js (WebGPU), on Augmented Vertex Block Descent
// (Giles, Diaz and Yuksel, SIGGRAPH 2025). See docs/API.md.

export { World, Body, Joint, recommendedLimits } from './world.ts';
export type { ReadResult, StepOptions, WorldOptions, SdfBodyBinding, BodyState, BodyOptions, BoxOptions, SphereOptions, HullOptions, RayHit, RaycastOptions, JointOptions, SpringOptions, ContactEvent, Vec3, Quat } from './world.ts';
export { BodyMesh, hullGeometry } from './mesh.ts';
export type { Ray } from './raycast.ts';
export { convexHull, type HullShape } from '../avbd3d/shapes.ts';
export type { BodyMeshOptions } from './mesh.ts';

export type { SdfBroadphaseOptions } from '../avbd3d/gpu/sdf-broadphase.ts';

export { deviceCapabilities } from './capabilities.ts';
export type { DeviceCapabilities, WorldCapabilities } from './capabilities.ts';

export { BodyLifecycleError, BodyDisabledError, UnsupportedLifecycleError } from './lifecycle.ts';

export { StorageCapacityError, StorageLimitError, STORAGE_FLOORS } from './storage-budget.ts';
export type { WorldStorageOptions, FixedStoragePlan, StorageResource } from './storage-budget.ts';
