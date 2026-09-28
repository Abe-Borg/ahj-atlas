import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Build the Windows x64 installer on Windows x64.');
const mode=process.argv[2];
if(!['--dir','--dir-smoke','--installer'].includes(mode))throw new Error('Choose --dir, --dir-smoke, or --installer.');
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const builder=path.join(root,'node_modules','electron-builder','cli.js');
const args=[builder,'--config','electron-builder.config.cjs','--win','--x64','--publish','never'];
if(mode!=='--installer')args.push('--dir');
const run=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:{...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false',ATLAS_PACKAGED_SMOKE:mode==='--dir-smoke'?'1':'0'}});
if(run.error)throw run.error;
if(run.status!==0){process.exitCode=run.status??1;}
else{
  const audit=spawnSync(process.execPath,[path.join(root,'scripts','audit-windows-package.mjs'),mode],{cwd:root,stdio:'inherit'});
  if(audit.error)throw audit.error;
  process.exitCode=audit.status??1;
}
