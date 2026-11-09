// When the released-scene page fits its camera to the scene. DOM-free so Node can test the policy the page uses.
// Reset, a change of contact settings and the reference-comparison toggle rebuild the same scene, and the viewer's
// orbit/zoom stays where they left it (as on the other pages); loading a different scene, or the first load, fits it.

export class FramingPolicy {
  #framed: number | null = null;

  /** True when the camera should be fitted to `scene`: nothing is fitted yet, or another scene is. */
  needsFraming(scene: number): boolean { return this.#framed !== scene; }

  /** Record that the camera now frames `scene`. Call it only after the fit happened: a load that failed first fits nothing. */
  markFramed(scene: number): void { this.#framed = scene; }
}
