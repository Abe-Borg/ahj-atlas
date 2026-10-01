// Overlapping reads of one value. The newest read is the only one that may publish.
// A caller that started earlier waits for that read, so awaiting it cannot observe
// the value from before either request.
export function createLatest(){
  let generation=0;
  let current=Promise.resolve();
  return {
    // A local edit is newer than a read that has already left.
    invalidate(){generation+=1;},
    run(work){
      const token=++generation;
      const pending=Promise.resolve().then(()=>work(()=>token===generation));
      pending.catch(()=>{});
      current=pending;
      return (async()=>{
        let watched=pending;
        for(;;){
          try{await watched;}
          catch(error){if(watched===current)throw error;}
          if(watched===current)return;
          watched=current;
        }
      })();
    },
  };
}
