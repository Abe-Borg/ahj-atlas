import path from 'node:path';
import os from 'node:os';

export const PRODUCT_NAME='AHJ Atlas';

export function desktopPaths({app,env=process.env,args=process.argv,tempDir=os.tmpdir()}={}){
  const packaged=Boolean(app.isPackaged);
  const userData=packaged?app.getPath('userData')
    :env.ATLAS_DESKTOP_PROFILE_DIR?path.resolve(env.ATLAS_DESKTOP_PROFILE_DIR)
      :path.join(tempDir,'AHJ Atlas Desktop Dev');
  const dataDir=!packaged&&env.ATLAS_DESKTOP_DATA_DIR
    ?path.resolve(env.ATLAS_DESKTOP_DATA_DIR):path.join(userData,'data');
  // KeyVault has always used LOCALAPPDATA/AHJ Atlas. Do not append the product
  // name to userData: the packaged app already sets it to that exact folder.
  const localAppData=env.LOCALAPPDATA||app.getPath('appData');
  const credentialDir=packaged?path.join(localAppData,PRODUCT_NAME)
    :path.join(userData,'fake-localappdata',PRODUCT_NAME);
  const legacyHint=!packaged&&env.ATLAS_DESKTOP_LEGACY_DIR
    ?path.resolve(env.ATLAS_DESKTOP_LEGACY_DIR)
    :packaged?path.join(process.cwd(),'data'):null;
  return {packaged,userData,dataDir,credentialDir,legacyHint,
    migrationEnabled:packaged||Boolean(legacyHint)||args.includes('--migration-smoke')};
}
