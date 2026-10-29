'use strict';

// Test de bout en bout de la page : un Edge ou un Chrome sans fenêtre, piloté par le protocole
// DevTools (WebSocket natif de Node 22+), face au vrai service et à une fausse API tizen.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ROOT, loadService, fakeTizen, freePort, waitFor, sleep } = require('./helpers/harness');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const browserPath = process.env.DIAG_BROWSER || BROWSERS.find((p) => fs.existsSync(p));

const APPS = [
  { id: 'org.tizen.netflix-app', name: 'Netflix' },
  { id: 'AAAAAAAAAA.Emby', name: 'Emby' },
  { id: 'BBBBBBBBBB.Service', name: 'Service système', show: false },
  { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube' },
  { id: 'CCCCCCCCCC.Panne', name: 'Appli en panne' },
  { id: 'DDDDDDDDDD.Autre', name: 'Autre appli' }
];

function serveApp(port) {
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/app/index.html') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(ROOT, 'app', 'index.html')));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function startBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-navigateur-'));
  const child = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--window-size=1920,1080', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Le navigateur ne donne pas son adresse DevTools.')), 20000);
    child.stderr.on('data', (chunk) => {
      output += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve({ child, profile, port: Number(new URL(m[1]).port) });
      }
    });
    child.on('exit', (code) => reject(new Error('Navigateur arrêté (code ' + code + ').')));
  });
}

function stopBrowser(browser) {
  if (!browser) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(browser.child.pid), '/T', '/F'], { stdio: 'ignore' });
    else browser.child.kill('SIGKILL');
  } catch {
    // déjà arrêté
  }
  fs.rmSync(browser.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let lastId = 0;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message));
        else waiter.resolve(msg.result);
      } else {
        events.push(msg);
      }
    });
    ws.addEventListener('error', () => reject(new Error('Connexion DevTools impossible.')));
    ws.addEventListener('open', () => resolve({
      events,
      send(method, params = {}) {
        lastId += 1;
        const id = lastId;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      close() { ws.close(); }
    }));
  });
}

