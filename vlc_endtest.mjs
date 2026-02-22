import { chromium } from 'playwright-core';
import { existsSync } from 'fs';

const MXF = '/Users/j0r14p5/Desktop/VLC_js/A009C233_260209D4_CANON.MXF';
if (!existsSync(MXF)) { console.log('MXF not found'); process.exit(1); }

const browser = await chromium.launch({ headless: false, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();

// Capture console
const logs = [];
page.on('console', m => {
  const t = m.text();
  logs.push(t);
  if (!t.includes('customCmd') && !t.includes('[object Object]')) console.log('[PAGE]', t);
});
page.on('pageerror', e => console.error('[ERROR]', e.message));

await page.goto('http://localhost:3000', { waitUntil: 'load', timeout: 60000 });

// Wait for VLC to init
await page.waitForFunction(() => typeof window.Module !== 'undefined' && window.Module._wasm_media_player_new, { timeout: 60000 });
console.log('VLC initialized');

// Inject frame counter
await page.evaluate(() => {
  window.__frames = 0;
  window.__lastFrameTime = Date.now();
  const orig = window._vlcOnDecoderFrame;
  window._vlcOnDecoderFrame = function(pid, frame) {
    window.__frames++;
    window.__lastFrameTime = Date.now();
    return orig ? orig(pid, frame) : undefined;
  };
});

// Upload the file
const [fc] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('#play-button')
]);
await fc.setFiles(MXF);
console.log('File uploaded, waiting for playback...');

// Wait for first frame
await page.waitForFunction(() => window.__frames > 0, { timeout: 30000 });
console.log('Playback started, first frame received');

// Poll until frames stop (video ended) or 5 min timeout
const START = Date.now();
const MAX_WAIT = 5 * 60 * 1000; // 5 minutes
let videoEnded = false;
let lastFrameCount = 0;

while (Date.now() - START < MAX_WAIT) {
  await page.waitForTimeout(2000);
  const frames = await page.evaluate(() => window.__frames);
  const lastFrameAge = await page.evaluate(() => Date.now() - window.__lastFrameTime);
  console.log(`Frames: ${frames}, last frame ${lastFrameAge}ms ago, elapsed: ${Math.round((Date.now()-START)/1000)}s`);
  
  // Detect end: frames stopped advancing for >3 seconds
  if (frames === lastFrameCount && lastFrameAge > 3000) {
    console.log('=== VIDEO APPEARS TO HAVE ENDED ===');
    videoEnded = true;
    break;
  }
  lastFrameCount = frames;
}

if (!videoEnded) { console.log('Timeout reached before video end'); }

// Now test if UI is still responsive
console.log('Testing UI responsiveness after video end...');
await page.waitForTimeout(500);

// Try clicking play/pause
const t0 = Date.now();
try {
  await page.click('#play-button', { timeout: 2000 });
  console.log(`Play button click: ${Date.now()-t0}ms`);
} catch(e) {
  console.error('Play button UNRESPONSIVE:', e.message);
}

// Try scrubbing
const t1 = Date.now();
try {
  await page.click('#bottom-progress', { position: { x: 100, y: 5 }, timeout: 2000 });
  console.log(`Seek click: ${Date.now()-t1}ms`);
} catch(e) {
  console.error('Seek bar UNRESPONSIVE:', e.message);
}

// Check JS is responsive
const t2 = Date.now();
const jsResult = await page.evaluate(() => 'alive', { timeout: 3000 }).catch(() => 'FROZEN');
console.log(`JS eval: "${jsResult}" in ${Date.now()-t2}ms`);

// Screenshot final state
await page.screenshot({ path: '/Users/j0r14p5/Desktop/VLC_js/.wibey-tasks/agent-browser/video-end-state.png' });
console.log('Screenshot saved');

await browser.close();
