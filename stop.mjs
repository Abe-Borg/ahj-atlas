const url='http://127.0.0.1:4318';
try{
  const bootstrap=await(await fetch(url+'/api/bootstrap',{signal:AbortSignal.timeout(3000)})).json();
  if(bootstrap.application!=='AHJ Atlas')throw new Error('No AHJ Atlas instance found.');
  const response=await fetch(url+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':bootstrap.token},body:'{}'});
  if(!response.ok)throw new Error('The app did not accept the shutdown request.');
  console.log('AHJ Atlas is finishing in-flight requests and saving its state. Submitted batches will remain available when you reopen the app.');
}catch(e){console.log('AHJ Atlas is not running, or could not be reached.');}
