/* Durable, target-specific GeoJSON queue. Uses the existing authenticated request. */
(function (root) {
  'use strict';
  const Z=root.ZoneCore;
  const encode=text=>{const bytes=new TextEncoder().encode(text);let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);};
  const decode=text=>new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g,'')),ch=>ch.charCodeAt(0)));
  const targetKey=target=>target?JSON.stringify([target.owner.toLowerCase(),target.repo.toLowerCase(),target.branch,target.path]):'local';
  class ZoneSync {
    constructor({storage,target=null,request=null,onChange=()=>{}}) {
      this.storage=storage;this.target=target?{...target}:null;this.request=request;this.onChange=onChange;
      this.key='pracownia.zones.v1:'+targetKey(target);this.raw=null;this.chain=Promise.resolve();this.running=false;this.polling=false;this.closed=false;this.error=null;this.retryAt=0;this.failures=0;
      this.state={version:1,target:this.target,base:Z.empty(),ops:[],hidden:[],seen:false};
      try {
        this.raw=storage.getItem(this.key);
        if(this.raw!==null){const saved=JSON.parse(this.raw);if(saved.version!==1 || targetKey(saved.target)!==targetKey(this.target) || !Array.isArray(saved.ops) || !Array.isArray(saved.hidden) || !saved.hidden.every(id=>typeof id==='string') || typeof saved.seen!=='boolean')throw Error('Nieprawidłowa kopia stref. Zachowano dane do odzyskania.');
          const ops=saved.ops.map(op=>Z.operation(op.kind,op.base,op.value,op.author,op.id,op.at));
          if(new Set(ops.map(op=>op.id)).size!==ops.length)throw Error('Nieprawidłowa kolejka stref.');
          this.state={version:1,target:this.target,base:Z.document(saved.base),ops,hidden:[...saved.hidden],seen:saved.seen};
        }
      }catch(error){this.loadError=error;this.error=error;}
      if(target){this.prefix='/repos/'+encodeURIComponent(target.owner)+'/'+encodeURIComponent(target.repo);this.endpoint=this.prefix+'/contents/'+target.path.split('/').map(encodeURIComponent).join('/');}
    }
    notify(){if(!this.closed)this.onChange(this.status());}
    status(){return {pending:this.state.ops.length>0,running:this.running,error:this.error,local:!this.target,connected:!!this.request,readonly:!!this.loadError};}
    view(){
      const data=Z.copy(this.state.base);
      for(const op of this.state.ops){const id=(op.value||op.base).id;data.features=data.features.filter(item=>item.id!==id);if(op.value)data.features.push(Z.copy(op.value));}
      return data.features;
    }
    change(update){
      const action=async()=>{
        if(this.closed)throw Error('Połączenie stref zmieniło się. Otwórz strefy ponownie.');
        if(this.loadError)throw this.loadError;
        const write=()=>{
          if(this.storage.getItem(this.key)!==this.raw){const error=Error('Strefy zmieniły się w innej karcie przeglądarki. Odśwież panel przed zapisem.');error.code='STALE';this.loadError=error;throw error;}
          const next=update(Z.copy(this.state)),raw=JSON.stringify(next);
          this.storage.setItem(this.key,raw);this.state=next;this.raw=raw;
        };
        if(root.navigator?.locks)await root.navigator.locks.request(this.key,write);else write();
      };
      const task=this.chain.then(action);this.chain=task.catch(()=>{});return task;
    }
    async apply(op){
      try {await this.change(state=>{
        if(this.target)state.ops.push(op);
        else {const result=Z.merge(state.base,[op]);if(result.conflicts.length)throw Error('Strefa zmieniła się. Otwórz ją ponownie.');state.base=result.data;}
        return state;
      });if(!this.target)this.error=null;this.notify();void this.flush();}
      catch(error){this.error=error;this.notify();throw error;}
    }
    async hide(id,hidden){await this.change(state=>{state.hidden=state.hidden.filter(value=>value!==id);if(hidden)state.hidden.push(id);return state;});this.notify();}
    async remote(request){
      let file;
      try {file=await(await request(this.endpoint+'?ref='+encodeURIComponent(this.target.branch))).json();}
      catch(error){if(error.status!==404)throw error;await request(this.prefix+'/branches/'+encodeURIComponent(this.target.branch));return {data:Z.empty(),missing:true};}
      if(file.type!=='file'||!file.sha||file.size>1024*1024)throw Error('Nieprawidłowy plik stref lub przekroczony limit 1 MB.');
      const text=file.encoding==='base64'&&file.content?decode(file.content):await(await request(this.prefix+'/git/blobs/'+encodeURIComponent(file.sha),{headers:{Accept:'application/vnd.github.raw+json'}})).text();
      if(text.length>1024*1024)throw Error('Plik stref przekracza limit 1 MB.');
      return {data:Z.document(JSON.parse(text)),sha:file.sha,missing:false};
    }
    missing(latest){if(latest.missing&&this.state.seen){const error=Error('Wspólny plik stref zniknął. Zachowano kopię; zapis jest wstrzymany.');error.code='MISSING';throw error;}}
    async flush(retry=false){
      if(this.closed||this.running||this.polling||this.loadError||!this.target||!this.request||!this.state.ops.length)return;
      if(!retry&&(this.retryAt>Date.now()||this.error?.code==='CONFLICT'||this.error?.code==='MISSING'||[401,403,404,422].includes(this.error?.status)))return;
      this.running=true;this.error=null;this.notify();const request=this.request;
      try {
        let collisions=0;
        while(this.state.ops.length&&!this.closed){
          const batch=Z.copy(this.state.ops),latest=await this.remote(request);if(this.closed)return;this.missing(latest);
          const result=Z.merge(latest.data,batch);
          if(result.conflicts.length){const error=Error('Strefy mają różne wersje. Porównaj zmiany w nagłówku.');error.code='CONFLICT';error.conflicts=result.conflicts;throw error;}
          if(!Z.equal(result.data,latest.data)){
            const text=JSON.stringify(result.data,null,2)+'\n';
            if(new TextEncoder().encode(text).length>1024*1024)throw Error('Plik stref przekracza limit 1 MB.');
            const author=batch.at(-1).author;
            try {await request(this.endpoint,{method:'PUT',body:JSON.stringify({message:'Strefy: aktualizacja — '+author,branch:this.target.branch,content:encode(text),...(latest.sha?{sha:latest.sha}:{})})});}
            catch(error){if((error.status===409||error.status===422&&/sha|does not match|is at/i.test(error.detail))&&collisions++<3)continue;throw error;}
          }
          if(this.closed)return;
          const accepted=new Set(batch.map(op=>op.id));
          await this.change(state=>{state.base=result.data;state.seen=!latest.missing||!Z.equal(result.data,latest.data);state.ops=state.ops.filter(op=>!accepted.has(op.id));return state;});
          this.failures=0;this.retryAt=0;this.notify();
        }
      }catch(error){if(!this.closed){this.error=error;this.retryAt=Date.now()+Math.min(30000,2000*2**Math.min(this.failures++,4));}}
      finally{this.running=false;this.notify();}
    }
    async poll(){
      if(this.closed||this.running||this.polling||!this.request||this.loadError)return;
      if(this.state.ops.length){await this.flush();return;}
      if(this.retryAt>Date.now())return;
      this.polling=true;
      try{const latest=await this.remote(this.request);if(this.closed)return;this.missing(latest);
        // A local edit made during the read retains its original base and queue.
        if(!this.state.ops.length&&!Z.equal(this.state.base,latest.data)||!this.state.ops.length&&!latest.missing&&!this.state.seen)await this.change(state=>{if(!state.ops.length){state.base=latest.data;state.seen=!latest.missing;}return state;});
        this.error=null;this.failures=0;this.retryAt=0;
      }catch(error){if(!this.closed){this.error=error;this.retryAt=Date.now()+Math.min(30000,2000*2**Math.min(this.failures++,4));}}
      finally{this.polling=false;this.notify();if(this.state.ops.length)void this.flush();}
    }
    async resolve(id,choice,reviewed,author){
      if(!['T','K'].includes(author)||!['local','remote'].includes(choice))throw Error('Wybierz T lub K w nagłówku, aby zapisać zmianę.');
      if(this.running||this.polling||!this.request||this.closed)throw Error('Poczekaj na odczyt stref i porównaj ponownie.');
      this.polling=true;
      try {
        const latest=await this.remote(this.request);if(this.closed)throw Error('Połączenie stref zmieniło się.');this.missing(latest);
        const common=Z.current(latest.data,id);
        if(!Z.equal(common,reviewed))throw Error('Druga osoba ponownie zmieniła strefę. Porównaj jej najnowszą wersję.');
        await this.change(state=>{
          const own=state.ops.filter(op=>(op.value||op.base).id===id).at(-1);
          if(!own)throw Error('Nie ma już oczekujących zmian tej strefy.');
          state.ops=state.ops.filter(op=>(op.value||op.base).id!==id);state.base=latest.data;state.seen=!latest.missing;
          if(choice==='local'){
            if(!common||common.type!=='Feature')throw Error('Usuniętej strefy nie można przywrócić dawną edycją. Wczytaj wspólną wersję.');
            const value=own.value?Z.feature({...own.value,properties:{...own.value.properties,createdAt:common.properties.createdAt,createdBy:common.properties.createdBy,updatedAt:new Date().toISOString(),updatedBy:author}}):null;
            state.ops.push(Z.operation(value?'save':'delete',common,value,author));
          }
          return state;
        });this.error=null;this.retryAt=0;this.notify();
      }finally{this.polling=false;}
      void this.flush();
    }
    close(){this.closed=true;}
  }
  root.ZoneSync=ZoneSync;root.ZoneSync.targetKey=targetKey;
})(globalThis);
