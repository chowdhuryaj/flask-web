#!/usr/bin/env python3
"""WP4a browser checks: ZMK Behaviour tabs on the TOTEM offline workspace.

Run:  PORT=8151 python3 serve.py   then   PORT=8151 python3 tests/browser/zmk-behaviour.py
No hardware: harness.py stubs navigator.hid / serial. Screenshots go to
tests/artifacts/zmk-behaviour/ and, with WP4A_SHOTS=dir, to that dir too.

Covers: duplicate combo refusal (R+F = positions 3+13 = slot 7), button blur,
new combo via board picking, the Hold timing card (slot 33 -> SAVE dirty),
and the picker surfaces (leader: no Layers, CSK base: no mods row, TD row:
Mod-tap). Imprint: gesture direction picker offers Run > Macro, not Tap dance.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = H.ROOT / 'tests' / 'artifacts' / 'zmk-behaviour'
SHOTS = Path(os.environ['WP4A_SHOTS']) if os.environ.get('WP4A_SHOTS') else None
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    return cond


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(OUT / f'{name}.png'))
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f'wp4a-{name}.png'))


def go(page, group, tab):
    page.locator('.tab-groups button').filter(has_text=group).click()
    page.locator('.tab-row button[data-tab]').filter(has_text=tab).click()
    page.wait_for_timeout(500)


def key(page, pos):
    return page.locator(f'.kb-svg g.key[aria-label^="Key {pos} "]').first


def save_text(page):
    seg = page.locator('#save-seg')
    return seg.inner_text().strip() if seg.is_visible() else ''


def ws(page, name):
    return json.loads(page.evaluate(f"localStorage.getItem('flask-offline-{name}')"))


def combo_cards(page):
    return page.locator('#panels .panel.active [data-combo]')


def main():
    with sync_playwright() as p:
        browser = H.launch(p)
        ctx, page, errors = H.new_context(browser, seeds=())
        H.open_workspace(page, 'TOTEM (ZMK)')
        go(page, 'Behaviour', 'Combos')

        # -- the seeded table: R+F (3+13) is slot 7, Enter
        slot7 = page.locator('[data-combo="7"]')
        check('3 + 13' in slot7.inner_text(), 'slot 7 reads 3 + 13')
        # -- hold-tap outputs (combos z / x: Layer-Tap ... combo) draw labelled HOLD and TAP parts
        ht = page.locator('#panels .panel.active [data-combo] [data-act="output"] .bp-cell.ht')
        check(ht.count() >= 2, f'hold-tap combo outputs use renderBindingCell, got {ht.count()}')
        if ht.count():
            t = ht.first.inner_text().lower()
            check('hold' in t and 'tap' in t, f'hold-tap cell names both parts: {t!r}')

        # -- duplicate refusal: new combo, pick 3 then 13 on the board
        page.locator('[data-act="new"]').click()
        check(page.locator('.bd-banner').count() == 1, 'board enters pick mode for the new combo')
        check('Pick keys for Combo' in page.locator('.bd-banner').inner_text(), 'pick-mode banner names the combo')
        shot(page, 'combos-pick-mode')
        key(page, 3).click()
        key(page, 13).click()
        page.wait_for_timeout(300)
        warn = page.locator('[data-warn]')
        check(warn.count() == 1 and 'Same keys as Combo 7' in warn.first.inner_text(), 'duplicate 3+13 shows the refusal')
        shot(page, 'combos-duplicate-refused')
        now = ws(page, 'totem')['zmk']['combos']
        dups = [c for c in now if sorted(c['positions']) == [3, 13] and c['action']]
        check(len(dups) == 1, f'only one live 3+13 combo reached the device, got {len(dups)}')
        # the board's pick state was rolled back: 3 alone remains picked
        check(page.locator('.kb-svg .keycap.picked').count() == 1, 'board pick set reverted to the first key')
        # Done leaves pick mode; the draft stays incomplete
        page.locator('.bd-banner button', has_text='Done').click()
        # the abandoned 1-key draft (key 3) never reached the device
        page.wait_for_timeout(200)
        ones = [c for c in ws(page, 'totem')['zmk']['combos'] if len([p for p in c['positions'] if p is not None]) == 1]
        check(not ones, f'abandoned draft left a 1-key slot on the device: {ones}')

        # -- a new valid combo: 20 + 21 -> Esc, and the one Save counts it
        page.locator('[data-act="new"]').click()
        key(page, 20).click()
        key(page, 21).click()
        page.wait_for_timeout(300)
        newest = combo_cards(page).last
        newest.locator('[data-act="output"]').click()
        sheet = page.locator('.picker-sheet')
        check(sheet.count() == 1, 'output opens the shared picker sheet')
        check(sheet.locator('h2').inner_text().startswith('Combo'), 'sheet title names the combo')
        sheet.locator('.bp-search').fill('esc')
        sheet.locator('.bp-key[aria-label="Escape"]').first.click()
        page.wait_for_timeout(400)
        check(page.locator('.picker-sheet').count() == 0, 'sheet closes on pick')
        newest = combo_cards(page).last
        check('20 + 21 → Esc' in newest.inner_text(), f'row reads "20 + 21 → Esc": {newest.inner_text()[:60]!r}')
        check(save_text(page).startswith('Save 1 unsaved') or '1 unsaved' in save_text(page), f'status bar: {save_text(page)!r}')
        shot(page, 'combos-new-row')

        # -- buttons give up focus after a click (a key-made Enter must not re-fire them)
        page.locator('[data-act="new"]').focus()
        page.locator('[data-act="new"]').click()
        check(page.evaluate("document.activeElement?.tagName") != 'BUTTON', 'New combo button blurred after click')
        page.locator('.bd-banner button', has_text='Done').click()
        page.locator('#panels .panel.active button', has_text='Reload from device').first.click()
        page.wait_for_timeout(300)
        check(page.evaluate("document.activeElement?.tagName") != 'BUTTON', 'Reload button blurred after click')

        # -- Hold timing: its own Behaviour tab (WP7), no longer under Combos
        check(page.locator('[data-panel="zmk-combos"] [data-card="hold-timing"]').count() == 0, 'Hold timing card left the Combos tab')
        go(page, 'Behaviour', 'Hold timing')
        card = page.locator('[data-panel="zmk-holdtiming"] [data-card="hold-timing"]')
        card.wait_for(timeout=5000)
        check(card.count() == 1, 'Hold timing tab present on Totem (proto 17, 0x2A answers)')
        card.scroll_into_view_if_needed()
        names = card.locator('.row .lbl').all_inner_texts()
        check('Control combo (32+33)' in names and 'Sym autoshift digits' in names, f'virtual slots labelled from SLOT_INFO: {names}')
        check(card.locator('[data-slot]').count() == 44, f"44 slot rows, got {card.locator('[data-slot]').count()}")
        check(card.locator('[data-slot="33"] button').first.inner_text().startswith('Key 33'), 'key slot links to its board key')
        # Virtual-slot sliders and a key slider
        row = card.locator('[data-slot="33"]')
        row.locator('input[type=range]').evaluate(
            "(el) => { el.value = 330; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); }")
        page.wait_for_timeout(400)
        check(ws(page, 'totem')['zmk']['holdtap'][33]['term'] == 330, 'slot 33 term written to the sim')
        check('unsaved' in save_text(page), f'status bar SAVE dirty after slot 33: {save_text(page)!r}')
        check('Hold-tap timing' in page.evaluate("import('./save-state.js?v=60').then(m => m.saveState.dirty().map(d => d.label).join('|'))"), 'Hold-tap timing is a registered source')
        row.locator('select').select_option('2')
        page.wait_for_timeout(300)
        check(ws(page, 'totem')['zmk']['holdtap'][33]['flavor'] == 2, 'flavor written')
        check(ws(page, 'totem')['zmk']['holdtap'][33]['term'] == 330, 'flavor write kept the term')
        shot(page, 'hold-timing')

        # -- other Totem tabs: pickers
        go(page, 'Behaviour', 'Leader')
        page.locator('[data-act], button', has_text='＋ New sequence').first.click()
        # a sequence may repeat a key (a, a): the 2nd click appends, never toggles off
        key(page, 3).click()
        key(page, 3).click()
        page.wait_for_timeout(300)
        chips = page.locator('[data-seq]').last.locator('button', has_text='pos 3')
        check(chips.count() == 2, f'leader pick mode allows a repeated key, got {chips.count()} chips')
        check('2 picked' in page.locator('.bd-banner').inner_text() or '2 of' in page.locator('.bd-banner').inner_text(), 'banner counts the repeat')
        page.locator('.bd-banner button', has_text='Done').click()
        page.locator('[data-seq] button', has_text='Choose output').first.click()
        sheet = page.locator('.picker-sheet')
        groups = sheet.locator('.bp-groups .chip').all_inner_texts()
        check('Layers' not in groups, f'leader output has no Layers group: {groups}')
        check(sheet.locator('.bp-entry[data-entry="tap-dance"]').count() == 0, 'leader output has no tap dance')
        check('compiled leader' in page.locator('#panels .panel.active').inner_text(), 'compiled-leader note is shown')
        shot(page, 'leader-output-picker')
        page.keyboard.press('Escape')

        go(page, 'Behaviour', 'Shift Keys')
        page.locator('button', has_text='＋ New pair').first.click()
        page.locator('[data-card], .card button.code', has_text='base key').first.click()
        sheet = page.locator('.picker-sheet')
        check(sheet.count() == 1, 'CSK base opens the picker sheet')
        check(sheet.locator('.bp-mods, [aria-label="Held with the key"]').count() == 0
              and 'Held with the key' not in sheet.inner_text(), 'CSK base picker shows no mods row')
        page.keyboard.press('Escape')

        go(page, 'Behaviour', 'Tap Dance')
        page.locator('button', has_text='New tap dance').first.click()
        page.locator('.modal button', has_text='Create').click()
        page.wait_for_timeout(300)
        page.locator('[data-tap="1"]').first.click()
        sheet = page.locator('.picker-sheet')
        sheet.locator('.bp-groups .chip', has_text='Modifiers').click()
        check(sheet.locator('.bp-entry[data-entry="mod-tap"]').count() == 1, '2 taps row offers Modifiers > Mod-tap')
        check(sheet.locator('.bp-entry[data-entry="tap-dance"]').count() == 0, 'no tap dance inside a tap dance')
        shot(page, 'tapdance-step-picker')
        page.keyboard.press('Escape')
        check(not errors, f'page errors: {errors}')
        ctx.close()

        # -- Imprint: gesture direction picker
        ctx, page, errors = H.new_context(browser, seeds=())
        H.open_workspace(page, 'Cyboard Imprint (ZMK)')
        check(page.locator('#panels [data-panel="zmk-holdtiming"]').count() == 0, 'no Hold timing tab on Imprint (0x2A answers 0xFF)')
        page.locator('.tab-groups button').filter(has_text='Device').click()
        page.locator('.tab-row button[data-tab]').filter(has_text='Gestures').click()
        page.wait_for_timeout(500)
        page.locator('.card button.code').first.click()
        sheet = page.locator('.picker-sheet')
        sheet.locator('.bp-groups .chip', has_text='Run').click()
        run = sheet.locator('.bp-entry').evaluate_all('xs => xs.map(x => x.dataset.entry)')
        check(run == ['macro'], f'gesture direction picker Run entries {run}')
        shot(page, 'gesture-picker')
        check(not errors, f'imprint page errors: {errors}')
        ctx.close()
        browser.close()
    for f in fails:
        print('FAIL', f)
    print('zmk-behaviour:', 'PASS' if not fails else f'{len(fails)} failures')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
