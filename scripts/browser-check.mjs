import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = new URL('../web/', import.meta.url), prefix = '/labs/rigid-body/';
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = path.slice(prefix.length) || 'index.html';
    if (!path.startsWith(prefix) || !/^[\w.-]+$/.test(file)) throw Error('path');
    const contents = await readFile(new URL(file, root));
    response.writeHead(200, { 'Content-Type': types[extname(file)] }); response.end(contents);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const engine = process.env.BROWSER_ENGINE || 'chromium';
const browserType = { chromium, webkit }[engine];
let browser;
try {
  browser = await browserType.launch(engine === 'chromium' ? { channel: 'chromium' } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 1040 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const errors = [], remote = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', req => { if (!req.url().startsWith(origin)) remote.push(req.url()); });
  page.on('response', res => { if (res.status() >= 400) errors.push(res.status() + ' ' + res.url()); });
  await page.goto(origin + prefix);
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  const read = id => page.locator('#'+id).innerText();
  const click = id => page.locator('#'+id).click();
  const axis = i => page.locator('.choices label').nth(i).click();
  const sceneImage = () => page.locator('#scene').evaluate(c => c.toDataURL());
  assert.equal(await read('state'), 'Ready');
  assert.equal(await read('clock'), '0.000 s');
  await click('step'); assert.equal(await read('clock'), '0.004 s');
  await click('reset'); assert.equal(await read('clock'), '0.000 s');
  const initial = await sceneImage();
  await page.locator('#scene').focus(); await page.keyboard.press('ArrowRight');
  assert.notEqual(await sceneImage(), initial);
  await page.keyboard.press('Home');
  assert.equal(await sceneImage(), initial);
  const rect = await page.locator('#scene').boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2 + 25);
  await page.mouse.up(); assert.notEqual(await sceneImage(), initial);
  await click('view-reset'); assert.equal(await sceneImage(), initial);
  await click('play');
  await page.clock.runFor(2050);
  await click('play');
  assert.equal(await read('state'), 'Paused');
  const clock = await read('clock');
  assert.ok(parseFloat(clock) >= 2 && parseFloat(clock) < 2.2, clock);
  assert.ok(parseFloat((await read('value-1')).replace('−','-')) < -0.9);
  for (const i of [0,2]) assert.ok(parseFloat(await read('value-'+i)) > 0.99);
  assert.ok(parseFloat(await read('momentum')) > 0);
  await axis(0); assert.equal(await read('clock'), clock);
  const attitudeX = await sceneImage();
  await axis(2); assert.notEqual(await sceneImage(), attitudeX);
  await axis(1);
  if (process.argv.includes('--screenshots')) {
    await click('play'); await page.clock.runFor(4200); await click('play');
    await page.locator('#scene').evaluate(c => c.blur());
    await page.screenshot({ path: fileURLToPath(new URL('../evidence/desktop.png', import.meta.url)) });
  }
  await page.locator('#nudge').focus(); await page.keyboard.press('Home');
  assert.equal(await read('nudge-value'), '0%'); assert.equal(await read('clock'), '0.000 s');
  await page.locator('#spin').focus(); await page.keyboard.press('End');
  assert.equal(await read('spin-value'), '10 rad/s');
  await click('play'); await page.clock.runFor(1500); await click('step');
  assert.equal(await read('state'), 'Paused');
  for (const i of [0,1,2]) assert.equal(await read('value-'+i), '+1.000');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.resume();
  await page.reload();
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1500)));
  assert.equal(await read('state'), 'Ready');
  await click('play'); await page.clock.runFor(1750); await click('play');
  assert.ok(parseFloat((await read('value-1')).replace('−','-')) < -0.6);
  if (process.argv.includes('--screenshots')) await page.screenshot({ path: fileURLToPath(new URL('../evidence/mobile.png', import.meta.url)), fullPage:true });
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 }); await page.clock.runFor(34);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'overflow at '+width);
  }
  await page.getByText('How can I check the result?').click();
  const evidenceLink = page.getByRole('link', {name:'Read the measured benchmark (JSON)'});
  assert.ok(await evidenceLink.isVisible());
  const data = await (await page.request.get(new URL(await evidenceLink.getAttribute('href'), page.url()).href)).json();
  assert.equal(data.rotor.length, 9);
  assert.deepEqual(remote, []); assert.deepEqual(errors, []);
  console.log('PASS '+engine+': nested static path, reduced-motion launch, single step, pause/resume/reset, orbit and home, three concurrent traces, live drift, nudge and spin controls, benchmark link, no external requests or browser errors, 320–1280 px overflow checks.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
