// three-avbd/advanced: below the World, for custom compute passes over the bodies (World.solver,
// its buffers and parameters) and the layout of the body and joint records. No stability
// promise while the package is 0.x.

export { GpuSolver3D, gpuParams3D, REF_UP } from '../avbd3d/gpu/solver.ts';
// What a GpuSolver3D is built from: a reference solver holding the starting bodies (z-up, as the
// paper's demo: set params.up after for y), and its bodies (boxes; spheres through `sphere`)
export { Solver } from '../avbd3d/ref/solver.ts';
export { Rigid } from '../avbd3d/ref/body.ts';
export { sphere } from '../avbd3d/shapes.ts';
export type { GpuParams3D, GpuSolverOptions, GpuCounters3D, GpuContact } from '../avbd3d/gpu/solver.ts';
export {
  BODY_FLOATS,
  B_POS,
  B_ROT,
  B_SIZE,
  B_VEL,
  B_ANGVEL,
  B_MOMENT,
  JOINT_FLOATS,
  J_PEN_LIN,
  J_PEN_ANG,
  J_LAM_LIN,
  J_LAM_ANG,
  J_RA,
  J_RB,
} from '../avbd3d/gpu/layout.ts';
