import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';

const REPOSITORY='https://github.com/Abe-Borg/ahj-atlas';
const RELEASES_API='https://api.github.com/repos/Abe-Borg/ahj-atlas/releases/latest';
const CHECK_INTERVAL_MS=24*60*60*1000;
const DOWNLOAD_IDLE_MS=60*1000;
const MAX_INSTALLER_BYTES=1024*1024*1024;
const VERSION_PATTERN=/^\d+\.\d+\.\d+$/;
const INSTALLER_FILE=/^AHJ-Atlas-\d+\.\d+\.\d+-Windows-x64-Setup\.exe(?:\.partial)?$/;
// Update an installed copy in place: skip the license and folder pages, install
// silently, then reopen the app. The installer waits for this app to exit.
export const INSTALLER_ARGS=['--updated','/S','--force-run'];
const installerName=version=>`AHJ-Atlas-${version}-Windows-x64-Setup.exe`;
// Messages written for the user; other failures (network, disk) get a generic one.
class UpdateError extends Error{}

export function compareVersions(a,b){
  if(!VERSION_PATTERN.test(a)||!VERSION_PATTERN.test(b))throw new Error('Invalid release version.');
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;
  return 0;
}

function releaseDetails(release,currentVersion){
  const tag=release?.tag_name;
  if(release?.draft||release?.prerelease||typeof tag!=='string'||!/^v\d+\.\d+\.\d+$/.test(tag))throw new Error('Published release metadata is invalid.');
  const version=tag.slice(1);
  const assets=(release.assets||[]).filter(asset=>asset?.state==='uploaded');
  const installer=assets.find(asset=>asset.name===installerName(version));
  if(!installer||!assets.some(asset=>asset.name==='SHA256SUMS.txt'))throw new Error('The published Windows release is missing its installer or checksum.');
  return {latestVersion:version,releaseUrl:`https://github.com/Abe-Borg/ahj-atlas/releases/tag/${tag}`,updateAvailable:compareVersions(version,currentVersion)>0,
    installerBytes:Number.isSafeInteger(installer.size)&&installer.size>0?installer.size:null,
    installerDigest:/^sha256:([0-9a-f]{64})$/i.exec(String(installer.digest||''))?.[1].toLowerCase()||null};
}

export function checksumFor(text,name){
  if(typeof text!=='string'||text.length>65536)throw new UpdateError('The release checksum file is invalid.');
  for(const line of text.split(/\r?\n/)){
    const match=/^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if(match&&match[2]===name)return match[1].toLowerCase();
  }
  throw new UpdateError('The release checksum file does not list this installer.');
}

function hashFile(file){
  return new Promise((resolve,reject)=>{
    const hash=createHash('sha256');
    createReadStream(file).on('error',reject).on('data',chunk=>hash.update(chunk)).on('end',()=>resolve(hash.digest('hex')));
  });
}