describe('page du module, dans un vrai navigateur', { skip: browserPath ? false : 'aucun navigateur Chromium trouvé' }, () => {
  let browser;
  let page;
  let staticServer;
  let staticPort;
  let svc;
  let tz;

  async function evaluate(expression) {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true });
    return result.result.value;
  }

  async function press(key, keyCode, times = 1) {
    for (let i = 0; i < times; i += 1) {
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    }
  }

  const rowNames = () => evaluate("Array.prototype.map.call(document.querySelectorAll('.row .name'), function (n) { return n.textContent; })");
  const focusedRow = () => evaluate("(document.querySelector('.row.focus .name') || {}).textContent || null");
  const focusedTool = () => evaluate("(document.querySelector('.btn.focus') || {}).textContent || null");
  const stats = () => evaluate("document.getElementById('stats').textContent");

  before(async () => {
    staticPort = await freePort();
    const localPort = await freePort();
    staticServer = await serveApp(staticPort);
    browser = await startBrowser();
    const targets = await (await fetch('http://127.0.0.1:' + browser.port + '/json/list')).json();
    page = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    // Comme sur la TV : la page s'ouvre avant que TizenBrew ait fini de lancer le service.
    await page.send('Page.navigate', { url: 'http://127.0.0.1:' + staticPort + '/app/index.html?service=http://127.0.0.1:' + localPort });
    await sleep(2500);
    tz = fakeTizen(APPS, { launchFails: ['CCCCCCCCCC.Panne'] });
    svc = loadService({
      tizen: tz,
      config: { localPort, lanPort: await freePort(), lanHost: '127.0.0.1', extraOrigins: ['http://127.0.0.1:' + staticPort] }
    });
    await waitFor(async () => (await rowNames() || []).length > 0, { timeout: 15000 });
  });

  after(() => {
    if (page) page.close();
    stopBrowser(browser);
    if (staticServer) staticServer.close();
    if (svc) svc.stop();
  });

  it("attend le service quand il démarre après la page", async () => {
    const first = svc.state.page.first;
    assert.ok(first.tries >= 2, 'essais : ' + first.tries);
    assert.ok(first.waitedMs >= 1500, 'attente : ' + first.waitedMs);
    assert.equal(svc.state.page.visits, 1);
    assert.match(await stats(), /service joint après \d+,\d s \(\d+ essais\)/);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('message')).display"), 'none');
  });

  it('affiche les applis visibles, triées, avec les délais et le lien du PC', async () => {
    assert.deepEqual(await rowNames(), ['Appli en panne', 'Autre appli', 'Emby', 'Netflix', 'YouTube']);
    assert.equal(await focusedRow(), 'Appli en panne');
    const text = await stats();
    assert.match(text, /Applis visibles : 5 sur 6 entrées/);
    assert.match(text, /Tizen 5\.5/);
    assert.match(text, /Accès depuis le PC : ouvert jusqu'à \d\d:\d\d/);
    assert.match(text, /\/rapport/);
  });

  it('lance l\'appli choisie avec OK et affiche le résultat', async () => {
    await press('ArrowDown', 40, 3);
    assert.equal(await focusedRow(), 'Netflix');
    await press('Enter', 13);
    await waitFor(() => tz.calls.launch.includes('org.tizen.netflix-app'));
    await waitFor(async () => /Appel accepté en \d+ ms/.test(await evaluate("document.querySelector('.row.focus .result').textContent")));
  });

  it("affiche l'échec quand la TV refuse", async () => {
    await press('ArrowUp', 38, 3);
    assert.equal(await focusedRow(), 'Appli en panne');
    await press('Enter', 13);
    await waitFor(async () => /Échec : NotFoundError/.test(await evaluate("document.querySelector('.row.focus .result').textContent")));
  });

  it('montre aussi les entrées cachées des menus sur demande', async () => {
    await press('ArrowUp', 38);
    assert.equal(await focusedTool(), 'Afficher : toutes les entrées');
    await press('Enter', 13);
    await press('ArrowDown', 40);
    const names = await rowNames();
    assert.equal(names.length, 6);
    assert.ok(names.includes('Service système'));
    assert.match(await evaluate("document.getElementById('help').textContent"), /ligne 1 sur 6/);
  });

  it("ferme l'accès PC depuis la barre d'outils", async () => {
    await press('ArrowUp', 38);
    await press('ArrowRight', 39, 2);
    assert.equal(await focusedTool(), "Fermer l'accès PC");
    await press('Enter', 13);
    await waitFor(() => !svc.state.lan.open);
    assert.equal(svc.state.lan.closedBy, 'page');
    await waitFor(async () => /Accès depuis le PC : fermé/.test(await stats()));
    assert.equal(await focusedTool(), "Rouvrir l'accès PC (30 min)");
  });

  it('affiche la raison quand le service refuse la page, sans insister', async () => {
    const otherPort = await freePort();
    const other = loadService({ tizen: fakeTizen(APPS), config: { localPort: otherPort, lanPort: await freePort(), lanHost: '127.0.0.1' } });
    try {
      await waitFor(() => other.state.local.listening);
      await page.send('Page.navigate', { url: 'http://127.0.0.1:' + staticPort + '/app/index.html?service=http://127.0.0.1:' + otherPort });
      const message = "document.getElementById('message').textContent";
      await waitFor(async () => /^Origine refusée \(http:\/\/127\.0\.0\.1:\d+\)\./.test(await evaluate(message)), { timeout: 10000 });
      await sleep(2500);
      assert.equal(other.state.requests.session, 1);
      assert.equal(other.state.requests.refused[0].origin, 'http://127.0.0.1:' + staticPort);
    } finally {
      other.stop();
    }
  });

  it('ne lève aucune erreur JavaScript', () => {
    const errors = page.events.filter((e) => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    assert.deepEqual(errors, []);
  });
});
