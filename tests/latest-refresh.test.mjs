import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLatest } from '../public/latest-refresh.js';

function deferred(){
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

// The same contract as list_research_projects: await the refresh, then read the shared list.
function projectList(){
  const lists=createLatest();
  let projects=[{name:'Running synthetic project',status:'researching',cost:1}];
  return {
    get projects(){return projects;},
    invalidate(){lists.invalidate();},
    refresh(load){
      return lists.run(async isCurrent=>{
        const next=await load;
        if(!isCurrent())return;
        projects=next;
      });
    },
    async listed(load){
      await this.refresh(load);
      return projects.map(p=>({name:p.name,status:p.status,cost:p.cost}));
    },
  };
}

test('an earlier project refresh waits for the newer one before callers read the list',async()=>{
  const lists=projectList();
  const first=deferred(),second=deferred();
  let firstSettled=false;
  const listed=lists.listed(first.promise).then(value=>{firstSettled=true;return value;});
  const later=lists.listed(second.promise);
  first.resolve([{name:'From the earlier fetch',status:'researching',cost:1}]);
  await flush();
  assert.equal(firstSettled,false);
  assert.equal(lists.projects[0].name,'Running synthetic project');
  second.resolve([{name:'Running synthetic project draft',status:'complete',cost:4}]);
  assert.deepEqual(await listed,[{name:'Running synthetic project draft',status:'complete',cost:4}]);
  assert.deepEqual(await later,[{name:'Running synthetic project draft',status:'complete',cost:4}]);
});

test('a superseded project refresh that fails still returns the newer list',async()=>{
  const lists=projectList();
  const first=deferred(),second=deferred();
  const listed=lists.listed(first.promise);
  const later=lists.listed(second.promise);
  first.reject(new Error('The earlier list request failed.'));
  second.resolve([{name:'Fresh project',status:'queued',cost:0}]);
  assert.deepEqual(await listed,[{name:'Fresh project',status:'queued',cost:0}]);
  assert.deepEqual(await later,[{name:'Fresh project',status:'queued',cost:0}]);
});

test('the newest project refresh rejects every caller waiting on it',async()=>{
  const lists=projectList();
  const first=deferred(),second=deferred();
  const listed=lists.listed(first.promise);
  const later=lists.listed(second.promise);
  first.resolve([{name:'Ignored',status:'researching',cost:1}]);
  second.reject(new Error('The current list request failed.'));
  await assert.rejects(listed,/The current list request failed/);
  await assert.rejects(later,/The current list request failed/);
  assert.equal(lists.projects[0].name,'Running synthetic project');
});

test('a local project edit discards an in-flight list without leaving the caller waiting',async()=>{
  const lists=projectList();
  const load=deferred();
  const pending=lists.refresh(load.promise);
  lists.invalidate();
  load.resolve([{name:'Stale poll',status:'researching',cost:1}]);
  await pending;
  assert.equal(lists.projects[0].name,'Running synthetic project');
});

test('three overlapping project refreshes publish only the last list',async()=>{
  const lists=projectList();
  const loads=[deferred(),deferred(),deferred()];
  const pending=loads.map(load=>lists.listed(load.promise));
  loads[0].resolve([{name:'First',status:'researching',cost:1}]);
  loads[1].resolve([{name:'Second',status:'researching',cost:2}]);
  await flush();
  assert.equal(lists.projects[0].name,'Running synthetic project');
  loads[2].resolve([{name:'Third',status:'complete',cost:3}]);
  const results=await Promise.all(pending);
  assert.deepEqual(results,Array(3).fill([{name:'Third',status:'complete',cost:3}]));
});

test('the page list tool waits on the shared project refresh',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(source,/const projectLists=createLatest\(\)/);
  assert.match(source,/await projectLists\.run\(async isCurrent=>\{/);
  assert.match(source,/projectLists\.invalidate\(\)/);
  assert.match(source,/execute:async\(\)=>\{await refreshProjects\(\);return state\.projects\.map/);
});
