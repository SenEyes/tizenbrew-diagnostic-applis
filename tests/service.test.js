'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { loadService, fakeTizen, freePort, call, waitFor } = require('./helpers/harness');

const ORIGIN = 'http://127.0.0.1:8081';
const ICON_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function sampleApps(iconPath) {
  return [
    { id: 'org.tizen.netflix-app', name: 'Netflix' },
    { id: 'AAAAAAAAAA.Emby', name: 'Emby', iconPath },
    { id: 'BBBBBBBBBB.Service', name: 'Service système', show: false },
    { id: '9Ur5IzDKqV.TizenYouTube', name: 'YouTube' },
    { id: 'CCCCCCCCCC.Panne', name: 'Appli en panne' },
    { id: 'DDDDDDDDDD.Muette', name: 'Appli muette' }
  ];
}

function connects(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

describe('service du module', () => {
  let svc;
  let tz;
  let localPort;
  let lanPort;
  let iconDir;
  let iconFile;
  let token;

  before(async () => {
    iconDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-icones-'));
    iconFile = path.join(iconDir, 'emby.png');
    fs.writeFileSync(iconFile, ICON_BYTES);
    tz = fakeTizen(sampleApps(iconFile), { launchFails: ['CCCCCCCCCC.Panne'], launchSilent: ['DDDDDDDDDD.Muette'] });
    localPort = await freePort();
    lanPort = await freePort();
    svc = loadService({
      tizen: tz,
      config: { localPort, lanPort, lanHost: '127.0.0.1', iconRoots: [iconDir], launchTimeout: 200 }
    });
    await waitFor(() => svc.state.local.listening && svc.state.lan.open);
  });

  after(() => {
    svc.stop();
    fs.rmSync(iconDir, { recursive: true, force: true });
  });

  it("ouvre l'accès réseau pour 30 minutes au démarrage", () => {
    const lan = svc.state.lan;
    assert.equal(lan.open, true);
    assert.ok(Math.abs(lan.until - lan.openedAt - 30 * 60000) < 1000);
  });

  it('refuse une origine absente ou étrangère, de façon lisible et notée', async () => {
    const absent = await call(localPort, 'GET', '/session');
    assert.equal(absent.status, 403);
    assert.equal(absent.headers['access-control-allow-origin'], undefined);
    const foreign = await call(localPort, 'GET', '/session', { headers: { Origin: 'http://exemple.invalid' } });
    assert.equal(foreign.status, 403);
    // L'en-tête CORS laisse la page lire la raison du refus ; aucun jeton dans la réponse.
    assert.equal(foreign.headers['access-control-allow-origin'], 'http://exemple.invalid');
    assert.equal(foreign.json.error, 'Origine refusée (http://exemple.invalid).');
    assert.equal(foreign.json.token, undefined);
    assert.equal(svc.state.requests.session, 2);
    // Array.from : le tableau du service vient du contexte vm, on le recopie dans celui du test.
    assert.deepEqual(Array.from(svc.state.requests.refused, (r) => r.origin), [null, 'http://exemple.invalid']);
    assert.equal(svc.state.requests.refused[1].path, '/session');
    assert.equal(svc.state.page, null);
  });

  it('donne un jeton à la page et note ses horaires et ses essais', async () => {
    const nav = Date.now() - 1500;
    const ready = Date.now() - 200;
    const res = await call(localPort, 'GET', `/session?nav=${nav}&ready=${ready}&tries=3&waited=2100`, { headers: { Origin: ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.match(res.json.token, /^[0-9a-f]{32}$/);
    assert.equal(res.json.platform, '5.5');
    assert.equal(svc.state.page.first.navigationStart, nav);
    assert.equal(svc.state.page.first.readyAt, ready);
    assert.equal(res.json.timings.pageTries, 3);
    assert.equal(res.json.timings.pageWaitedForServiceMs, 2100);
    assert.equal(typeof res.json.timings.tizenbrewToModuleMs, 'number');
    token = res.json.token;
  });

  it('accepte une origine locale opaque', async () => {
    const res = await call(localPort, 'GET', '/session', { headers: { Origin: 'null' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'null');
    assert.equal(svc.state.page.visits, 2);
  });

  it('répond au contrôle CORS préalable de la page', async () => {
    const res = await call(localPort, 'OPTIONS', '/lancer', { headers: { Origin: ORIGIN } });
    assert.equal(res.status, 204);
    assert.match(res.headers['access-control-allow-headers'], /X-Diag-Token/);
  });

  it('liste les applis sans lire le champ size', async () => {
    const res = await call(localPort, 'GET', '/applis', { headers: { Origin: ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.json.count, 6);
    assert.equal(res.json.visible, 5);
    assert.deepEqual(res.json.list.map((a) => a.name), ['Appli en panne', 'Appli muette', 'Emby', 'Netflix', 'Service système', 'YouTube']);
    assert.equal(res.json.list.find((a) => a.name === 'Emby').icon, true);
    assert.equal(res.json.list.find((a) => a.name === 'Netflix').icon, false);
    assert.ok(res.json.list.every((a) => !('iconPath' in a)));
    assert.equal(tz.calls.sizeTouched, false);
  });

  it('ne relit la liste que sur demande', async () => {
    const before = tz.calls.getAppsInfo;
    await call(localPort, 'GET', '/applis', { headers: { Origin: ORIGIN } });
    assert.equal(tz.calls.getAppsInfo, before);
    await call(localPort, 'GET', '/applis?recharger=1', { headers: { Origin: ORIGIN } });
    assert.equal(tz.calls.getAppsInfo, before + 1);
  });

  it('exige le jeton pour lancer une appli', async () => {
    const without = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN }, body: { id: 'org.tizen.netflix-app' } });
    assert.equal(without.status, 403);
    const wrong = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': '0'.repeat(32) }, body: { id: 'org.tizen.netflix-app' } });
    assert.equal(wrong.status, 403);
    assert.equal(tz.calls.launch.length, 0);
  });

  it('lance une appli de la liste et note le résultat', async () => {
    const res = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token }, body: { id: 'org.tizen.netflix-app' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.ms, 'number');
    assert.deepEqual(tz.calls.launch, ['org.tizen.netflix-app']);
    const last = svc.state.launches[svc.state.launches.length - 1];
    assert.equal(last.name, 'Netflix');
    assert.equal(last.ok, true);
  });

  it('refuse un identifiant absent de la liste', async () => {
    const res = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token }, body: { id: 'inconnu.App' } });
    assert.equal(res.status, 404);
    assert.ok(!tz.calls.launch.includes('inconnu.App'));
  });

  it("rapporte l'échec renvoyé par la TV", async () => {
    const res = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token }, body: { id: 'CCCCCCCCCC.Panne' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /NotFoundError/);
  });

  it('répond même si la TV ne rappelle jamais', async () => {
    const res = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token }, body: { id: 'DDDDDDDDDD.Muette' } });
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /^Pas de réponse de la TV/);
  });

  it('rejette un corps mal formé', async () => {
    const res = await call(localPort, 'POST', '/lancer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token }, body: 'pas du json' });
    assert.equal(res.status, 400);
  });

  it("sert l'icône d'une appli de la liste et rien d'autre", async () => {
    const ok = await call(localPort, 'GET', '/icone?id=AAAAAAAAAA.Emby');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.deepEqual(ok.raw, ICON_BYTES);
    assert.equal((await call(localPort, 'GET', '/icone?id=org.tizen.netflix-app')).status, 404);
    assert.equal((await call(localPort, 'GET', '/icone?id=..%2F..%2Fetc%2Fpasswd')).status, 404);
  });

  it('refuse les icônes hors des dossiers autorisés', () => {
    assert.equal(svc.iconFile('/etc/passwd.png'), null);
    assert.equal(svc.iconFile(iconDir + '/../autre.png'), null);
    assert.equal(svc.iconFile(path.join(iconDir, 'texte.txt')), null);
    assert.equal(svc.iconFile('file://' + iconFile), iconFile);
  });

  it('réseau local : rapport lisible sans jeton, et le jeton ne fuit pas', async () => {
    const res = await call(lanPort, 'GET', '/rapport');
    assert.equal(res.status, 200);
    assert.equal(res.json.module, 'diagnostic-applis-tv');
    assert.equal(res.json.apps.list.length, 6);
    assert.ok(res.json.launches.length >= 3);
    assert.equal(res.json.requests.session, 4);
    assert.equal(res.json.requests.refused.length, 2);
    assert.ok(!res.text.includes(token));
    const page = await call(lanPort, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Diagnostic applis TV/);
    assert.ok(!page.text.includes(token));
  });

  it("réseau local : aucune action de la page n'y est possible", async () => {
    assert.equal((await call(lanPort, 'POST', '/lancer', { body: { id: 'org.tizen.netflix-app' } })).status, 404);
    assert.equal((await call(lanPort, 'GET', '/session')).status, 404);
  });

  it('réseau local : POST /fermer ferme vraiment le port', async () => {
    const res = await call(lanPort, 'POST', '/fermer');
    assert.equal(res.status, 200);
    await waitFor(() => !svc.state.lan.open);
    assert.equal(svc.state.lan.closedBy, 'pc');
    assert.equal(await connects(lanPort), false);
  });

  it('la page rouvre puis referme l\'accès réseau avec son jeton', async () => {
    const refused = await call(localPort, 'POST', '/reseau/ouvrir', { headers: { Origin: ORIGIN } });
    assert.equal(refused.status, 403);
    const opened = await call(localPort, 'POST', '/reseau/ouvrir', { headers: { Origin: ORIGIN, 'X-Diag-Token': token } });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.lan.open, true);
    assert.equal((await call(lanPort, 'GET', '/rapport')).status, 200);
    const closed = await call(localPort, 'POST', '/reseau/fermer', { headers: { Origin: ORIGIN, 'X-Diag-Token': token } });
    assert.equal(closed.json.lan.open, false);
    assert.equal(svc.state.lan.closedBy, 'page');
    assert.equal(await connects(lanPort), false);
  });

  it('reconnaît les adresses du réseau local', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.3.4', 'fe80::1', 'fd12:3456::1']) {
      assert.equal(svc.isPrivate(address), true, address);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '::ffff:1.1.1.1', '2a01:e0a::1', '']) {
      assert.equal(svc.isPrivate(address), false, address);
    }
    assert.equal(svc.isLoopback('::ffff:127.0.0.1'), true);
    assert.equal(svc.isLoopback('192.168.1.20'), false);
  });
});

