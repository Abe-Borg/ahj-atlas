import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT={width:1440,height:960};

export function restoredBounds(userData,screen){
  if(!userData||!screen)return DEFAULT;
  let saved;
  try{saved=JSON.parse(readFileSync(path.join(userData,'window-state.json'),'utf8'));}
  catch{return DEFAULT;}
  if(![saved.x,saved.y,saved.width,saved.height].every(Number.isInteger))return DEFAULT;
  const bounds={x:saved.x,y:saved.y,width:Math.max(900,Math.min(3200,saved.width)),height:Math.max(650,Math.min(2200,saved.height))};
  const visible=screen.getAllDisplays().some(display=>{
    const area=display.workArea;
    return Math.min(bounds.x+bounds.width,area.x+area.width)-Math.max(bounds.x,area.x)>=120
      &&Math.min(bounds.y+bounds.height,area.y+area.height)-Math.max(bounds.y,area.y)>=80;
  });
  if(visible)return bounds;
  const area=screen.getPrimaryDisplay().workArea;
  bounds.width=Math.min(bounds.width,area.width);
  bounds.height=Math.min(bounds.height,area.height);
  bounds.x=area.x+Math.max(0,Math.floor((area.width-bounds.width)/2));
  bounds.y=area.y+Math.max(0,Math.floor((area.height-bounds.height)/2));
  return bounds;
}

export function saveWindowBounds(userData,window){
  if(!userData||window.isDestroyed()||window.isMinimized())return;
  const bounds=window.getNormalBounds();
  if(![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isInteger))return;
  const file=path.join(userData,'window-state.json');
  // userData is created by Electron before this window opens.
  writeFileSync(file,JSON.stringify(bounds));
}
