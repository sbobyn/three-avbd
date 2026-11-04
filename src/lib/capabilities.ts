/** Capabilities of a supplied device, using negotiated device limits, never adapter limits. */
export interface DeviceCapabilities {
  readonly maxStorageBuffersPerShaderStage: number;
  readonly standardHullCollisions: boolean;
}

/** CPU-only preflight; does not request a device or allocate GPU resources. */
export function deviceCapabilities(device: { readonly limits: Pick<GPUSupportedLimits, 'maxStorageBuffersPerShaderStage'> }): Readonly<DeviceCapabilities> {
  const maxStorageBuffersPerShaderStage = device.limits.maxStorageBuffersPerShaderStage;
  return Object.freeze({ maxStorageBuffersPerShaderStage, standardHullCollisions: maxStorageBuffersPerShaderStage >= 9 });
}

/** Immutable observation of the currently installed collision backend. Re-read after switching. */
export interface WorldCapabilities extends DeviceCapabilities {
  readonly bodyActivation: boolean;
  readonly bodyReset: boolean;
  /** BodyPool (three-avbd/pool): a fixed-storage World on built-in standard collisions. */
  readonly bodyPooling: boolean;
  readonly nativeSleeping: false;
  readonly lifecycleAbi: 1;
  readonly backend: 'standard' | 'sdf' | 'custom';
  /** Standard hull SAT only; SDF hull bodies require explicit fields. */
  readonly hullCollisions: 'native' | 'box-fallback' | 'explicit-sdf-field' | 'unknown';
  readonly boxes: boolean;
  readonly spheres: boolean;
  readonly sdfFields: boolean;
  readonly capsules: false;
  readonly compounds: false;
  readonly sensors: false;
}

/** @internal Pure backend decision, also used for CPU limit-boundary tests. */
export function worldCapabilities(device: DeviceCapabilities, backend: WorldCapabilities['backend'], hulls: boolean, customShaders = false, fixedStorage = false): Readonly<WorldCapabilities> {
  return Object.freeze({ ...device, backend,
    bodyActivation: backend === 'standard' && !customShaders, bodyReset: backend === 'standard' && !customShaders,
    bodyPooling: fixedStorage && backend === 'standard' && !customShaders, nativeSleeping: false, lifecycleAbi: 1,
    hullCollisions: backend === 'sdf' ? 'explicit-sdf-field' : backend === 'custom' ? 'unknown' : hulls ? 'native' : 'box-fallback',
    boxes: backend !== 'custom', spheres: backend !== 'custom', sdfFields: backend === 'sdf',
    capsules: false, compounds: false, sensors: false,
  });
}

/** @internal Run before renderer attributes or solver buffers are allocated. */
export function checkRequiredHulls(device: DeviceCapabilities, requireHulls = false): void {
  if (requireHulls && !device.standardHullCollisions) {
    throw new Error('World.create: requireHulls needs maxStorageBuffersPerShaderStage >= 9 on the supplied GPUDevice; request that limit when creating the renderer/device');
  }
}