describe("fermeture automatique de l'accès réseau", () => {
  it('se ferme seul à la fin du délai', async () => {
    const lanPort = await freePort();
    const svc = loadService({
      tizen: fakeTizen(sampleApps('')),
      config: { localPort: await freePort(), lanPort, lanHost: '127.0.0.1', lanMinutes: 0.003 }
    });
    try {
      await waitFor(() => svc.state.lan.open);
      await waitFor(() => !svc.state.lan.open && svc.state.lan.closedBy === 'délai', { timeout: 3000 });
      assert.equal(await connects(lanPort), false);
    } finally {
      svc.stop();
    }
  });
});

describe('cas dégradés', () => {
  it('signale un port local déjà pris sans planter', async () => {
    const localPort = await freePort();
    const blocker = net.createServer().listen(localPort, '127.0.0.1');
    await new Promise((resolve) => blocker.on('listening', resolve));
    const lanPort = await freePort();
    const svc = loadService({ tizen: fakeTizen(sampleApps('')), config: { localPort, lanPort, lanHost: '127.0.0.1' } });
    try {
      await waitFor(() => svc.state.local.error === 'EADDRINUSE');
      await waitFor(() => svc.state.lan.open);
      const res = await call(lanPort, 'GET', '/rapport');
      assert.equal(res.json.local.error, 'EADDRINUSE');
    } finally {
      svc.stop();
      blocker.close();
    }
  });

  it("explique l'absence de l'objet tizen", async () => {
    const localPort = await freePort();
    const svc = loadService({ tizen: null, config: { localPort, lanPort: await freePort(), lanHost: '127.0.0.1' } });
    try {
      await waitFor(() => svc.state.local.listening);
      const res = await call(localPort, 'GET', '/applis', { headers: { Origin: ORIGIN } });
      assert.equal(res.status, 200);
      assert.match(res.json.error, /tizen est absent/);
      assert.equal(res.json.count, 0);
    } finally {
      svc.stop();
    }
  });

  it("rapporte une erreur de getAppsInfo", async () => {
    const localPort = await freePort();
    const svc = loadService({
      tizen: fakeTizen(sampleApps(''), { appsError: 'liste indisponible' }),
      config: { localPort, lanPort: await freePort(), lanHost: '127.0.0.1' }
    });
    try {
      await waitFor(() => svc.state.local.listening);
      const res = await call(localPort, 'GET', '/applis', { headers: { Origin: ORIGIN } });
      assert.match(res.json.error, /UnknownError : liste indisponible/);
    } finally {
      svc.stop();
    }
  });
});
