#!/usr/bin/env python3
"""WP0 browser harness, and the shared helpers every tests/browser/<pkg>.py uses.

Run:  PORT=8139 python3 serve.py   (in the repo root)
      python3 tests/browser/harness.py      [FLASK_TEST_URL=http://127.0.0.1:8139/]

Hardware is never touched: navigator.hid and navigator.serial are replaced
before any page script runs, so requestDevice/requestPort throw and the
granted lists are empty. Workspaces are offline templates (TOTEM, Imprint,
Adept) plus the Svalboard snapshot fixture seeded into localStorage.

Checks: zero page errors and console errors while opening every tab, the
openPicker stub as sheet and popover, and each workspace's tab ids equal the pre-redesign
snapshot (tests/fixtures/tabs-before-wp0.json). Screenshots go to
tests/artifacts/harness/. Exit status is non-zero on any failure.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / 'Library/Python/3.14/lib/python/site-packages'))
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests' / 'fixtures'
URL = os.environ.get('FLASK_TEST_URL', f"http://127.0.0.1:{os.environ.get('PORT', '8139')}/")

# Runs before every page script. Seeds are written once per context so a
# reload keeps the page's own edits.
INIT_SCRIPT = """(seeds) => {
  for (const ws of seeds) {
    if (localStorage.getItem('flask-offline-' + ws.key) === null)
      localStorage.setItem('flask-offline-' + ws.key, JSON.stringify(ws));
  }
  const off = () => { throw new Error('Hardware disabled in tests'); };
  const stub = (get, req) => ({ [get]: async () => [], [req]: async () => off(),
    addEventListener() {}, removeEventListener() {} });
  Object.defineProperty(navigator, 'hid', { value: stub('getDevices', 'requestDevice') });
  Object.defineProperty(navigator, 'serial', { value: stub('getPorts', 'requestPort') });
}"""

SVAL = json.loads((FIXTURES / 'svalboard-snapshot.json').read_text())

# name → landing-list label, snapshot key (tabs-before-wp0.json)
WORKSPACES = {
    'totem': ('TOTEM (ZMK)', 'totem'),
    'imprint': ('Cyboard Imprint (ZMK)', 'imprint'),
    'adept': ('Ploopy Adept', 'adept'),
    'svalboard': (SVAL['label'], 'svalboard'),
}


def new_context(browser, viewport=(1440, 1000), seeds=(SVAL,)):
    """A context with hardware stubbed and the given workspaces seeded.
    Returns (context, page, errors); errors collects page errors and
    console errors."""
    ctx = browser.new_context(viewport={'width': viewport[0], 'height': viewport[1]},
                              accept_downloads=True)
    ctx.add_init_script(script=f'({INIT_SCRIPT})({json.dumps(list(seeds))})')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: m.type == 'error' and errors.append(f'console: {m.text}'))
    return ctx, page, errors


def open_workspace(page, label):
    """From the landing page, open the offline workspace whose button
    contains `label`, and wait for the first tab to finish rendering."""
    page.goto(URL)
    page.locator('#offline-list .dev-item').filter(has_text=label).first.click()
    page.locator('#panels .panel.active').wait_for()
    page.locator('#panels .panel.active .kb-svg .keycap').first.wait_for(timeout=10000)


def tab_ids(page):
    # WP1 added Device > Keyboard (spec 1.3); the snapshot predates it.
    ids = page.locator('#panels [data-panel]').evaluate_all('xs => xs.map(x => x.dataset.panel)')
    return [i for i in ids if i != 'keyboard']


def launch(p):
    return p.chromium.launch(channel='chrome', headless=True)


CONTRACT_SMOKE = """async (surface) => {
  const bp = await import('./binding-picker.js?v=1');
  await import('./behavior-catalog.js?v=1');
  const problems = [];
  for (const host of ['sheet', 'popover']) {
    const close = bp.openPicker({ surface, host, anchor: document.querySelector('.keycap'),
                                  title: 'WP0 smoke', onPick() {} });
    if (!document.querySelector(':is(.modal-back, .picker-popover) :is(.picker, .kp) button')) problems.push(host + ': no picker rendered');
    close(); close();
    if (document.querySelector('.modal-back, .picker-popover')) problems.push(host + ': close() left it open');
  }
  return problems;
}"""


def visit_all_tabs(page):
    """Open every group and every tab once, so each tab's load() runs."""
    for g in range(page.locator('.tab-groups button').count()):
        page.locator('.tab-groups button').nth(g).click()
        page.wait_for_timeout(250)
        row = page.locator('.tab-row button[data-tab]')
        for t in range(row.count()):
            row.nth(t).click()
            page.wait_for_timeout(250)


def contract_smoke(page, name):
    """openPicker stub opens and closes as sheet and popover on this line."""
    surface = 'zmk.key' if name in ('totem', 'imprint') else 'qmk.key'
    return page.evaluate(CONTRACT_SMOKE, surface)


def main():
    out = ROOT / 'tests' / 'artifacts' / 'harness'
    out.mkdir(parents=True, exist_ok=True)
    before = json.loads((FIXTURES / 'tabs-before-wp0.json').read_text())
    failures = []
    with sync_playwright() as p:
        browser = launch(p)
        for name, (label, snap) in WORKSPACES.items():
            ctx, page, errors = new_context(browser)
            try:
                open_workspace(page, label)
                ids = tab_ids(page)
                want = [t[0] for t in before[snap]]
                if ids != want:
                    failures.append(f'{name}: tabs {ids} != {want}')
                failures += [f'{name}: {m}' for m in contract_smoke(page, name)]
                visit_all_tabs(page)
                page.screenshot(path=str(out / f'{name}.png'), full_page=True)
            except Exception as e:  # noqa: BLE001 - report and continue
                failures.append(f'{name}: {e}')
            failures += [f'{name}: {e}' for e in errors]
            print(f"{name}: {'ok' if not errors else 'errors'} ({len(tab_ids(page))} tabs)")
            ctx.close()
        browser.close()
    for f in failures:
        print('FAIL', f)
    print('harness:', 'FAIL' if failures else f'PASS ({len(WORKSPACES)} workspaces)')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
