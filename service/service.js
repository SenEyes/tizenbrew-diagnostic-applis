/*
 * Service du module « Diagnostic applis TV » (TizenBrew).
 *
 * TizenBrew exécute ce fichier dans son propre Node.js, dans un bac à sable vm,
 * et lui passe l'objet `tizen`. La page du module, servie par TizenBrew en http,
 * n'a pas cet objet : elle passe par ce service pour lister et lancer les applis.
 * Le Node de la TV peut être ancien (v4) : ce fichier reste en ES5.
 *
 * Deux serveurs :
 *   127.0.0.1:8097, pour la page seulement (origine de TizenBrew vérifiée)
 *     GET  /session          jeton de la page, infos, enregistre ses horaires
 *     GET  /applis           liste des applis (?recharger=1 pour la relire)
 *     GET  /icone?id=        icône d'une appli de la liste
 *     GET  /etat             rapport complet (sans le jeton)
 *     POST /lancer           { id }, jeton exigé
 *     POST /reseau/fermer    jeton exigé
 *     POST /reseau/ouvrir    jeton exigé, rouvre pour 30 min
 *   0.0.0.0:8099, lecture seule depuis le réseau local, fermé au bout de 30 min
 *     GET  /                 résumé lisible
 *     GET  /rapport          rapport complet en JSON
 *     POST /fermer           ferme l'accès réseau tout de suite
 *
 * Rien n'est écrit sur la TV : tout reste en mémoire jusqu'au redémarrage de la TV.
 */
