'use strict';

// Outils communs aux tests : charge le service comme TizenBrew le fait (bac à sable vm,
// `require`, `tizen` et `module` fournis), avec une fausse API tizen.

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const SERVICE_FILE = path.join(ROOT, 'service', 'service.js');

// Même construction que utils/serviceLauncher.js de TizenBrew.
function loadService({ tizen, config }) {
  const sandbox = {};
  Object.getOwnPropertyNames(global).forEach((prop) => {
    if (['services', 'module', 'global', 'inDebug', 'currentClient', 'currentModule'].includes(prop)) return;
    try {
      sandbox[prop] = global[prop];
    } catch {
      // Quelques globales récentes de Node refusent la lecture : TizenBrew ne les a pas non plus.
    }
  });
  sandbox.require = require;
  sandbox.module = { exports: {} };
  if (tizen) sandbox.tizen = tizen;
  sandbox.DIAG_CONFIG = config;
  vm.runInContext(fs.readFileSync(SERVICE_FILE, 'utf8'), vm.createContext(sandbox));
  return sandbox.module.exports;
}

// Fausse API tizen. Le champ `size` lève une erreur comme sur une TV sans le privilège application.info.
function fakeTizen(apps, options = {}) {
  const calls = { launch: [], getAppsInfo: 0, sizeTouched: false };
  const infos = apps.map((app) => {
    const info = {
      id: app.id,
      name: app.name,
      iconPath: app.iconPath || '',
      version: '1.0.0',
      show: app.show !== false,
      categories: app.categories || [],
      packageId: app.id.split('.')[0]
    };
    Object.defineProperty(info, 'size', {
      enumerable: true,
      get() {
        calls.sizeTouched = true;
        throw new Error('SecurityError: application.info privilege required');
      }
    });
    return info;
  });
  return {
    calls,
    application: {
      getAppsInfo(success, error) {
        calls.getAppsInfo += 1;
        setTimeout(() => {
          if (options.appsError) error({ name: 'UnknownError', message: options.appsError });
          else success(infos);
        }, options.appsDelay || 5);
      },
      launch(id, success, error) {
        calls.launch.push(id);
        if (options.launchSilent && options.launchSilent.includes(id)) return;
        setTimeout(() => {
          if (options.launchFails && options.launchFails.includes(id)) error({ name: 'NotFoundError', message: 'Application not found' });
          else success();
        }, 5);
      }
    },
    systeminfo: {
      getCapability(key) {
        return key.endsWith('platform.version') ? '5.5' : 'MODELE-TEST';
      }
    }
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function call(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      agent: false,
      headers: Object.assign(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers)
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitFor(check, { timeout = 5000, step = 20 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      Promise.resolve()
        .then(check)
        .then((value) => {
          if (value) return resolve(value);
          if (Date.now() - started > timeout) return reject(new Error('Délai dépassé'));
          setTimeout(poll, step);
        }, reject);
    })();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { ROOT, loadService, fakeTizen, freePort, call, waitFor, sleep };
