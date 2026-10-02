#!/usr/bin/env python3
"""Behaviour-tab fixes in a real page (sweep WB-01, WB-03, WB-06, WB-09, WB-10, F01).

Run:  PORT=8152 python3 serve.py   then   PORT=8152 python3 tests/browser/zmk-behaviour-fix.py
Totem and Imprint offline workspaces; no hardware (harness.py stubs navigator.hid/serial).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
    print(('ok   ' if cond else 'FAIL ') + msg)
    return cond


def go(page, tab):
    screen = page.locator('.maintab').filter(has_text=tab)
    if screen.count():
        screen.first.click()
    else:
        page.locator('.maintab').filter(has_text='Device' if tab == 'Gestures' else 'Behaviours').click()
        page.locator('.subtab').filter(has_text=tab).click()
    page.wait_for_timeout(500)


def main():
    with sync_playwright() as p:
        browser = H.launch(p)
        ctx, page, errors = H.new_context(browser, seeds=())
        H.open_workspace(page, 'TOTEM (ZMK)')

        # -- WB-01: Macros open first, Adaptive creates a text macro, Macros must see it
        go(page, 'Macros')
        check('0 of 32 slots in use' in page.locator('#panels .panel.active').inner_text(), 'macros start empty')
        go(page, 'Adaptive')
        page.locator('[data-set="3"] [data-act="add-rule"]').click()
        sheet = page.locator('.picker-sheet')
        check(sheet.count() == 1, 'trigger picker opens')
        check(sheet.locator('.bp-section h4', has_text='Modifiers').count() == 0, 'WB-10: trigger picker has no Modifiers key section')
        sheet.locator('.bp-key[aria-label="Q"]').first.click()
        page.locator('[data-draft="3"] input[data-draft-text]').fill('hello world')
        page.locator('[data-draft="3"] [data-act="draft-add"]').click()
        page.wait_for_timeout(800)
        check(page.locator('[data-set="3"] [data-rule]').count() == 1, 'rule added to set 3')
        go(page, 'Macros')
        check('1 of 32 slots in use' in page.locator('#panels .panel.active').inner_text(),
              'Macros tab shows the macro Adaptive created without a reload')
        page.locator('button', has_text='New macro').click()
        page.wait_for_timeout(400)
        cards = page.locator('#panels .panel.active [data-macro]')
        check(cards.count() == 2 and cards.last.get_attribute('data-macro') == '1', 'New macro takes slot 1')
        check('AK: hello world' in cards.first.inner_text(), 'slot 0 still names the adaptive macro')

        # -- WB-02: deleting the rule frees the macro
        go(page, 'Adaptive')
        page.locator('[data-set="3"] [data-rule] [data-act="delete"]').click()
        page.wait_for_timeout(1500)
        go(page, 'Macros')
        page.wait_for_timeout(300)
        check('0 of 32 slots in use' in page.locator('#panels .panel.active').inner_text(),
              'deleting the rule freed its text macro')

        # -- WB-03: one-shot modifier with no chip lit cannot be assigned
        go(page, 'Adaptive')
        page.locator('[data-set="3"] [data-fallback] button').first.click()
        sheet = page.locator('.picker-sheet')
        sheet.locator('.bp-groups .chip', has_text='Modifiers').click()
        row = sheet.locator('.bp-entry[data-entry="one-shot-mod"]')
        row.locator('.bp-mods-chip, .chip[title="Shift"]').first.click()
        check(row.locator('.bp-assign').is_disabled(), 'WB-03: Assign disabled with no modifier chosen')
        row.locator('.chip[title="Shift"]').first.click()
        check(not row.locator('.bp-assign').is_disabled(), 'Assign enabled again once a modifier is lit')
        # -- F01: no Tap dance / Adaptive key inside an adaptive fallback
        sheet.locator('.bp-groups .chip', has_text='Run').click()
        check(sheet.locator('.bp-entry[data-entry="tap-dance"]').count() == 0
              and sheet.locator('.bp-entry[data-entry="adaptive"]').count() == 0, 'F01: fallback picker offers neither Tap dance nor Adaptive key')
        page.keyboard.press('Escape')

        go(page, 'Tap Dance')
        page.locator('button', has_text='New tap dance').first.click()
        page.locator('.modal button', has_text='Create').click()
        page.wait_for_timeout(300)
        page.locator('[data-tap="0"]').first.click()
        sheet = page.locator('.picker-sheet')
        sheet.locator('.bp-groups .chip', has_text='Run').click()
        check(sheet.locator('.bp-entry[data-entry="adaptive"]').count() == 0, 'F01: no Adaptive key inside a tap dance')
        page.keyboard.press('Escape')

        # -- Imprint: WB-06 active set marks the channel, WB-09 gesture picker
        ctx2, page2, errors2 = H.new_context(browser, seeds=())
        H.open_workspace(page2, 'Cyboard Imprint (ZMK)')
        go(page2, 'Gestures')
        sel = page2.locator('#panels .panel.active select').first
        before = page2.locator('#save-btn').inner_text().strip()
        opts = page2.locator('#panels .panel.active select').first.locator('option').count()
        check(opts >= 1, 'active set dropdown present')
        # make a second set selectable first: assign a direction in set 1
        page2.locator('#panels .panel.active select').nth(1).select_option('1')
        page2.wait_for_timeout(300)
        page2.locator('#panels .panel.active button.code').first.click()
        sheet = page2.locator('.picker-sheet')
        sheet.locator('.bp-search').fill('a')
        sheet.locator('.bp-key[aria-label="A"]').first.click()
        page2.wait_for_timeout(500)
        page2.locator('#save-btn').click() if not page2.locator('#save-btn').is_disabled() else None
        page2.wait_for_timeout(500)
        check(page2.locator('#save-btn').is_disabled(), 'saved before the active-set change')
        sel = page2.locator('#panels .panel.active select').first
        sel.select_option(index=1)
        page2.wait_for_timeout(500)
        check('unsaved' in page2.locator('#save-btn').inner_text(), 'WB-06: changing the Active set marks the channel unsaved')

        errs = [e for e in errors + errors2]
        check(not errs, f'no page errors: {errs[:3]}')
        browser.close()
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
