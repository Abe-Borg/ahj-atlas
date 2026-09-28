import path from 'node:path';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const RELEASES_API='https://api.github.com/repos/Abe-Borg/ahj-atlas/releases/latest';
const CHECK_INTERVAL_MS=24*60*60*1000;
const VERSION_PATTERN=/^\d+\.\d+\.\d+$/;

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
  const installer=`AHJ-Atlas-${version}-Windows-x64-Setup.exe`;
  const names=new Set((release.assets||[]).filter(asset=>asset?.state==='uploaded').map(asset=>asset.name));
  if(!names.has(installer)||!names.has('SHA256SUMS.txt'))throw new Error('The published Windows release is missing its installer or checksum.');
  return {latestVersion:version,releaseUrl:`https://github.com/Abe-Borg/ahj-atlas/releases/tag/${tag}`,updateAvailable:compareVersions(version,currentVersion)>0};
}

export function createUpdateChecker({dataDir,currentVersion,fetchImpl=fetch,now=Date.now}){
  const file=path.join(dataDir,'update-check.json');
  let saved={};
  try{
    const parsed=JSON.parse(readFileSync(file,'utf8'));
    if(parsed&&typeof parsed==='object'&&parsed.currentVersion===currentVersion){
      const latestVersion=typeof parsed.latestVersion==='string'&&VERSION_PATTERN.test(parsed.latestVersion)?parsed.latestVersion:null;
      saved={
        latestVersion,
        releaseUrl:latestVersion?`https://github.com/Abe-Borg/ahj-atlas/releases/tag/v${latestVersion}`:null,
        updateAvailable:latestVersion?compareVersions(latestVersion,currentVersion)>0:false,
        checkedAt:Number.isFinite(Date.parse(parsed.checkedAt))?parsed.checkedAt:null,
        lastAttemptAt:Number.isFinite(Date.parse(parsed.lastAttemptAt))?parsed.lastAttemptAt:null,
        error:typeof parsed.error==='string'?parsed.error:null,
      };
    }
  }catch{}
  let inFlight=null;
  const status=()=>({currentVersion,latestVersion:saved.latestVersion||null,releaseUrl:saved.releaseUrl||null,
    updateAvailable:Boolean(saved.updateAvailable),checkedAt:saved.checkedAt||null,lastAttemptAt:saved.lastAttemptAt||null,
    error:saved.error||null,checking:Boolean(inFlight)});
  const persist=()=>{
    const temporary=`${file}.${process.pid}.tmp`;
    writeFileSync(temporary,JSON.stringify({currentVersion,...saved}));
    renameSync(temporary,file);
  };
  const check=async({force=false}={})=>{
    if(inFlight){await inFlight;return status();}
    const elapsed=now()-Date.parse(saved.lastAttemptAt||'');
    if(!force&&Number.isFinite(elapsed)&&elapsed>=0&&elapsed<CHECK_INTERVAL_MS)return status();
    inFlight=(async()=>{
      const attemptedAt=new Date(now()).toISOString();
      try{
        const response=await fetchImpl(RELEASES_API,{headers:{Accept:'application/vnd.github+json','User-Agent':`AHJ-Atlas/${currentVersion}`},signal:AbortSignal.timeout(10000)});
        if(response.status===404){saved={lastAttemptAt:attemptedAt,checkedAt:attemptedAt};}
        else{
          if(!response.ok)throw new Error(`GitHub returned HTTP ${response.status}.`);
          const details=releaseDetails(await response.json(),currentVersion);
          saved={...details,lastAttemptAt:attemptedAt,checkedAt:attemptedAt};
        }
      }catch{
        saved={...saved,lastAttemptAt:attemptedAt,error:'Could not check GitHub Releases. Check your connection and try again.'};
      }
      try{persist();}catch{saved.error='Could not save the update check. Try again later.';}
    })();
    try{await inFlight;}finally{inFlight=null;}
    return status();
  };
  return {status,check};
}