(function () {
  'use strict';

  var http = require('http');
  var fs = require('fs');
  var os = require('os');
  var crypto = require('crypto');
  // url.parse : le seul analyseur d'URL du Node 4 de la TV (les Node récents l'annoncent obsolète).
  var urlLib = require('url');

  var VERSION = '0.1.1';

  // Réglages de test uniquement : DIAG_CONFIG n'existe pas sur la TV.
  var cfg = (typeof DIAG_CONFIG !== 'undefined' && DIAG_CONFIG) || {};
  var LOCAL_PORT = cfg.localPort || 8097;
  var LAN_PORT = cfg.lanPort || 8099;
  var LAN_HOST = cfg.lanHost || '0.0.0.0';
  var LAN_MINUTES = cfg.lanMinutes || 30;
  // Pages locales de TizenBrew ; « null » et « file:// » couvrent une origine locale opaque.
  var ORIGINS = ['http://127.0.0.1:8081', 'http://localhost:8081', 'null', 'file://'].concat(cfg.extraOrigins || []);
  var ICON_ROOTS = cfg.iconRoots || ['/opt/', '/usr/'];
  var ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  var APPS_MAX_AGE = 5 * 60 * 1000;
  var LAUNCH_TIMEOUT = cfg.launchTimeout || 15000;
  var MAX_BODY = 4096;
  var MAX_LAUNCHES = 200;

  var hasTizen = typeof tizen !== 'undefined' && !!tizen && !!tizen.application;
  var token = crypto.randomBytes(16).toString('hex');
  var startedAt = Date.now();

  var state = {
    version: VERSION,
    startedAt: startedAt,
    // Ce Node démarre avec TizenBrew : son âge donne l'heure d'ouverture de TizenBrew.
    tizenbrewStartedAt: Math.round(startedAt - process.uptime() * 1000),
    platform: capability('http://tizen.org/feature/platform.version'),
    model: capability('http://tizen.org/system/model_name'),
    node: process.version,
    page: null,
    // Toutes les demandes de session reçues, même refusées : dit si la page joint le service.
    requests: { session: 0, lastSessionAt: null, refused: [] },
    apps: { list: null, at: null, ms: null, error: null },
    launches: [],
    local: { port: LOCAL_PORT, listening: false, error: null },
    lan: { port: LAN_PORT, open: false, until: null, openedAt: null, closedAt: null, closedBy: null, error: null }
  };

  function capability(key) {
    try {
      return hasTizen && tizen.systeminfo ? String(tizen.systeminfo.getCapability(key)) : null;
    } catch (e) {
      return null;
    }
  }

  function describe(err) {
    if (!err) { return 'Erreur inconnue.'; }
    if (err.name || err.message) { return (err.name ? err.name + ' : ' : '') + (err.message || ''); }
    return String(err);
  }

  /* ---------- Adresses ---------- */

  function cleanAddress(address) {
    var a = String(address || '');
    return a.indexOf('::ffff:') === 0 ? a.slice(7) : a;
  }

  function isLoopback(address) {
    var a = cleanAddress(address);
    return a === '::1' || /^127\./.test(a);
  }

  // Réseau local seulement : boucle locale, 10/8, 172.16/12, 192.168/16, lien local, IPv6 privées.
  function isPrivate(address) {
    var a = cleanAddress(address).toLowerCase();
    if (isLoopback(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) { return true; }
    var m = /^172\.(\d+)\./.exec(a);
    if (m) { return Number(m[1]) >= 16 && Number(m[1]) <= 31; }
    return /^fe[89ab][0-9a-f]:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a);
  }

  function lanAddresses() {
    var found = [];
    var interfaces = {};
    try { interfaces = os.networkInterfaces(); } catch (e) { return found; }
    Object.keys(interfaces).forEach(function (name) {
      (interfaces[name] || []).forEach(function (a) {
        if (a.family === 'IPv4' && !a.internal) { found.push(a.address); }
      });
    });
    return found;
  }

  /* ---------- Applis ---------- */

  // Lecture champ par champ : `size` exige un privilège que TizenBrew n'a pas, on n'y touche pas.
  function field(info, name) {
    try { return info[name]; } catch (e) { return undefined; }
  }

  function toApp(info) {
    var categories = field(info, 'categories');
    return {
      id: String(field(info, 'id') || ''),
      name: String(field(info, 'name') || ''),
      packageId: field(info, 'packageId') || null,
      version: field(info, 'version') || null,
      show: field(info, 'show') !== false,
      categories: categories && categories.length ? Array.prototype.slice.call(categories) : [],
      iconPath: String(field(info, 'iconPath') || '')
    };
  }

  var waitingForApps = [];

  // getAppsInfo peut prendre plusieurs secondes : une seule lecture à la fois, gardée 5 min.
  function loadApps(force, done) {
    var apps = state.apps;
    if (!force && apps.list && Date.now() - apps.at < APPS_MAX_AGE) { return done(); }
    waitingForApps.push(done);
    if (waitingForApps.length > 1) { return; }
    var t0 = Date.now();
    function finish(list, error) {
      apps.ms = Date.now() - t0;
      apps.at = Date.now();
      if (list) { apps.list = list; apps.error = null; } else { apps.error = error; }
      var callbacks = waitingForApps;
      waitingForApps = [];
      callbacks.forEach(function (callback) { callback(); });
    }
    if (!hasTizen) { return finish(null, "L'objet tizen est absent de ce service."); }
    try {
      tizen.application.getAppsInfo(function (infos) {
        var list = [];
        for (var i = 0; i < infos.length; i++) { list.push(toApp(infos[i])); }
        list.sort(function (x, y) { return x.name.toLowerCase().localeCompare(y.name.toLowerCase()); });
        finish(list, null);
      }, function (err) {
        finish(null, describe(err));
      });
    } catch (e) {
      finish(null, describe(e));
    }
  }

  function findApp(id) {
    var list = state.apps.list || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function launchApp(id, done) {
    var app = findApp(id);
    if (!app) { return done(404, { ok: false, error: 'Identifiant absent de la liste de la TV.' }); }
    var t0 = Date.now();
    var entry = { id: app.id, name: app.name, at: t0, ms: null, ok: null, error: null };
    state.launches.push(entry);
    if (state.launches.length > MAX_LAUNCHES) { state.launches.shift(); }
    var timer = null;
    function settle(ok, error) {
      if (entry.ok !== null) { return; }
      if (timer) { clearTimeout(timer); }
      entry.ms = Date.now() - t0;
      entry.ok = ok;
      entry.error = error || null;
      done(200, { ok: ok, ms: entry.ms, error: entry.error });
    }
    if (!hasTizen) { return settle(false, "L'objet tizen est absent de ce service."); }
    timer = setTimeout(function () {
      settle(false, 'Pas de réponse de la TV après ' + Math.round(LAUNCH_TIMEOUT / 1000) + ' s.');
    }, LAUNCH_TIMEOUT);
    try {
      tizen.application.launch(app.id, function () { settle(true); }, function (err) { settle(false, describe(err)); });
    } catch (e) {
      settle(false, describe(e));
    }
  }

  function iconFile(iconPath) {
    var p = String(iconPath || '');
    if (p.indexOf('file://') === 0) { p = p.slice(7); }
    if (!p || p.indexOf('..') !== -1) { return null; }
    var ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (!ICON_TYPES[ext]) { return null; }
    for (var i = 0; i < ICON_ROOTS.length; i++) {
      if (p.indexOf(ICON_ROOTS[i]) === 0) { return p; }
    }
    return null;
  }

  function serveIcon(id, res) {
    var app = findApp(String(id || ''));
    var file = app ? iconFile(app.iconPath) : null;
    if (!file) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    var type = ICON_TYPES[file.slice(file.lastIndexOf('.')).toLowerCase()];
    var stream = fs.createReadStream(file);
    stream.on('error', function () {
      if (!res.headersSent) { res.writeHead(404, { 'Cache-Control': 'no-store' }); }
      res.end();
    });
    stream.on('open', function () {
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
      stream.pipe(res);
    });
  }

  /* ---------- Rapport ---------- */

  function recordPage(query) {
    var now = Date.now();
    function plausible(value) { return isFinite(value) && value > 0 && Math.abs(now - value) < 86400000; }
    var nav = Number(query.nav);
    var ready = Number(query.ready);
    var tries = Number(query.tries);
    var waited = Number(query.waited);
    var visit = {
      navigationStart: plausible(nav) ? nav : null,
      readyAt: plausible(ready) ? ready : now,
      seenAt: now,
      tries: isFinite(tries) && tries > 0 ? tries : null,
      waitedMs: isFinite(waited) && waited >= 0 && waited < 86400000 ? waited : null
    };
    if (!state.page) {
      state.page = { first: visit, last: visit, visits: 1 };
    } else {
      state.page.last = visit;
      state.page.visits += 1;
    }
  }

  function timings() {
    var t = {
      tizenbrewStartedAt: state.tizenbrewStartedAt,
      serviceStartedAt: state.startedAt,
      serviceAfterTizenbrewMs: state.startedAt - state.tizenbrewStartedAt,
      appsListMs: state.apps.ms,
      tizenbrewToModuleMs: null,
      pageLoadMs: null,
      pageVisits: 0,
      pageTries: null,
      pageWaitedForServiceMs: null
    };
    var first = state.page && state.page.first;
    if (first) {
      t.pageVisits = state.page.visits;
      t.pageTries = first.tries;
      t.pageWaitedForServiceMs = first.waitedMs;
      if (first.navigationStart) {
        t.tizenbrewToModuleMs = first.navigationStart - state.tizenbrewStartedAt;
        t.pageLoadMs = first.readyAt - first.navigationStart;
      }
    }
    return t;
  }

  function lanInfo() {
    var lan = state.lan;
    return {
      port: lan.port, open: lan.open, until: lan.until, openedAt: lan.openedAt,
      closedAt: lan.closedAt, closedBy: lan.closedBy, error: lan.error, addresses: lanAddresses()
    };
  }

  function appsSummary(withList) {
    var list = state.apps.list || [];
    var visible = 0;
    for (var i = 0; i < list.length; i++) { if (list[i].show) { visible += 1; } }
    var summary = { count: list.length, visible: visible, ms: state.apps.ms, at: state.apps.at, error: state.apps.error };
    if (withList) {
      summary.list = list.map(function (a) {
        return { id: a.id, name: a.name, show: a.show, version: a.version, packageId: a.packageId, categories: a.categories, icon: !!iconFile(a.iconPath) };
      });
    }
    return summary;
  }

  function report() {
    return {
      module: 'diagnostic-applis-tv',
      version: VERSION,
      generatedAt: Date.now(),
      platform: state.platform,
      model: state.model,
      node: state.node,
      timings: timings(),
      apps: appsSummary(true),
      launches: state.launches,
      requests: state.requests,
      local: state.local,
      lan: lanInfo()
    };
  }

  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function seconds(ms) {
    return ms === null || ms === undefined ? 'non mesuré' : (ms / 1000).toFixed(1).replace('.', ',') + ' s';
  }

  function summaryHtml() {
    var r = report();
    var rows = r.apps.list.filter(function (a) { return a.show; }).map(function (a) {
      return '<tr><td>' + escapeHtml(a.name) + '</td><td><code>' + escapeHtml(a.id) + '</code></td></tr>';
    }).join('');
    var launches = r.launches.map(function (l) {
      return '<tr><td>' + escapeHtml(l.name) + '</td><td>' + (l.ok === null ? 'en cours' : (l.ok ? 'appel accepté' : 'échec : ' + escapeHtml(l.error))) +
        '</td><td>' + (l.ms === null ? '' : l.ms + ' ms') + '</td></tr>';
    }).join('');
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Diagnostic applis TV</title>' +
      '<style>body{font:16px sans-serif;margin:24px}td{padding:2px 12px 2px 0}code{font-size:14px}</style></head><body>' +
      '<h1>Diagnostic applis TV ' + escapeHtml(r.version) + '</h1>' +
      '<p>Tizen ' + escapeHtml(r.platform) + ', ' + escapeHtml(r.model) + ', Node ' + escapeHtml(r.node) + '</p>' +
      '<p>Applis visibles : ' + r.apps.visible + ' sur ' + r.apps.count + ' entrées, liste lue en ' + seconds(r.apps.ms) +
      (r.apps.error ? ', erreur : ' + escapeHtml(r.apps.error) : '') + '</p>' +
      '<p>TizenBrew jusqu\'au module : ' + seconds(r.timings.tizenbrewToModuleMs) + ' ; chargement de la page : ' + seconds(r.timings.pageLoadMs) +
      ' ; attente du service par la page : ' + seconds(r.timings.pageWaitedForServiceMs) + '</p>' +
      '<p>Demandes de la page reçues : ' + r.requests.session + ' ; refus : ' + r.requests.refused.length + '</p>' +
      '<p>Rapport complet : <a href="/rapport">/rapport</a> (JSON). Accès réseau fermé automatiquement à ' +
      escapeHtml(r.lan.until ? new Date(r.lan.until).toTimeString().slice(0, 5) : '?') + '.</p>' +
      '<form method="post" action="/fermer"><button type="submit">Fermer l\'accès réseau maintenant</button></form>' +
      '<h2>Lancements</h2><table>' + (launches || '<tr><td>Aucun pour l\'instant.</td></tr>') + '</table>' +
      '<h2>Applis visibles</h2><table>' + rows + '</table></body></html>';
  }

  /* ---------- HTTP ---------- */

  function send(res, status, data, headers) {
    var h = headers || {};
    h['Content-Type'] = 'application/json; charset=utf-8';
    h['Cache-Control'] = 'no-store';
    res.writeHead(status, h);
    res.end(JSON.stringify(data));
  }

  function readJson(req, done) {
    var body = '';
    var tooLarge = false;
    req.on('data', function (chunk) {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', function () {
      if (tooLarge) { return; }
      var data = null;
      try { data = body ? JSON.parse(body) : {}; } catch (e) { data = null; }
      done(data);
    });
  }

  // Refus noté dans le rapport, et lisible par la page : sans en-tête CORS,
  // le navigateur ne montrerait qu'une erreur réseau, comme un service arrêté.
  function refuse(req, res, reason) {
    var origin = req.headers.origin;
    state.requests.refused.push({
      at: Date.now(), reason: reason, origin: origin || null, remote: cleanAddress(req.socket.remoteAddress),
      method: req.method, path: urlLib.parse(req.url).pathname
    });
    if (state.requests.refused.length > 20) { state.requests.refused.shift(); }
    send(res, 403, { error: reason + (origin ? ' (' + origin + ').' : '.') }, origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {});
  }

  function handleLocal(req, res) {
    var parsed = urlLib.parse(req.url, true);
    var path = parsed.pathname;
    var origin = req.headers.origin;
    if (path === '/session') {
      state.requests.session += 1;
      state.requests.lastSessionAt = Date.now();
    }
    if (!isLoopback(req.socket.remoteAddress)) { return refuse(req, res, 'Réservé à la TV'); }

    // Les icônes sont chargées par des balises <img>, sans en-tête Origin.
    if (req.method === 'GET' && path === '/icone') { return serveIcon(parsed.query.id, res); }

    if (ORIGINS.indexOf(origin) === -1) { return refuse(req, res, 'Origine refusée'); }
    var cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };

    if (req.method === 'OPTIONS') {
      cors['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      cors['Access-Control-Allow-Headers'] = 'Content-Type, X-Diag-Token';
      cors['Access-Control-Max-Age'] = '600';
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method === 'GET' && path === '/session') {
      recordPage(parsed.query);
      return send(res, 200, {
        token: token, version: VERSION, platform: state.platform, model: state.model, node: state.node,
        timings: timings(), lan: lanInfo(), local: state.local
      }, cors);
    }
    if (req.method === 'GET' && path === '/applis') {
      return loadApps(parsed.query.recharger === '1', function () { send(res, 200, appsSummary(true), cors); });
    }
    if (req.method === 'GET' && path === '/etat') { return send(res, 200, report(), cors); }

    if (req.method === 'POST') {
      if (req.headers['x-diag-token'] !== token) { return send(res, 403, { error: 'Jeton absent ou faux.' }, cors); }
      if (path === '/lancer') {
        return readJson(req, function (data) {
          if (!data || typeof data.id !== 'string') { return send(res, 400, { error: 'Requête mal formée.' }, cors); }
          loadApps(false, function () {
            launchApp(data.id, function (status, payload) { send(res, status, payload, cors); });
          });
        });
      }
      if (path === '/reseau/fermer') {
        closeLan('page');
        return send(res, 200, { lan: lanInfo() }, cors);
      }
      if (path === '/reseau/ouvrir') {
        return openLan(function () { send(res, 200, { lan: lanInfo() }, cors); });
      }
    }
    send(res, 404, { error: 'Introuvable.' }, cors);
  }

  function handleLan(req, res) {
    if (!isPrivate(req.socket.remoteAddress)) {
      res.writeHead(403);
      return res.end();
    }
    var path = urlLib.parse(req.url).pathname;
    if (req.method === 'GET' && path === '/rapport') {
      return loadApps(false, function () { send(res, 200, report()); });
    }
    if (req.method === 'GET' && path === '/') {
      return loadApps(false, function () {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(summaryHtml());
      });
    }
    if (req.method === 'POST' && path === '/fermer') {
      res.on('finish', function () { closeLan('pc'); });
      return send(res, 200, { ok: true, message: 'Accès réseau fermé.' });
    }
    send(res, 404, { error: 'Introuvable.' });
  }

  /* ---------- Accès réseau, limité dans le temps ---------- */

  var lanServer = null;
  var lanTimer = null;
  var lanSockets = [];

  function armLanTimer() {
    if (lanTimer) { clearTimeout(lanTimer); }
    state.lan.until = Date.now() + LAN_MINUTES * 60000;
    lanTimer = setTimeout(function () { closeLan('délai'); }, LAN_MINUTES * 60000);
  }

  function openLan(done) {
    var finish = done || function () {};
    if (lanServer) {
      armLanTimer();
      return finish();
    }
    var server = http.createServer(handleLan);
    server.on('connection', function (socket) {
      lanSockets.push(socket);
      socket.on('close', function () {
        var i = lanSockets.indexOf(socket);
        if (i !== -1) { lanSockets.splice(i, 1); }
      });
    });
    server.on('error', function (e) {
      state.lan.open = false;
      state.lan.error = e.code || describe(e);
      if (lanServer === server) { lanServer = null; }
      finish();
    });
    server.listen(LAN_PORT, LAN_HOST, function () {
      lanServer = server;
      state.lan.open = true;
      state.lan.error = null;
      state.lan.openedAt = Date.now();
      state.lan.closedAt = null;
      state.lan.closedBy = null;
      armLanTimer();
      finish();
    });
  }

  function closeLan(by) {
    if (lanTimer) {
      clearTimeout(lanTimer);
      lanTimer = null;
    }
    if (lanServer) {
      lanServer.close();
      lanSockets.forEach(function (socket) { socket.destroy(); });
      lanSockets = [];
      lanServer = null;
      state.lan.closedAt = Date.now();
      state.lan.closedBy = by;
    }
    state.lan.open = false;
    state.lan.until = null;
  }

  /* ---------- Démarrage ---------- */

  var localServer = http.createServer(handleLocal);
  localServer.on('error', function (e) {
    state.local.listening = false;
    state.local.error = e.code || describe(e);
  });
  localServer.listen(LOCAL_PORT, '127.0.0.1', function () { state.local.listening = true; });

  openLan();
  loadApps(false, function () {});

  // Pour les tests ; TizenBrew ne lit pas module.exports.
  if (typeof module !== 'undefined' && module) {
    module.exports = {
      version: VERSION,
      state: state,
      isPrivate: isPrivate,
      isLoopback: isLoopback,
      iconFile: iconFile,
      stop: function () {
        closeLan('arrêt');
        localServer.close();
      }
    };
  }
})();
