// Regenerates tests/fixtures/{totem,imprint}-behaviors.json from the offline
// Studio sim (zmk-offline.js), which is what the TOTEM / Imprint previews
// serve. TOTEM's list comes from zmk-totem-default.js (config/totem.keymap).
// Not a live-device dump: spec risk #2 says one AJ-run Studio dump per board
// should replace these before WP3 closes.
//   node tests/fixtures/gen-behaviors.mjs
import { writeFileSync } from 'node:fs';
import { createZmkTemplate, OfflineStudioClient } from '../../zmk-offline.js';

for (const family of ['totem', 'imprint']) {
    const sim = new OfflineStudioClient(createZmkTemplate(family));
    const behaviors = [];
    for (const id of await sim.listAllBehaviors()) behaviors.push(await sim.getBehaviorDetails(id));
    const out = { family, source: 'zmk-offline.js OfflineStudioClient (template)', behaviors };
    writeFileSync(new URL(`./${family}-behaviors.json`, import.meta.url), JSON.stringify(out, null, 1) + '\n');
    console.log(family, behaviors.length, 'behaviors,', behaviors.filter((b) => b.displayName).length, 'named');
}
