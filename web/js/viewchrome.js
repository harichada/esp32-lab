/* Header view chip + who may open 3D.
 * The chip is a status ("you are in this view") and, off the 2D editor, the
 * always-reachable control that returns there. It is not a second mode toggle. */
(function (root) {
  function viewChipState(mode, opts) {
    const compact = !!(opts && opts.compact);
    if (mode === '3d') {
      const aria = 'Current view: 3D. Click to return to the 2D editor';
      return { text: compact ? '3D · ↩' : '3D · ↩ 2D', title: aria, aria: aria };
    }
    if (mode === 'schematic') {
      const aria = 'Current view: schematic. Click to return to the 2D editor';
      return { text: compact ? 'Sch · ↩' : 'Schematic · ↩ 2D', title: aria, aria: aria };
    }
    const aria = 'Current view: 2D editor';
    return { text: compact ? '2D' : 'View · 2D', title: aria, aria: aria };
  }

  // Touch-first phones stay on the 2D hotfix. A narrow desktop window (phone width,
  // fine pointer) may open 3D so the scene can frame itself to that viewport.
  function blocks3d(env) {
    env = env || {};
    const touchOnly = !!(env.coarse && !env.fine);
    return !!(touchOnly || env.touchUA);
  }

  root.ViewChrome = { viewChipState: viewChipState, blocks3d: blocks3d };
})(typeof window !== 'undefined' ? window : globalThis);
