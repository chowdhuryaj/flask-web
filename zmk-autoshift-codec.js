// flask_autoshift (channel 0x2C, proto v19, Totem) — pure helpers, no imports.
// Every wire value is a plain u16 (V.ash*); the firmware clamps on SET and
// echoes the applied value. Contract: .workflow/scratch/flask-autoshift-contract.md §2.

/** GROUPS bitmask (V.ashGroups). Bits 0-4; the firmware forces the rest to 0. */
export const ASH_GROUPS = { alpha: 1, numeric: 2, symbols: 4, tab: 8, enter: 16 };
export const ASH_GROUPS_MASK = 0x1F;

/** Firmware boot values: ships OFF, retro on with a 500 ms window. */
export const ASH_DEFAULTS = {
    enabled: 0, timeout: 175, groups: 0x0F, modifiers: 0, repeat: 0,
    noAutoRepeat: 0, retro: 1, retroLimit: 500,
};
export const ASH_TIMEOUT = { min: 50, max: 1000 };
export const ASH_RETRO_LIMIT = { min: 50, max: 5000 };   // 0 = no limit

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || 0));

export const clampAshTimeout = (v) => clamp(v, ASH_TIMEOUT.min, ASH_TIMEOUT.max);
/** 0 stays 0 (no limit); anything else lands in 50..5000. */
export const clampRetroLimit = (v) => (Math.round(Number(v)) > 0 ? clamp(v, ASH_RETRO_LIMIT.min, ASH_RETRO_LIMIT.max) : 0);
export const clampAshGroups = (v) => (Math.round(Number(v)) || 0) & ASH_GROUPS_MASK;
export const clampAshFlag = (v) => (Math.round(Number(v)) ? 1 : 0);

/** Group bit for a HID keyboard-page id, or 0. Ranges: contract §2. */
function groupOfId(id) {
    if (id >= 0x04 && id <= 0x1D) return ASH_GROUPS.alpha;
    if (id >= 0x1E && id <= 0x27) return ASH_GROUPS.numeric;
    if ((id >= 0x2D && id <= 0x38) || id === 0x64) return ASH_GROUPS.symbols;
    if (id === 0x2B) return ASH_GROUPS.tab;
    if (id === 0x28) return ASH_GROUPS.enter;
    return 0;
}

/** Would auto shift take this encoded usage (id 0-15, page 16-23, mods 24-31)?
 * Mods must be 0 (so LS(A) never), page 0 means 7, and the id's group must be on. */
export function ashEligible(usageEnc, groups) {
    const u = usageEnc >>> 0;
    if ((u >>> 24) !== 0) return false;
    const page = (u >>> 16) & 0xFF;
    if (page !== 0 && page !== 7) return false;
    return (groupOfId(u & 0xFFFF) & groups) !== 0;
}
