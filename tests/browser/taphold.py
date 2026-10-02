#!/usr/bin/env python3
"""WP3b Tap/Hold composer checks. Offline workspaces only; no hardware.

Run:  PORT=8153 python3 serve.py   then   PORT=8153 python3 tests/browser/taphold.py

TOTEM: select F, "Make this a tap-hold", HOLD ⇧, Apply: the cap shows a
labelled hold line (⇧) and tap line (F), the binding is Hold-Tap L (live)
(F is a left-hand key); click again opens the composer pre-filled; undo
restores plain F. Home-row mods preset: 8 keys in one step, one undo.
Screenshots: tests/artifacts/taphold/ and $WP3B_SHOTS (wp3b-*.png).
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import ROOT, launch, new_context, open_workspace, sync_playwright  # noqa: E402

OUT = ROOT / 'tests' / 'artifacts' / 'taphold'
SHOTS = os.environ.get('WP3B_SHOTS')
failures = []


def check(cond, msg):
    print('ok  ' if cond else 'FAIL', msg)
    if not cond:
        failures.append(msg)


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
    if SHOTS:
        page.screenshot(path=str(Path(SHOTS) / f'wp3b-{name}.png'), full_page=True)


KEY_INDEX = """(cap) => [...document.querySelectorAll('#board-slot .kb-svg g.key')]
    .findIndex(g => [...g.querySelectorAll('.cap-main')].map(t => t.textContent).join('') === cap)"""
BINDING = """async (pos) => {
  const { board } = await import('/board.js?v=61');
  const C = await import('/behavior-catalog.js?v=61');
  const v = board.bindingOf(pos ?? undefined);
  return { v, d: C.describeBinding(v, board.adapter.profile.capAdapter ?? 'zmk-studio'),
           via: v && typeof v === 'object' ? (await import('/zmk-keycodes.js?v=61')).zmkBehaviors().get(v.behaviorId)?.displayName : null };
}"""


def keys(page):
    return page.locator('#board-slot .kb-svg g.key')


def picker(page):
    return page.locator('#panels .panel.active .bp[data-host="docked"]').first


def make_taphold(page, cap, label):
    i = page.evaluate(KEY_INDEX, cap)
    check(i >= 0, f'{label}: a key reads {cap}')
    g = keys(page).nth(i)
    g.click()
    pos = page.evaluate("async () => (await import('/board.js?v=61')).board.selectedKey().pos")
    bp = picker(page)
    bp.locator('[data-act="taphold"]').click()
    check(bp.locator('[data-composer]').count() == 1, f'{label}: composer opens')
    tap = bp.locator('.bp-th-slot[data-slot="tap"] .bp-th-value').text_content()
    check(tap == cap, f'{label}: TAP keeps the current key ({tap})')
    check(bp.locator('.bp-th-slot[data-slot="hold"].on').count() == 1, f'{label}: composer asks for HOLD')
    bp.locator('[data-mod="⇧"]').click()
    shot(page, f'{label}-composer')
    check(not bp.locator('[data-act="th-apply"]').is_disabled(), f'{label}: Apply enabled')
    bp.locator('[data-act="th-apply"]').click()
    page.wait_for_timeout(200)
    return i, pos


def assert_labelled(page, i, cap, label):
    g = keys(page).nth(i)
    hold = g.locator('.cap-hold')
    check(g.locator('.cap-holdband').count() == 1, f'{label}: cap has the HOLD band')
    check(hold.count() == 1 and '⇧' in hold.text_content() and 'hold' in hold.text_content().lower(),
          f'{label}: hold line "{hold.text_content() if hold.count() else None}"')
    tap = g.locator('.cap-tap')
    check(tap.count() == 1 and tap.text_content().lower().startswith('tap') and tap.text_content().endswith(cap),
          f'{label}: tap line "{tap.text_content() if tap.count() else None}"')


def totem(browser):
    ctx, page, errors = new_context(browser)
    open_workspace(page, 'TOTEM (ZMK)')
    i, pos = make_taphold(page, 'F', 'totem')
    b = page.evaluate(BINDING, pos)
    check(b['via'] == 'Hold-Tap L (live)', f'totem: F (left hand) uses &fht_l: {b}')
    assert_labelled(page, i, 'F', 'totem')
    shot(page, 'totem-cap')
    # click the key twice: popover opens the composer pre-filled
    keys(page).nth(i).click()
    keys(page).nth(i).click()
    pop = page.locator('.picker-popover')
    pop.wait_for(timeout=3000)
    check(pop.locator('[data-composer]').count() == 1, 'totem: editing a mod-tap opens the composer')
    check(pop.locator('.bp-th-slot[data-slot="hold"] .bp-th-value').text_content() == '⇧', 'totem: HOLD pre-filled ⇧')
    check(pop.locator('.bp-th-slot[data-slot="tap"] .bp-th-value').text_content() == 'F', 'totem: TAP pre-filled F')
    shot(page, 'totem-prefilled')
    # WP7 item 10: the offline sim serves 0x2A, so the composer's live
    # tapping-term slider shows (no mock) and Apply writes the key's slot.
    slider = pop.locator('.bp-timing input[type=range]')
    check(slider.count() == 1, 'totem: composer shows the live timing slider offline')
    if slider.count():
        slider.evaluate('(s) => { s.value = 330; s.dispatchEvent(new Event("input")); }')
        pop.locator('[data-act="th-apply"]').click()
        page.wait_for_timeout(400)
        term = page.evaluate(f"JSON.parse(localStorage.getItem('flask-offline-totem')).zmk.holdtap[{pos}].term")
        check(term == 330, f'totem: composer slider wrote slot {pos} term {term}')
        dirty = page.evaluate("async () => (await import('/save-state.js?v=61')).saveState.dirty().map(d => d.label)")
        check('Hold-tap timing' in dirty, f'totem: timing edit is in the one Save: {dirty}')
        page.evaluate("async () => (await import('/board.js?v=61')).board.undo()")
        page.wait_for_timeout(200)
    else:
        page.keyboard.press('Escape')
    page.evaluate("async () => (await import('/board.js?v=61')).board.undo()")
    page.wait_for_timeout(200)
    g = keys(page).nth(i)
    check(g.locator('.cap-holdband').count() == 0 and g.locator('.cap-main').text_content() == 'F', 'totem: undo restores plain F')

    # rotated thumbs keep their labels (the default keymap has live hold-taps there)
    thumbs = page.evaluate("""() => [...document.querySelectorAll('#board-slot .kb-svg g.key.ht')]
        .filter(g => g.getAttribute('transform')).length""")
    check(thumbs > 0, f'totem: {thumbs} rotated thumb caps draw hold/tap labels')

    # home-row mods preset
    keys(page).nth(i).click()
    bp = picker(page)
    bp.locator('[data-act="taphold"]').click()
    bp.locator('[data-act="hrm"]').click()
    picked = page.locator('#board-slot .kb-svg .keycap.picked').count()
    check(picked == 8, f'totem: home row pre-picked ({picked})')
    bp.locator('[data-order="GACS"]').click()
    shot(page, 'totem-homerow-pick')
    check(not bp.locator('[data-act="hrm-apply"]').is_disabled(), 'totem: preset Apply enabled')
    bp.locator('[data-act="hrm-apply"]').click()
    page.wait_for_timeout(400)
    ht = page.locator('#board-slot .kb-svg g.key.ht .cap-hold').evaluate_all('xs => xs.map(x => x.textContent)')
    check(sum(1 for t in ht if any(m in t for m in '⌘⌥⌃⇧')) >= 8 and not any('live' in t for t in ht), f'totem: home-row caps {ht}')
    shot(page, 'totem-homerow')
    idx = page.evaluate("[...document.querySelectorAll('#board-slot .kb-svg g.key')].findIndex((g) => g.classList.contains('ht'))")
    cell = page.evaluate("""async (i) => { const bp = await import('/binding-picker.js?v=61');
      const { board } = await import('/board.js?v=61');
      const el = bp.renderBindingCell(board.bindingOf(i), 'zmk.key');
      return [el.querySelector('.bp-cell-hold') != null, el.querySelector('.bp-cell-tap') != null]; }""", idx)
    check(idx >= 0 and cell == [True, True], f'totem: renderBindingCell labels hold/tap: {cell}')
    page.evaluate("async () => (await import('/board.js?v=61')).board.undo()")
    page.wait_for_timeout(300)
    check(page.evaluate(KEY_INDEX, 'F') >= 0, 'totem: one undo reverts the preset')
    check(not errors, f'totem: no page errors {errors}')
    ctx.close()


def main():
    with sync_playwright() as p:
        browser = launch(p)
        for fn in (totem,):
            try:
                fn(browser)
            except Exception as e:  # noqa: BLE001
                failures.append(f'{fn.__name__}: {e}')
                print('FAIL', fn.__name__, e)
        browser.close()
    print('taphold:', 'FAIL' if failures else 'PASS')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
