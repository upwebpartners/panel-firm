/* Simple zone tools on native Google shapes; fields stay mounted during polling. */
(function (root) {
  'use strict';
  if (typeof document==='undefined'||!document.getElementById('zonesPanel'))return;
  const Z=root.ZoneCore,$=id=>document.getElementById(id),t=root.I18n.t;
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const stageLabels={todo:'Do przejrzenia',doing:'W trakcie',done:'Gotowe'};
  const ask=(message,options)=>root.PanelDialogs.confirm(message,options);
  const discardOptions={title:'Niezapisana strefa',accept:'Porzuć zmiany',danger:true};
  let engine,contextKey,session,map,maps,draft=null,preview=null,outline=null,formError='',conflict=null,shapeSignature='',saving=false;
  const shapes=new Map();
  function report(error){formError=error?.message||'';renderError();}
  function renderError(){const message=formError||engine?.error?.message||'';$('zoneError').textContent=root.I18n.message(message);$('zoneError').hidden=!message;}
  async function action(fn){try{formError='';await fn();}catch(error){report(error);}renderError();}
  function profile(){const value=root.CRM.profile();if(!['T','K'].includes(value)){$('profileSelect').focus();throw Error('Wybierz T lub K w nagłówku, aby zapisać zmianę.');}return value;}
  function context(){
    const next=root.CRM.zoneContext(),key=root.ZoneSync.targetKey(next.target);
    if(engine&&contextKey===key&&session===next.session)return;
    const previous=engine;
    if(engine)engine.close();contextKey=key;session=next.session;
    engine=new root.ZoneSync({storage:root.localStorage,target:next.target,request:next.request,onChange:refresh});
    if(previous&&previous.status().pending&&previous.key!==engine.key)root.CRM.notify('Strefy czekają na zapis w poprzedniej bazie. Połącz ją ponownie, aby je wysłać.',true);
    shapeSignature='';refresh();void engine.flush();if(!$('mapPanel').hidden)void engine.poll();
  }
  function refresh(header=true){
    if(!engine)return;
    $('zoneSource').textContent=t(engine.target?'Wspólne strefy':'Strefy w tej przeglądarce');
    const rows=engine.view().sort((a,b)=>a.properties.name.localeCompare(b.properties.name,root.I18n.language()));
    const markup=rows.map(row=>{const p=row.properties,hidden=engine.state.hidden.includes(row.id);return `<div class="zone-row"><label class="zone-visibility"><input type="checkbox" data-zone-visible="${esc(row.id)}"${hidden?'':' checked'} aria-label="${esc(t('Pokaż strefę'))} ${esc(p.name)}"><span class="zone-dot" style="background:${p.color}"></span><strong data-content>${esc(p.name)}</strong></label><p class="small-copy">${esc(p.owner||t('Wspólna'))} · ${esc(t(stageLabels[p.stage]))}</p><div class="zone-row-actions"><button type="button" class="text-button" data-zone-zoom="${esc(row.id)}">${esc(t('Pokaż na mapie'))}</button><button type="button" class="text-button" data-zone-edit="${esc(row.id)}">${esc(t('Edytuj'))}</button><button type="button" class="text-button delete-company" data-zone-delete="${esc(row.id)}">${esc(t('Usuń'))}</button></div></div>`;}).join('')||'<p class="small-copy">'+esc(t('Nie ma jeszcze stref. Dodaj pierwszy obszar.'))+'</p>';
    if($('zoneList').innerHTML!==markup)$('zoneList').innerHTML=markup;
    renderError();renderConflict();drawShapes(rows);
    if(header)root.CRM.refreshConnection();
  }
  function drawShapes(rows=engine.view()){
    if(!map||!maps?.Polygon)return;
    const signature=JSON.stringify([rows,engine.state.hidden,draft?.id]);if(signature===shapeSignature)return;shapeSignature=signature;
    for(const shape of shapes.values())shape.setMap(null);shapes.clear();
    for(const row of rows){if(row.id===draft?.id||engine.state.hidden.includes(row.id))continue;
      const shape=new maps.Polygon({map,paths:row.geometry.coordinates[0].slice(0,-1).map(([lng,lat])=>({lat,lng})),strokeColor:row.properties.color,fillColor:row.properties.color,strokeWeight:2,fillOpacity:0.12,clickable:false,zIndex:1});
      shapes.set(row.id,shape);
    }
  }
  function clearPreview(){preview?.setMap(null);preview=null;outline?.setMap(null);outline=null;}
  function drawPreview(){
    clearPreview();if(!draft||!maps)return;
    const path=draft.points.map(([lng,lat])=>({lat,lng})),color=$('zoneColor').value;
    if(draft.points.length>=3){
      preview=new maps.Polygon({map,paths:path,strokeColor:color,fillColor:color,fillOpacity:0.22,strokeWeight:3,editable:!draft.drawing,clickable:!draft.drawing,zIndex:2});
      if(!draft.drawing){const points=preview.getPath();for(const name of ['insert_at','set_at','remove_at'])points.addListener(name,()=>{if(!draft)return;draft.points=points.getArray().map(point=>[point.lng(),point.lat()]);hint();});}
    }else if(path.length)preview=new maps.Polyline({map,path,strokeColor:color,strokeWeight:3,clickable:false,zIndex:2});
    hint();
  }
  function hint(){
    if(!draft)return;
    $('zoneDrawHint').textContent=t(draft.drawing?'Klikaj na mapie kolejne punkty granicy. Potrzeba co najmniej trzech.':'Przesuwaj punkty granicy. Zmiany zapiszą się dopiero po Zapisz strefę.')+' ('+draft.points.length+')';
    $('zoneUndo').hidden=!draft.drawing;$('zoneUndo').disabled=!draft.points.length;
    $('zoneCenter').hidden=!draft.drawing;$('mapPanel').classList.toggle('zone-drawing',draft.drawing);
    $('zoneFinish').hidden=!draft.drawing;$('zoneFinish').disabled=draft.points.length<3;
    $('zoneRedraw').hidden=draft.drawing;$('zoneSave').disabled=draft.drawing;
  }
  function open(){root.GoogleMapSession?.closeCard();$('zonesPanel').hidden=false;$('zonesToggle').setAttribute('aria-expanded','true');refresh();}
  function cancel(){
    draft=null;clearPreview();formError='';$('zoneForm').hidden=true;$('zoneListView').hidden=false;
    $('mapPanel').classList.remove('zone-drawing');
    map?.setOptions({clickableIcons:true,draggableCursor:null});shapeSignature='';refresh();
  }
  async function discard(){const original=draft;if(saving)return false;if(original&&!await ask('Porzucić niezapisane zmiany strefy?',discardOptions))return false;return !saving&&draft===original;}
  async function close(){if(!await discard())return false;cancel();$('zonesPanel').hidden=true;$('zonesToggle').setAttribute('aria-expanded','false');$('zonesToggle').focus();return true;}
  async function edit(row=null){
    profile();if(engine.loadError)throw engine.loadError;
    await root.GoogleMapSession.ensureMap();map=root.GoogleMapSession.map();
    if(!map)throw Error('Najpierw uruchom mapę, podając klucz Google.');
    maps=await root.google.maps.importLibrary('maps');
    if(!maps.Polygon||!maps.Polyline)throw Error('Odśwież panel, aby wczytać narzędzia stref.');
    open();
    draft={id:row?.id||root.CRMCore.uid(),base:row?Z.copy(row):null,points:row?Z.copy(row.geometry.coordinates[0].slice(0,-1)):[],drawing:!row,key:contextKey};
    $('zoneName').value=row?.properties.name||'';$('zoneColor').value=row?.properties.color||'#3478c9';$('zoneOwner').value=row?.properties.owner||'';$('zoneStage').value=row?.properties.stage||'todo';
    $('zoneListView').hidden=true;$('zoneForm').hidden=false;map.setOptions({clickableIcons:false,draggableCursor:draft.drawing?'crosshair':null});shapeSignature='';drawShapes();drawPreview();
    if(row)zoom(row);else $('zoneName').focus();
  }
  function zoom(row){
    if(!map)return;
    const points=row.geometry.coordinates[0],lngs=points.map(p=>p[0]),lats=points.map(p=>p[1]);map.fitBounds({west:Math.min(...lngs),east:Math.max(...lngs),south:Math.min(...lats),north:Math.max(...lats)},60);
  }
  function showBoundary(row){if(!row||row.type!=='Feature'||!map)return;outline?.setMap(null);outline=new maps.Polygon({map,paths:row.geometry.coordinates[0].map(([lng,lat])=>({lat,lng})),strokeColor:row.properties.color,fillColor:row.properties.color,strokeWeight:4,fillOpacity:0.3,clickable:false,zIndex:3});zoom(row);}
  function summary(row){
    if(!row||row.type!=='Feature')return '<p>'+esc(t('Strefa usunięta lub nie istnieje.'))+'</p>';
    const p=row.properties,points=row.geometry.coordinates[0].slice(0,-1);
    return `<strong data-content>${esc(p.name)}</strong><p>${esc(t('Kolor'))}: ${esc(p.color)} · ${esc(p.owner||t('Wspólna'))} · ${esc(t(stageLabels[p.stage]))}</p><details><summary>${esc(t('Punkty granicy'))}: ${points.length}</summary><p>${points.map(([lng,lat])=>esc(lat.toFixed(6)+', '+lng.toFixed(6))).join('<br>')}</p></details>`;
  }
  function renderConflict(){
    const conflicts=engine?.error?.conflicts||[];
    conflict=conflicts[0]||null;$('zoneConflict').hidden=!conflict;
    if(!conflict){if(!draft){outline?.setMap(null);outline=null;}return;}
    const own=engine.state.ops.filter(op=>(op.value||op.base).id===conflict.id).at(-1)?.value||null;
    const markup=`<h3>${esc(t('Porównaj strefy'))}</h3><p class="small-copy">${esc(t('Obie wersje są zachowane. Wybierz dane tej strefy; pozostałe strefy pozostaną bez zmian.'))}</p><div class="zone-comparison"><h4>${esc(t('Moja wersja'))}</h4>${summary(own)}${own?'<button type="button" class="text-button" data-zone-boundary="local">'+esc(t('Pokaż granicę'))+'</button>':''}<h4>${esc(t('Wspólna wersja'))}</h4>${summary(conflict.current)}${conflict.current?.type==='Feature'?'<button type="button" class="text-button" data-zone-boundary="remote">'+esc(t('Pokaż granicę'))+'</button>':''}</div><div class="zone-form-actions">${conflict.current?.type==='Feature'?'<button type="button" class="button" data-zone-choice="local">'+esc(t('Zachowaj moje dane'))+'</button>':''}<button type="button" class="button" data-zone-choice="remote">${esc(t('Wczytaj wspólną wersję'))}</button><button type="button" class="text-button" data-zone-compare>${esc(t('Porównaj ponownie'))}</button></div>`;
    if($('zoneConflict').innerHTML!==markup)$('zoneConflict').innerHTML=markup;
  }
  $('zonesToggle').onclick=()=>{$('zonesPanel').hidden?open():close();};$('zonesClose').onclick=close;
  $('zoneAdd').onclick=()=>action(()=>edit());$('zoneCancel').onclick=async()=>{if(await discard())cancel();};
  $('zoneUndo').onclick=()=>{if(draft?.drawing){draft.points.pop();drawPreview();}};
  $('zoneCenter').onclick=()=>{if(draft?.drawing)root.ZoneUI.mapClick({latLng:map.getCenter()});};
  $('zoneFinish').onclick=()=>action(async()=>{Z.ring(draft.points);draft.drawing=false;map.setOptions({draggableCursor:null});drawPreview();});
  $('zoneRedraw').onclick=async()=>{const original=draft;if(original&&await ask('Narysować granicę od nowa?',{title:'Nowa granica strefy',accept:'Narysuj od nowa',danger:true})&&draft===original&&!saving){draft.points=[];draft.drawing=true;map.setOptions({draggableCursor:'crosshair'});drawPreview();}};
  $('zoneColor').addEventListener('input',()=>{if(draft)drawPreview();});
  $('zoneForm').addEventListener('submit',event=>{event.preventDefault();void action(async()=>{
    if(!draft||draft.drawing||saving)return;if(draft.key!==contextKey)throw Error('Połączenie zmieniło się. Wróć do poprzedniej bazy lub anuluj szkic strefy.');
    const author=profile(),value=Z.create(draft.points,{name:$('zoneName').value,color:$('zoneColor').value,owner:$('zoneOwner').value,stage:$('zoneStage').value},author,draft.base,draft.id);
    saving=true;$('zoneSave').disabled=true;$('zoneCancel').disabled=true;try{await engine.apply(Z.operation('save',draft.base,value,author));cancel();}finally{saving=false;$('zoneCancel').disabled=false;if(draft)hint();}
  });});
  $('zoneList').addEventListener('change',event=>{const id=event.target.dataset?.zoneVisible;if(id)void action(()=>engine.hide(id,!event.target.checked));});
  $('zoneList').addEventListener('click',event=>{for(const [selector,kind]of[['[data-zone-zoom]','zoneZoom'],['[data-zone-edit]','zoneEdit'],['[data-zone-delete]','zoneDelete']]){
    const control=event.target.closest(selector);if(!control)continue;const row=engine.view().find(item=>item.id===control.dataset[kind]);if(!row)return;
    void action(async()=>{if(kind==='zoneZoom'){await root.GoogleMapSession.ensureMap();map=root.GoogleMapSession.map();if(map){maps=await root.google.maps.importLibrary('maps');zoom(row);}return;}
      if(kind==='zoneEdit'){await edit(row);return;}
      profile();const currentEngine=engine;
      if(await ask(row.properties.name+'\n\n'+t(currentEngine.target?'Strefa zostanie usunięta dla obu osób. Firmy pozostaną bez zmian.':'Strefa zostanie usunięta z tej przeglądarki. Firmy pozostaną bez zmian.'),{title:'Usuń strefę',accept:'Usuń strefę',danger:true,key:'delete-zone:'+contextKey+':'+row.id}))await currentEngine.apply(Z.operation('delete',row,null,profile()));
    });return;
  }});
  $('zoneConflict').addEventListener('click',event=>{
    if(event.target.closest('[data-zone-compare]')){void action(()=>engine.flush(true));return;}
    const boundary=event.target.closest('[data-zone-boundary]');if(boundary&&conflict){showBoundary(boundary.dataset.zoneBoundary==='remote'?conflict.current:engine.state.ops.filter(op=>(op.value||op.base).id===conflict.id).at(-1)?.value);return;}
    const choice=event.target.closest('[data-zone-choice]');if(choice&&conflict)void action(async()=>{await engine.resolve(conflict.id,choice.dataset.zoneChoice,Z.copy(conflict.current),profile());});
  });
  document.addEventListener('crm:connection',context);
  document.addEventListener('crm:mapready',event=>{map=event.detail.map;maps=event.detail.maps;shapeSignature='';drawShapes();});
  document.addEventListener('crm:beforetab',event=>{if(event.detail.tab!=='map'&&draft){if(saving){event.preventDefault();return;}event.detail.guard(discard);event.detail.commit(cancel);}});
  document.addEventListener('crm:tab',event=>{if(event.detail.tab==='map')void engine.poll();});
  document.addEventListener('crm:language',()=>{refresh();hint();});
  document.addEventListener('keydown',event=>{if(root.PanelDialogs.isOpen()||document.querySelector?.('dialog[open]'))return;if(event.key==='Escape'&&!$('zonesPanel').hidden){event.preventDefault();void close();}});
  root.addEventListener('beforeunload',event=>{if(draft){event.preventDefault();event.returnValue='';}});
  root.addEventListener('online',()=>{void engine.flush(true);});
  root.addEventListener('storage',event=>{if(event.key===engine?.key){if(draft){report(Error('Strefy zmieniły się w innej karcie przeglądarki. Odśwież panel przed zapisem.'));return;}session=undefined;context();}});
  setInterval(()=>{if(!document.hidden){if(engine.state.ops.length)void engine.flush();else if(!$('mapPanel').hidden)void engine.poll();}},3000);
  root.ZoneUI={status:()=>engine?.status()||{},editing:()=>!!draft,
    mapClick:event=>{if(!draft)return false;event.stop?.();if(draft.drawing&&event.latLng){if(draft.points.length>=500){report(Error('Strefa potrzebuje od 3 do 500 punktów.'));return true;}draft.points.push([event.latLng.lng(),event.latLng.lat()]);drawPreview();}return true;},
    retry:()=>{open();if(engine.error?.code!=='CONFLICT'){engine.retryAt=0;if(engine.state.ops.length)void engine.flush(true);else void engine.poll();}},
  };
  map=root.GoogleMapSession?.map();if(map)void root.google.maps.importLibrary('maps').then(value=>{maps=value;shapeSignature='';drawShapes();});context();
})(globalThis);
