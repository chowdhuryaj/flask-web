import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || '/Users/aj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
import fs from 'node:fs/promises';import {execFileSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url)),root=dirname(here),dir=process.env.FLASK_THEME_ARTIFACTS || join(here,'artifacts/layout-studio'),url=process.env.FLASK_TEST_URL || 'http://127.0.0.1:8140/';
await fs.mkdir(dir,{recursive:true});
const fixture=JSON.parse(await fs.readFile(join(here,'fixtures/layout-studio-svalboard.json'),'utf8'));const baseline=JSON.parse(await fs.readFile(join(here,'fixtures/layout-studio-baseline.json'),'utf8'));
const oldCss=execFileSync('git',['show','d0b34f4:styles.css'],{cwd:root,encoding:'utf8'}),oldMain=execFileSync('git',['show','d0b34f4:main.js'],{cwd:root,encoding:'utf8'});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const errors=[];let checks=0;
function eq(a,b,msg){checks++;if(JSON.stringify(a)!==JSON.stringify(b))throw Error(msg+'\n'+JSON.stringify(a)+'\n'+JSON.stringify(b));}
async function open(viewport,legacy=false,colorScheme='light'){
 const context=await browser.newContext({viewport,colorScheme,acceptDownloads:true});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(f=>{if(localStorage.getItem('flask-offline-'+f.key)===null)localStorage.setItem('flask-offline-'+f.key,JSON.stringify(f));Object.defineProperty(navigator,'hid',{value:{getDevices:async()=>[],requestDevice:async()=>{throw Error('Hardware disabled in tests')},addEventListener(){}}});Object.defineProperty(navigator,'serial',{value:{getPorts:async()=>[],requestPort:async()=>{throw Error('Hardware disabled in tests')},addEventListener(){}}});},fixture);
 if(legacy){await page.route('**/styles.css?*',r=>r.fulfill({body:oldCss,contentType:'text/css'}));await page.route('**/main.js?*',r=>r.fulfill({body:oldMain,contentType:'text/javascript'}));}
 await page.goto(url);await page.locator('#offline-list .dev-item').filter({hasText:fixture.label}).click();await page.locator('.kb-svg .keycap').first().waitFor();return {context,page};
}
async function styleSample(page){return page.evaluate(()=>{const selectors=['body','header','#status-pill','#theme-sel','#connect-btn','.card','.kb-svg .keycap','.code','.tab-groups button.active'];const props=['backgroundColor','color','borderTopColor','borderBottomColor','boxShadow','filter','fontSize','fontWeight','padding','borderRadius'];return selectors.map(sel=>{const el=document.querySelector(sel),s=getComputedStyle(el);return[sel,...props.map(p=>s[p])];});});}
const ref=await open({width:1440,height:1000},true),now=await open({width:1440,height:1000});
for(const [theme]of baseline.themeOptions){await ref.page.selectOption('#theme-sel',theme);await now.page.selectOption('#theme-sel',theme);await ref.page.mouse.move(0,0);await now.page.mouse.move(0,0);await now.page.waitForTimeout(220);eq(await styleSample(now.page),await styleSample(ref.page),'Existing theme changed: '+theme);await ref.page.locator('#theme-sel').hover();await now.page.locator('#theme-sel').hover();await now.page.waitForTimeout(220);eq(await styleSample(now.page),await styleSample(ref.page),'Existing hover changed: '+theme);}
await ref.page.locator('.tab-groups button').filter({hasText:'Behaviour'}).click();const behaviorTabs=await ref.page.locator('.tab-row button').allTextContents();
await ref.context.close();await now.context.close();
for(const [name,viewport]of Object.entries({desktop:{width:1440,height:1000},tablet:{width:900,height:1000},mobile:{width:390,height:844}})){
 const {context,page}=await open(viewport);await page.selectOption('#theme-sel','layoutStudio');await page.waitForTimeout(220);

 // Small coordinate labels must stay legible on normal, selected and pressed keys.
 const palette=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return ['faint','keycap','accent-bg','ok-bg'].map(k=>s.getPropertyValue('--'+k).trim());});
 const lum=h=>{const rgb=h.replace('#','').match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const ink=lum(palette[0]);for(const bg of palette.slice(1)){const fill=lum(bg);eq((Math.max(ink,fill)+.05)/(Math.min(ink,fill)+.05)>=4.5,true,'Coordinate label contrast below 4.5:1');}
 eq(await page.locator('.kb-svg').evaluate(el=>el.outerHTML),baseline.geometry,'Key geometry/content changed');
 eq(await page.locator('.tab-groups button').allTextContents(),baseline.groups,'Navigation changed');
 eq(await page.locator('#theme-sel option').evaluateAll(xs=>xs.filter(x=>x.value!=='layoutStudio').map(x=>[x.value,x.text])),baseline.themeOptions,'Existing theme options changed');
 eq(await page.locator('#status-text').textContent(),'Offline — '+fixture.label,'Connection state changed');
 if(process.env.FLASK_THEME_CAPTURE!=='0')await page.screenshot({path:dir+`/${name}-keymap.png`,fullPage:true});
 eq(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true,'Outer overflow '+name);
 await page.locator('.kb-svg .keycap').first().click();await page.locator('.picker input[type=search]').fill('escape');await page.locator('.codes .code').filter({hasText:'Escape'}).first().click();
 await page.waitForFunction(key=>Object.values(JSON.parse(localStorage.getItem('flask-offline-'+key)).dirty.km).includes(41),fixture.key);checks++;
 await page.locator('.tab-groups button').filter({hasText:'Behaviour'}).click();
 eq(await page.locator('.tab-row button').allTextContents(),behaviorTabs,'Behaviour tabs changed');
 await page.locator('.tab-row button').filter({hasText:/^Chords$/}).click();await page.waitForTimeout(200);if(process.env.FLASK_THEME_CAPTURE!=='0')await page.screenshot({path:dir+`/${name}-chords.png`,fullPage:true});
 await page.locator('.tab-groups button').filter({hasText:/^Keys$/}).click();await page.locator('.kb-svg .keycap').first().waitFor();
 await page.locator('.layer-strip button').filter({hasText:'empty'}).click();await page.locator('.layer-strip button').filter({hasText:/^Layer 1$/}).click();checks++;
 const download=page.waitForEvent('download');await page.locator('#vil-save').click();const file=await download;await file.saveAs(dir+`/${name}-test-export.vil`);checks++;
 for(const zoom of ['80','150','100']){await page.selectOption('#zoom-sel',zoom);eq(await page.evaluate(()=>localStorage.getItem('flask-zoom')),zoom,'Zoom storage changed');}
 await page.reload();eq(await page.locator('#theme-sel').inputValue(),'layoutStudio','Theme not persisted');eq(await page.locator('#zoom-sel').inputValue(),'100','Zoom not persisted');
 await page.selectOption('#theme-sel','dark');eq(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--header-bg')),'','Studio tokens leaked into dark');
 await page.selectOption('#theme-sel','classic');eq(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--panel-shadow')),'','Studio shadows leaked into classic');
 await context.close();
}
eq(errors,[],'Browser runtime errors');await browser.close();await fs.writeFile(dir+'/result.json',JSON.stringify({checks,result:'PASS',viewports:['1440x1000','900x1000','390x844'],legacyThemesCompared:8,fixtureKey:fixture.key,hardwareDisabled:true},null,2));console.log('PASS',checks,'appearance/preservation assertions');
