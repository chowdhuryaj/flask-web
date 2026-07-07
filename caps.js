// Capability gating: (family, protocol version) → visible features.
// Port of AdeptCompanion AppModel.swift has* props (lines ~270-350) — that
// file is the gating source of truth.
//
// Each firmware family versions its OWN Flask protocol line: Adept and
// Svalboard share one (v11 today), NLKB16-02 has its own (v8 today).
// A raw `version >= N` compare across families is WRONG — always gate here.

export function capabilities(family, version) {
    const v = version ?? 0;
    const flask = version != null && family !== 'generic';
    const trackball = family === 'adept' || family === 'svalboard';
    const nlkb = family === 'nlkb16';
    return {
        flask,
        // Mouse/pointing tuning — trackballs only.
        mouse: flask && trackball,
        gestures: flask && (family === 'adept' || (family === 'svalboard' && v >= 10)),
        wiggle: flask && trackball,
        autoMouse: flask && trackball && v >= 6,
        wheelChords: flask && trackball && v >= 6,
        // Typing modules (0x16-0x19): trackballs v4+, NLKB16 always.
        typing: flask && (nlkb || v >= 4),
        osShortcuts: flask && (nlkb || v >= 7),
        numWord: flask && (nlkb ? true : (family === 'svalboard' ? v >= 7 : v >= 10)),
        leaderTimeout: flask && nlkb && v >= 5,
        // Autoscroll (0x1A): trackballs v5+; NLKB16 v4+ (stepped only, no jog).
        autoscroll: flask && (nlkb ? v >= 4 : v >= 5),
        autoscrollJog: flask && trackball && v >= 5,
        autoscrollStopOnKey: flask && (nlkb ? v >= 4 : v >= 11),
        comboLayerMasks: flask && (nlkb || v >= 9),
        rgbMap: flask && nlkb,
        display: flask && nlkb,
        displayWidgets: flask && nlkb && v >= 3,
        bigDisplay: flask && nlkb && v >= 5,
        displayMirror: flask && nlkb && v >= 6,
        vialRGB: flask && nlkb,
        diag: flask && v >= (nlkb ? 1 : 7),
        // HUD live layer follow (meta 0x02): trackballs v10+, NLKB16 always.
        hudLayer: flask && (nlkb || v >= 10),
        // Raw CPI (0x14 cpi ids): v10+ trackballs.
        rawCpi: flask && trackball && v >= 10,
    };
}
