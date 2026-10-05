// three-avbd/advanced: below the World, for custom compute passes over the bodies (World.solver,
// its buffers and parameters) and the layout of the body and joint records. No stability
// promise while the package is 0.x.

export { GpuSolver3D, gpuParams3D, REF_UP } from '../avbd3d/gpu/solver.ts';
// What a GpuSolver3D is built from: a reference solver holding the starting bodies (z-up, as the
// paper's demo: set params.up after for y), and its bodies (boxes; spheres through `sphere`)
export { Solver } from '../avbd3d/ref/solver.ts';
export { Rigid } from '../avbd3d/ref/body.ts';
export { sphere, hull } from '../avbd3d/shapes.ts';
// Hull shapes for `hull` bodies (convexHull is also on the main entry)
export { convexHull, hullFromTriangles, MAX_HULL_VERTICES, type HullShape } from '../avbd3d/hull.ts';
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
// The contact records and solver counters a GpuSolver3D reads back (readContactList and
// readCounters decode them; these are for reading the raw buffers in your own readback)
export { CONTACT_WORDS, C_MANIFOLDS } from '../avbd3d/gpu/layout.ts';
export { C_PAIRS, C_CONTACTS, C_PREV_CONTACTS, C_OVERFLOW, C_CLASHES, C_NUM_COLORS, COUNTER_WORDS, NO_COLOR } from '../avbd2d/gpu/layout.ts';
