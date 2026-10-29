'use strict';

// Garde-fous pour la TV : Node ancien côté service (v4 possible), Chrome 69 côté page.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers/harness');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const service = fs.readFileSync(path.join(ROOT, 'service', 'service.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const pageScript = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const pageStyle = /<style>([\s\S]*)<\/style>/.exec(html)[1];

// Retire commentaires et chaînes pour ne chercher que dans le code.
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\/[^\n]*/g, ' ');
}

const ES5_FORBIDDEN = [
  [/=>/, 'fonction fléchée'],
  [/\blet\s/, 'let'],
  [/\bconst\s/, 'const'],
  [/`/, 'gabarit de chaîne'],
  [/\bclass\s+[A-Za-z_$]/, 'class'],
  [/\.\.\.[A-Za-z_$[(]/, 'décomposition ...'],
  [/\basync\s+function|\bawait\s/, 'async ou await'],
  [/\?\./, 'chaînage optionnel ?.'],
  [/\?\?/, 'coalescence ??'],
  [/\.includes\(/, 'includes, absent du Node 4.4.3'],
  [/Buffer\.(from|alloc)\(/, 'Buffer.from ou Buffer.alloc, absents du Node 4.4.3'],
  [/\.pad(Start|End)\(/, 'padStart ou padEnd'],
  [/Object\.(entries|values)\(/, 'Object.entries ou Object.values'],
  [/\bfor\s*\([^;)]*\bof\b/, 'for...of']
];

const CSS_FORBIDDEN = [
  [/(^|[^-])\bgap\s*:/, 'gap (absent en flexbox sur Chrome 69)'],
  [/aspect-ratio/, 'aspect-ratio (TV 2023 et après)'],
  [/backdrop-filter/, 'backdrop-filter (TV 2021 et après)'],
  [/\binset\s*:/, 'inset'],
  [/clamp\(/, 'clamp()'],
  [/:focus-visible|:is\(|:where\(/, 'sélecteurs récents']
];

function offences(source, rules) {
  return rules.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
}

describe('compatibilité avec la TV de 2020', () => {
  it('le service reste en ES5', () => {
    assert.deepEqual(offences(codeOnly(service), ES5_FORBIDDEN), []);
  });

  it('le script de la page reste en ES5', () => {
    assert.deepEqual(offences(codeOnly(pageScript), ES5_FORBIDDEN), []);
  });

  it('les deux scripts se compilent', () => {
    assert.doesNotThrow(() => new vm.Script(service));
    assert.doesNotThrow(() => new vm.Script(pageScript));
  });

  it('le style évite les propriétés absentes de Chrome 69', () => {
    assert.deepEqual(offences(pageStyle.replace(/\/\*[\s\S]*?\*\//g, ' '), CSS_FORBIDDEN), []);
  });
});

describe('manifeste TizenBrew', () => {
  it('décrit un module « app » avec page et service présents', () => {
    assert.equal(pkg.packageType, 'app');
    assert.ok(pkg.appName);
    assert.ok(fs.existsSync(path.join(ROOT, pkg.appPath)), pkg.appPath);
    assert.ok(fs.existsSync(path.join(ROOT, pkg.serviceFile)), pkg.serviceFile);
    assert.ok(Array.isArray(pkg.keys));
  });

  it('page, service et manifeste portent la même version', () => {
    assert.match(service, new RegExp("var VERSION = '" + pkg.version.replace(/\./g, '\\.') + "';"));
    assert.match(pageScript, new RegExp("var VERSION = '" + pkg.version.replace(/\./g, '\\.') + "';"));
  });
});
