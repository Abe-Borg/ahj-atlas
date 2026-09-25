import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export class KeyVault{
  constructor({dir}={}){this.key='';this.persisted=false;this.file=path.join(dir||path.join(process.env.LOCALAPPDATA||os.homedir(),'AHJ Atlas'),'credential.bin');this.load();}
  crypt(value,decrypt=false){
    if(process.platform!=='win32')throw new Error('Protected key storage is available on Windows. Use a session-only key on this computer.');
    const script=`Add-Type -AssemblyName System.Security\n$data = [Console]::In.ReadToEnd()\n$bytes = [Convert]::FromBase64String($data)\n$result = [System.Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n[Console]::Out.Write([Convert]::ToBase64String($result))`;
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{input:Buffer.from(value).toString('base64'),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:50000});
    if(result.status!==0)throw new Error('Windows could not protect the key. Leave “Remember” unchecked to use it for this session.');
    return Buffer.from(result.stdout.trim(),'base64');
  }
  load(){if(process.platform!=='win32'||!existsSync(this.file))return;try{this.key=this.crypt(readFileSync(this.file),true).toString('utf8');this.persisted=Boolean(this.key);}catch{this.key='';}}
  set(key,remember){
    if(remember){const encrypted=this.crypt(Buffer.from(key));mkdirSync(path.dirname(this.file),{recursive:true});writeFileSync(this.file,encrypted,{mode:0o600});this.persisted=true;}
    else{if(existsSync(this.file))unlinkSync(this.file);this.persisted=false;}
    this.key=key;
  }
  clear(){this.key='';this.persisted=false;if(existsSync(this.file))unlinkSync(this.file);}
}
