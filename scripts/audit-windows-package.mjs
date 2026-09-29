import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage, extractFile } from '@electron/asar';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.resolve(root,process.env.ATLAS_BUILD_OUTPUT||'dist');
const mode=process.argv[2];
assert.ok(['--dir','--dir-smoke','--installer'].includes(mode));
const archive=path.join(output,'win-unpacked','resources','app.asar');
assert.ok(existsSync(archive),'Packaged app.asar is missing.');
const names=listPackage(archive).map(name=>name.replaceAll('\\','/'));
for(const file of ['/package.json','/LICENSE','/server.mjs','/desktop/main.mjs','/desktop/lifecycle.mjs','/lib/store.mjs','/public/app.js'])
  assert.ok(names.includes(file),`Missing required app file ${file}`);
for(const dependency of ['@anthropic-ai/sdk','@napi-rs/canvas','exceljs','pdfjs-dist','pdfkit','puppeteer-core'])
  assert.ok(names.includes(`/node_modules/${dependency}`),`Missing production dependency ${dependency}`);
const rootForbidden=/^\/(?:data|test-results|scripts|docs|build|\.git)(?:\/|$)|^\/(?:\.env|README\.md|package-lock\.json)$/i;
assert.deepEqual(names.filter(name=>rootForbidden.test(name)),[],'Unexpected workspace or build files in app.asar.');
const testFiles=names.filter(name=>name==='/tests'||name.startsWith('/tests/'));
assert.deepEqual(testFiles,mode==='--dir-smoke'?['/tests','/tests/fixtures.mjs']:[],'Unexpected test files in app.asar.');
assert.ok(!names.some(name=>name.startsWith('/node_modules/electron-builder')||name.startsWith('/node_modules/electron/')),'Development dependencies were packaged.');
const expected=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
const actual=JSON.parse(extractFile(archive,'package.json').toString()).version;
assert.equal(actual,expected,'Packaged version differs from source metadata.');
const unpacked=path.join(output,'win-unpacked','resources','app.asar.unpacked','node_modules','@napi-rs','canvas-win32-x64-msvc');
for(const filename of ['skia.win32-x64-msvc.node','icudtl.dat'])
  assert.ok(existsSync(path.join(unpacked,filename)),`Native canvas resource ${filename} was not unpacked.`);
if(mode==='--installer'){
  const installer=path.join(output,`AHJ-Atlas-${expected}-Windows-x64-Setup.exe`);
  assert.ok(existsSync(installer),'Unsigned NSIS installer is missing.');
}
console.log(`Package audit passed: ${actual}, ${names.length} ASAR entries, ${mode==='--dir-smoke'?'synthetic smoke fixture':'no test files'}.`);
