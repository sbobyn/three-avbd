// A module worker that runs SDF bakes off the main thread (used by sdf-from-mesh.ts).
// Installed projects import this from 'three-avbd/sdf'.
import { installSdfWorker, type SdfWorkerScope } from '../src/lib/sdf.ts';
// The cast is only needed because this project type-checks with DOM (not WebWorker) typings.
installSdfWorker(self as unknown as SdfWorkerScope);