// downloadDir and launchInstaller enable in-app installation (installed Windows app).
// Without them the checker only reports a newer release and links to it.
export function createUpdateChecker({dataDir,currentVersion,downloadDir=null,launchInstaller=null,fetchImpl=fetch,now=Date.now}){
  const file=path.join(dataDir,'update-check.json');
  const headers={Accept:'application/vnd.github+json','User-Agent':`AHJ-Atlas/${currentVersion}`};
  let saved={},ready=null,installing=null,notice=null,consumedInstall=false;
  try{
    const parsed=JSON.parse(readFileSync(file,'utf8'));
    if(parsed&&typeof parsed==='object'){
      // An install started by the previous run reports its outcome once.
      const started=parsed.installing;
      if(started&&VERSION_PATTERN.test(started.fromVersion||'')&&VERSION_PATTERN.test(started.toVersion||'')){
        consumedInstall=true;
        if(started.toVersion===currentVersion)notice={type:'updated',version:currentVersion};
        else if(started.fromVersion===currentVersion)notice={type:'failed',version:started.toVersion};
      }
      if(parsed.currentVersion===currentVersion){
        const latestVersion=typeof parsed.latestVersion==='string'&&VERSION_PATTERN.test(parsed.latestVersion)?parsed.latestVersion:null;
        saved={
          latestVersion,
          releaseUrl:latestVersion?`https://github.com/Abe-Borg/ahj-atlas/releases/tag/v${latestVersion}`:null,
          updateAvailable:latestVersion?compareVersions(latestVersion,currentVersion)>0:false,
          checkedAt:Number.isFinite(Date.parse(parsed.checkedAt))?parsed.checkedAt:null,
          lastAttemptAt:Number.isFinite(Date.parse(parsed.lastAttemptAt))?parsed.lastAttemptAt:null,
          error:typeof parsed.error==='string'?parsed.error:null,
        };
        const d=parsed.download;
        if(downloadDir&&VERSION_PATTERN.test(d?.version||'')&&/^[0-9a-f]{64}$/.test(d?.sha256||'')&&compareVersions(d.version,currentVersion)>0
          &&existsSync(path.join(downloadDir,installerName(d.version))))ready={version:d.version,sha256:d.sha256};
      }
    }
  }catch{}
  // Remove partial downloads and installers this version no longer needs.
  if(downloadDir)try{
    for(const name of readdirSync(downloadDir))if(INSTALLER_FILE.test(name)&&name!==(ready&&installerName(ready.version)))rmSync(path.join(downloadDir,name),{force:true});
  }catch{}
  let download={state:ready?'ready':'idle',version:ready?.version||null,receivedBytes:0,totalBytes:0,error:null};
  let inFlight=null,downloading=null;
  const status=()=>({currentVersion,latestVersion:saved.latestVersion||null,releaseUrl:saved.releaseUrl||null,
    updateAvailable:Boolean(saved.updateAvailable),checkedAt:saved.checkedAt||null,lastAttemptAt:saved.lastAttemptAt||null,
    error:saved.error||null,checking:Boolean(inFlight),canInstall:Boolean(downloadDir&&launchInstaller),
    download:{...download},installing:Boolean(installing),notice});
  const persist=()=>{
    const temporary=`${file}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify({currentVersion,...saved,...(ready?{download:ready}:{}),...(installing?{installing}:{})}));
    renameSync(temporary,file);
  };
  if(consumedInstall)try{persist();}catch{}
  const fetchRelease=async()=>{
    const response=await fetchImpl(RELEASES_API,{headers,signal:AbortSignal.timeout(10000)});
    if(response.status===404)return null;
    if(!response.ok)throw new Error(`GitHub returned HTTP ${response.status}.`);
    return releaseDetails(await response.json(),currentVersion);
  };
  const check=async({force=false}={})=>{
    if(inFlight){await inFlight;return status();}
    const elapsed=now()-Date.parse(saved.lastAttemptAt||'');
    if(!force&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<CHECK_INTERVAL_MS)return status();
    inFlight=(async()=>{
      const attemptedAt=new Date(now()).toISOString();
      try{
        const details=await fetchRelease();
        saved=details?{...details,lastAttemptAt:attemptedAt,checkedAt:attemptedAt}:{lastAttemptAt:attemptedAt,checkedAt:attemptedAt};
      }catch{
        saved={...saved,lastAttemptAt:attemptedAt,error:'Could not check GitHub Releases. Check your connection and try again.'};
      }
      try{persist();}catch{saved.error='Could not save the update check. Try again later.';}
    })();
    try{await inFlight;}finally{inFlight=null;}
    return status();
  };
  // Streams the installer to a partial file, hashing as it arrives. A stall
  // aborts the download; the size is bounded by the published asset size.
  const saveInstaller=async(url,target,expectedBytes)=>{
    const controller=new AbortController();let idle;
    const touch=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(),DOWNLOAD_IDLE_MS);};
    const handle=await open(target,'w');
    try{
      touch();
      const response=await fetchImpl(url,{headers:{'User-Agent':headers['User-Agent']},signal:controller.signal});
      if(!response.ok||!response.body)throw new UpdateError(`GitHub returned HTTP ${response.status} for the installer.`);
      if(response.url&&new URL(response.url).protocol!=='https:')throw new UpdateError('The installer download was redirected to an insecure address.');
      const limit=Math.min(expectedBytes||MAX_INSTALLER_BYTES,MAX_INSTALLER_BYTES),hash=createHash('sha256');let bytes=0;
      for await(const chunk of response.body){
        touch();bytes+=chunk.length;
        if(bytes>limit)throw new UpdateError('The installer is larger than its published size.');
        hash.update(chunk);await handle.write(chunk);download.receivedBytes=bytes;
      }
      if(expectedBytes&&bytes!==expectedBytes)throw new UpdateError('The installer download was incomplete.');
      return {sha256:hash.digest('hex'),bytes};
    }finally{clearTimeout(idle);await handle.close();}
  };
  const requireInstaller=()=>{if(!downloadDir||!launchInstaller)throw new UpdateError('In-app updates are available in the installed Windows app. Use the release page instead.');};
  // Starts a background download and returns at once; poll status() for progress.
  const startDownload=async()=>{
    requireInstaller();
    if(installing)throw new UpdateError('The update is already installing.');
    if(downloading)return status();
    // Report progress from the first response, before any network wait.
    download={state:'downloading',version:saved.latestVersion||null,receivedBytes:0,totalBytes:0,error:null};
    downloading=(async()=>{
      let version=null,partial=null;
      try{
        const details=await fetchRelease();
        if(!details?.updateAvailable)throw new UpdateError('No newer published release is available.');
        version=details.latestVersion;
        saved={...saved,...details,error:null};
        if(ready?.version===version){download={state:'ready',version,receivedBytes:0,totalBytes:0,error:null};return;}
        download={state:'downloading',version,receivedBytes:0,totalBytes:details.installerBytes||0,error:null};
        const name=installerName(version),base=`${REPOSITORY}/releases/download/v${version}/`;
        const sums=await fetchImpl(base+'SHA256SUMS.txt',{headers:{'User-Agent':headers['User-Agent']},signal:AbortSignal.timeout(10000)});
        if(!sums.ok)throw new UpdateError(`GitHub returned HTTP ${sums.status} for the checksum file.`);
        const expected=checksumFor(await sums.text(),name);
        if(details.installerDigest&&details.installerDigest!==expected)throw new UpdateError('The release checksum file and GitHub’s asset digest disagree. The update was not downloaded.');
        mkdirSync(downloadDir,{recursive:true});
        const target=path.join(downloadDir,name);partial=target+'.partial';
        const {sha256,bytes}=await saveInstaller(base+name,partial,details.installerBytes);
        if(sha256!==expected)throw new UpdateError('The downloaded installer did not match its published SHA-256 checksum and was deleted.');
        renameSync(partial,target);partial=null;
        if(ready)rmSync(path.join(downloadDir,installerName(ready.version)),{force:true});
        ready={version,sha256};
        download={state:'ready',version,receivedBytes:bytes,totalBytes:bytes,error:null};
        // Losing this record only means a restart downloads the installer again.
        try{persist();}catch{}
      }catch(error){
        if(partial)rmSync(partial,{force:true});
        download={state:'failed',version,receivedBytes:0,totalBytes:0,
          error:error instanceof UpdateError?error.message:'The download stopped. Check your connection and try again.'};
      }
    })().finally(()=>{downloading=null;});
    return status();
  };
  // Rechecks the saved installer, records the attempt, then hands it to the
  // desktop shell, which runs it after the app has closed its workspace.
  // beforeLaunch runs after hashing; returning false leaves the app running.
  const install=async({beforeLaunch=null}={})=>{
    requireInstaller();
    if(installing)return status();
    if(download.state!=='ready'||!ready)throw new UpdateError('Download the update before installing it.');
    const target=path.join(downloadDir,installerName(ready.version));
    let sha256=null;try{sha256=await hashFile(target);}catch{}
    if(sha256!==ready.sha256){
      rmSync(target,{force:true});
      download={state:'failed',version:ready.version,receivedBytes:0,totalBytes:0,error:'The downloaded installer changed or was removed. Download the update again.'};
      ready=null;try{persist();}catch{}
      throw new UpdateError(download.error);
    }
    if(beforeLaunch&&!beforeLaunch())return status();
    installing={fromVersion:currentVersion,toVersion:ready.version,startedAt:new Date(now()).toISOString()};
    try{persist();}catch{installing=null;throw new UpdateError('Could not record the update. Try again.');}
    launchInstaller(target,INSTALLER_ARGS);
    return status();
  };
  return {status,check,download:startDownload,install,settled:()=>downloading};
}
