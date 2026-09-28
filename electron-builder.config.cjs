// The disposable unpacked smoke build includes one synthetic fixture module.
// The installer build excludes the entire tests tree.
const smoke=process.env.ATLAS_PACKAGED_SMOKE==='1';

module.exports={
  appId:'org.ahjatlas.desktop',
  productName:'AHJ Atlas',
  directories:{output:'dist',buildResources:'build'},
  asar:true,
  files:[
    'package.json','server.mjs','desktop/**/*','lib/**/*','public/**/*',
    ...(smoke?['tests/fixtures.mjs']:[]),
    '!**/*.map',
  ],
  asarUnpack:['**/*.node','**/node_modules/@napi-rs/canvas-win32-x64-msvc/**'],
  win:{target:[{target:'nsis',arch:['x64']}],icon:'build/icon.ico',executableName:'AHJ Atlas',forceCodeSigning:false},
  nsis:{
    artifactName:'AHJ-Atlas-${version}-Windows-x64-Setup.${ext}',
    oneClick:false,perMachine:false,allowElevation:false,
    allowToChangeInstallationDirectory:false,
    createDesktopShortcut:false,createStartMenuShortcut:true,
    shortcutName:'AHJ Atlas',uninstallDisplayName:'AHJ Atlas',
    deleteAppDataOnUninstall:false,runAfterFinish:false,
  },
};
