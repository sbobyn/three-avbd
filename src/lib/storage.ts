import type * as THREE from 'three/webgpu';

/** Renderer bridge, paired with World's eager backend allocation. Three r186 does not
 * observe BufferAttribute.dispose; r187 does. Keep its cache and memory accounting in sync
 * in either case, including attributes allocated before their first render. */
export function releaseStorageAttribute(renderer: THREE.WebGPURenderer, attribute: THREE.StorageInstancedBufferAttribute): void {
  attribute.dispose();
  const bridge = renderer as unknown as {
    _attributes: { delete(attribute: THREE.BufferAttribute): unknown };
    backend: {
      has(attribute: THREE.BufferAttribute): boolean;
      get(attribute: THREE.BufferAttribute): { buffer?: GPUBuffer };
      destroyAttribute(attribute: THREE.BufferAttribute): void;
    };
  };
  bridge._attributes.delete(attribute);
  // Eager World allocation precedes registration with the renderer's attribute manager.
  if (bridge.backend.has(attribute) && bridge.backend.get(attribute).buffer) bridge.backend.destroyAttribute(attribute);
}
