# Demo references and paired-study shortlist

Prepared 2026-11-09 against main `34a8f78a1da40a69ed839bec09e44c32e6194490`.
Owner: existing Three AVBD lead. Related: STE-3282 (paired studies), STE-3288
(gallery), STE-3003 (adoption/release). These are recommendations, not measured
rankings, approved new builds or claims of engine parity. No external engine was
installed or run for this review. Sources below are primary project/engine pages.

## Recommended order

| Study / proposed descriptive title | What a paired version would teach | Existing AVBD starting point / boundary | Source to inspect |
| --- | --- | --- | --- |
| **Interlocking Sculpture — contact without joints** | Open-shape representation, setup effort, push/reset, support and contact artifacts; compound sectors versus analytic SDF | Already implemented in both engines. Improve review and honest quality observations before timing; sparse poses do not certify solid topology | [Our paired protocol](PAIRED_STUDIES.md); [SDF paper/demo](https://savant117.github.io/sdf-dcd-demo/), a geometry-method reference rather than an identical ring scene |
| **Stack, Pull, Collapse — a small plank tower** | Stacking, friction, perturbation, settled jitter, solver settings and mass ratios | Reuse Stack/Pyramid/Stack Ratio and comparison stacks; start small. No sleeping or dense-scene speed guarantee | [NVIDIA PhysX Kapla tower presentation, GDC 2017](https://developer.download.nvidia.com/assets/gameworks/downloads/regular/GDC17/Game_Physics_on_the_GPU_with_PhysX3_GDC17_FINAL.pdf), historical PhysX3.4 example; [Rapier interactive demos](https://rapier.rs/demos/) |
| **Heavy Cargo Bridge — springs under load** | Joint stretch, stiff/soft interactions, mass ratios and iteration sensitivity; a useful game bridge | Reuse Bridge/Heavy Rope/Spring Ratio; public fixed/ball joints and springs. No native public hinge/angular-motor claim | [AVBD SIGGRAPH2025 project, browser demos and video](https://graphics.cs.utah.edu/research/projects/avbd/); [PhysX joint guide / SnippetJoint](https://nvidia-omniverse.github.io/PhysX/physx/5.3.0/docs/Joints.html) |
| **Bend, Remember, Break — a plastic sculpture** | Elastic versus permanent deformation, yield threshold, unloading and bend-triggered breakage; native feature versus application glue | Reuse Plastic Beam, `yieldForce` and `breakBend`; articulated rigid structure, not continuum material FEM. Rapier counterpart must disclose explicit extra plasticity logic | [AVBD paper and video](https://graphics.cs.utah.edu/research/projects/avbd/); [Epic breakable-constraint example 1.8](https://dev.epicgames.com/documentation/unreal-engine/physics-content-examples?application_version=4.27) is a related breaking example, not a claim of equivalent plasticity |
| **Gear Garden — driven shapes through contact** | Nonconvex contact geometry, kinematic drive, preprocessing and contact stability | Existing sdf-gear/sdf-gears; compare convex-compound and analytic/baked SDF representations at bounded speed. Do not imply a full motor/vehicle solver | [SDF collision research: gear stacks, distorted shapes and method controls](https://savant117.github.io/sdf-dcd-demo/); [reference implementation](https://github.com/savant117/sdf-dcd-demo) |
| **Friction Lab — hold, slide, settle** | Static/dynamic friction, slope/load thresholds, damping and timestep sensitivity | Reuse Static Friction/Dynamic Friction and slide comparison. Document SDF regularization drag; matching a friction coefficient does not match all contact behavior | [Rapier demos](https://rapier.rs/demos/); [PhysX stacking/friction best practices](https://nvidia-omniverse.github.io/PhysX/physx/5.3.0/docs/BestPractices.html) |
| **Wrecking Ball — a wall of breakable blocks** | Impulses, joint break thresholds, debris/contact handling, reset and event API ergonomics | Reuse Wall Smash/Breakable Wall; preassembled blocks and breakable joints. Runtime mesh fracture belongs to separate three-destruction integration, not this library demo | [AVBD original demos/video](https://graphics.cs.utah.edu/research/projects/avbd/); [Epic force/impulse and breakable-constraint content examples](https://dev.epicgames.com/documentation/unreal-engine/physics-content-examples?application_version=4.27) |
| **Hopper and Hollow Shapes — will it jam?** | Concavity, openings, geometry approximations, preprocessing and missed-contact cases | Small analytic cylinders/tori or existing released shapes first. Dense chair/bunny piles and the lost C4 experiment remain qualification/recovery work; avoid thin fast bodies without CCD | [SDF project and live reference demo](https://savant117.github.io/sdf-dcd-demo/), including funnel, chairs, bunnies and spike-contact scenes |

All rows after the existing interlocking study are proposals for matching/reusing
existing scenes, not a mandate to build eight new demos immediately. The recommended
next pair after user feedback is the **small plank tower**, then **Heavy Cargo Bridge**:
these add a conventional contact baseline and a joint/stiffness stress case before
more elaborate nonconvex or destruction content.

## Browse the original sources

- **Rapier:** [official browser demo selector](https://rapier.rs/demos/),
  [testbed controls and source-running guidance](https://www.rapier.rs/docs/user_guides/templates/the_rapier_testbed/).
  Its browser gallery currently warns that the whole WASM suite loads together.
  Reference the original scene/settings; our installed Rapier0.21 is not automatically
  the same version as the current official testbed.
- **PhysX:** [Kapla/GPU rigid-body presentation](https://developer.download.nvidia.com/assets/gameworks/downloads/regular/GDC17/Game_Physics_on_the_GPU_with_PhysX3_GDC17_FINAL.pdf),
  [joint samples and semantics](https://nvidia-omniverse.github.io/PhysX/physx/5.3.0/docs/Joints.html).
  These links are deliberately versioned/historical references, not current-platform
  benchmark targets. A small browser recreation is useful without installing PhysX.
- **Unreal/Epic:** [Physics Content Examples, UE4.27](https://dev.epicgames.com/documentation/unreal-engine/physics-content-examples?application_version=4.27)
  documents pickup/throw, radial impulses, constraints, motors and breakable constraints.
  Use as interaction inspiration. Public AVBD does not expose all of those constraint,
  ragdoll, motor or editor/asset systems. No Unreal installation/download is required
  to read the examples.
- **PositionBasedDynamics:** [maintainers' code, screenshots, videos and rigid-body joint feature list](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics).
  Useful mechanical-lab references; its hinge/slider/motor/rod/continuum/fluid support
  is broader than our public API. A library listing a feature is not proof that ours has it.
- **AVBD, SIGGRAPH2025:** [research project with paper, original2D/3D demos, code and video](https://graphics.cs.utah.edu/research/projects/avbd/).
  Source of stacked/frictional contact, hard constraints and stiffness-ratio studies.
  Paper results and guarantees must not be promoted to implementation/device claims.
- **SDF collision, Pacific Graphics2026:** [Real-Time Collision Handling for Signed Distance Fields via Caching and Importance Sampling](https://savant117.github.io/sdf-dcd-demo/),
  [live demo](https://savant117.github.io/sdf-dcd-demo/demo/) and
  [reference source](https://github.com/savant117/sdf-dcd-demo).
  This is **not a SIGGRAPH paper**. The original demo uses CPU collision optimization
  plus a sequential-impulse solver; our GPU AVBD bridge has different implementation
  and qualification boundaries. See existing reproduction documents.
- **VBD, SIGGRAPH2024:** [project, elastic-body examples, video and code](https://graphics.cs.utah.edu/research/projects/vbd/).
  Good longer-term inspiration for deformation and recovery. Current rigid-body
  joints/lattices must not be labelled equivalent to the paper's elastic-body solver.
  Full soft-body/FEM, fluid, cloth and vehicle reproductions need explicit scope and
  supported-API proposals; do not imply them from a gallery thumbnail.

## Comparison and media rules

Build Rapier first, then the AVBD counterpart with shared physical intent and
interactions. Disclose approximations, missing features and extra application code.
Agree quality before comparing time; equal iteration counts are not equal work or
accuracy. Record source/device/settings and separate setup, CPU physics/encoding,
GPU completion, transfer and rendering. Preserve failed trials and unknown results.

Use original explanatory SVG thumbnails or already-owned/source-qualified captures.
Label diagrams as illustrations; do not copy engine/paper screenshots, logos, video,
meshes or sample code merely because a public link exists. Check the exact asset/code
license before any later reuse. No private upload, paid generation or downloading
engine/sample packages is authorized by this research shortlist.

Source access limits: the web reader could read Rapier's demo landing page and
reference documentation, the SDF/AVBD/VBD project pages, PhysX documents and Epic's
versioned content examples. It did not operate those simulations, inspect their
hardware, or validate their performance. Some unversioned Epic/PhysX deep links and
the AVBD YouTube fetch failed/throttled; the working primary project links above
provide navigation. No broad benchmark or engine installation was performed.
