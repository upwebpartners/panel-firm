/* Own map boundaries. No Google place coordinates or client CSV fields. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stages = ['todo', 'doing', 'done'];
  const fields = ['name', 'color', 'owner', 'stage'];
  const empty = () => ({ type: 'FeatureCollection', version: 1, features: [], deleted: [] });
  const fail = message => { throw new Error(message); };
  const human = value => ['T', 'K'].includes(value);
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  const date = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value));
  const cross = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const between = (a,b,p) => Math.abs(cross(a,b,p)) < 1e-12 && p[0]>=Math.min(a[0],b[0])-1e-12 && p[0]<=Math.max(a[0],b[0])+1e-12 && p[1]>=Math.min(a[1],b[1])-1e-12 && p[1]<=Math.max(a[1],b[1])+1e-12;
  function intersects(a,b,c,d) {
    return cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0 || between(a,b,c) || between(a,b,d) || between(c,d,a) || between(c,d,b);
  }
  function ring(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > 501) fail('Strefa potrzebuje od 3 do 500 punktów.');
    let result = points.map(point => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) fail('Nieprawidłowe punkty granicy strefy.');
      return [...point];
    });
    if (equal(result[0],result.at(-1))) result.pop();
    if (result.length < 3 || result.length > 500 || new Set(result.map(point=>JSON.stringify(point))).size !== result.length) fail('Granica potrzebuje co najmniej trzech różnych punktów bez powtórzeń.');
    const n = result.length;
    for (let i=0;i<n;i++) {
      const a=result[(i+n-1)%n],b=result[i],c=result[(i+1)%n];
      if (Math.abs(cross(a,b,c))<1e-12 && (b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0) fail('Granica strefy zawraca po tym samym odcinku. Popraw punkty.');
      if (Math.abs(result[i][0]-result[(i+1)%n][0])>180) fail('Strefa nie może przekraczać południka 180°.');
      for (let j=i+1;j<n;j++) {
        if (j===i+1 || i===0 && j===n-1) continue;
        if (intersects(result[i],result[(i+1)%n],result[j],result[(j+1)%n])) fail('Granica strefy przecina samą siebie. Popraw punkty.');
      }
    }
    const area = result.reduce((sum,p,i) => sum+p[0]*result[(i+1)%n][1]-result[(i+1)%n][0]*p[1],0);
    if (Math.abs(area)<1e-12) fail('Strefa musi obejmować obszar, a nie samą linię.');
    return [...result,[...result[0]]];
  }
  function geometry(value) {
    const polygons=value?.type==='Polygon'?[value.coordinates]:value?.type==='MultiPolygon'?value.coordinates:null;
    if (!Array.isArray(polygons) || !polygons.length || polygons.length>50) fail('Strefa może mieć od 1 do 50 obszarów.');
    const coordinates=polygons.map(polygon=>{
      if (!Array.isArray(polygon) || polygon.length!==1) fail('Nieprawidłowy format strefy.');
      const points=polygon[0];
      if (!Array.isArray(points) || !points.length || !equal(points[0],points.at(-1))) fail('Granica zapisanego obszaru musi być zamknięta.');
      return [ring(points)];
    });
    return value.type==='Polygon'?{type:'Polygon',coordinates:coordinates[0]}:{type:'MultiPolygon',coordinates};
  }
  const areas = row => (row.geometry.type==='Polygon'?[row.geometry.coordinates]:row.geometry.coordinates).map(polygon=>copy(polygon[0].slice(0,-1)));
  function feature(value) {
    if (value?.type!=='Feature' || !validId(value.id) || !['Polygon','MultiPolygon'].includes(value.geometry?.type)) fail('Nieprawidłowy format strefy.');
    const p=value.properties;
    if (!p || typeof p.name!=='string' || !p.name.trim() || p.name.length>100 || !/^#[a-f\d]{6}$/i.test(p.color) || !['','T','K'].includes(p.owner) || !stages.includes(p.stage) || !human(p.createdBy) || !human(p.updatedBy) || !date(p.createdAt) || !date(p.updatedAt)) fail('Nieprawidłowe dane strefy.');
    return { type:'Feature',id:value.id,geometry:geometry(value.geometry),properties:{name:p.name.trim(),color:p.color.toLowerCase(),owner:p.owner,stage:p.stage,createdBy:p.createdBy,createdAt:p.createdAt,updatedBy:p.updatedBy,updatedAt:p.updatedAt} };
  }
  function document(value) {
    if (!value || value.type!=='FeatureCollection' || value.version!==1 || !Array.isArray(value.features) || !Array.isArray(value.deleted) || value.features.length>2000 || value.deleted.length>10000) fail('Nieobsługiwany lub uszkodzony plik stref. Zachowano poprzednią kopię.');
    const data=empty(); data.features=value.features.map(feature);
    data.deleted=value.deleted.map(item => {
      if (!validId(item?.id) || !human(item.by) || !date(item.at)) fail('Nieprawidłowa historia usunięcia strefy.');
      return {id:item.id,by:item.by,at:item.at};
    });
    const ids=[...data.features,...data.deleted].map(item=>item.id);
    if (new Set(ids).size!==ids.length) fail('Powtórzony identyfikator strefy.');
    return data;
  }
  function create(points, properties, author, original=null, id=root.CRMCore.uid(), at=new Date().toISOString()) {
    return createAreas([points],properties,author,original,id,at);
  }
  function createAreas(areas, properties, author, original=null, id=root.CRMCore.uid(), at=new Date().toISOString()) {
    if (!human(author)) fail('Wybierz T lub K w nagłówku, aby zapisać zmianę.');
    if (!Array.isArray(areas) || !areas.length || areas.length>50) fail('Strefa może mieć od 1 do 50 obszarów.');
    const polygons=areas.map(points=>[ring(points)]),shape=polygons.length===1?{type:'Polygon',coordinates:polygons[0]}:{type:'MultiPolygon',coordinates:polygons};
    return feature({type:'Feature',id:original?.id||id,geometry:shape,properties:{...properties,createdAt:original?.properties.createdAt||at,createdBy:original?.properties.createdBy||author,updatedAt:at,updatedBy:author}});
  }
  function operation(kind, base, value, author, id=root.CRMCore.uid(), at=new Date().toISOString()) {
    if (!human(author) || !['save','delete'].includes(kind) || !validId(id) || !date(at)) fail('Tylko profil T lub K może zmieniać strefy.');
    if (base) base=feature(base);
    if (kind==='save') value=feature(value);
    else if (!base || value!==null) fail('Nieprawidłowe usunięcie strefy.');
    if (base && value && base.id!==value.id) fail('Nieprawidłowy identyfikator zmienianej strefy.');
    return {id,kind,base:base?copy(base):null,value:value?copy(value):null,author,at};
  }
  const current = (data,id) => data.features.find(item=>item.id===id)||data.deleted.find(item=>item.id===id)||null;
  function merge(source, operations) {
    const data=document(source), conflicts=[];
    for (const op of operations) {
      const id=(op.value||op.base).id, existing=data.features.find(item=>item.id===id), gone=data.deleted.some(item=>item.id===id);
      const conflict=field=>conflicts.push({id,opId:op.id,field,base:op.base,current:current(data,id),value:op.value});
      if (op.kind==='delete') {
        if (gone || !existing) continue;
        if (!equal(existing,op.base)) {conflict('delete');continue;}
        data.features=data.features.filter(item=>item.id!==id);data.deleted.push({id,by:op.author,at:op.at});continue;
      }
      if (gone || !existing && op.base) {conflict('deleted');continue;}
      if (!existing) {data.features.push(copy(op.value));continue;}
      if (!op.base) {if (!equal(existing,op.value)) conflict('new');continue;}
      const changes=fields.filter(field=>!equal(op.base.properties[field],op.value.properties[field]));
      if (!equal(op.base.geometry,op.value.geometry)) changes.push('geometry');
      const read=(item,field)=>field==='geometry'?item.geometry:item.properties[field];
      const blocked=changes.filter(field=>!equal(read(existing,field),read(op.base,field)) && !equal(read(existing,field),read(op.value,field)));
      if (blocked.length) {blocked.forEach(conflict);continue;}
      let changed=false;
      for (const field of changes) if (!equal(read(existing,field),read(op.value,field))) {
        if (field==='geometry') existing.geometry=copy(op.value.geometry);else existing.properties[field]=op.value.properties[field];
        changed=true;
      }
      if (changed) {existing.properties.updatedAt=op.value.properties.updatedAt;existing.properties.updatedBy=op.value.properties.updatedBy;}
    }
    return {data,conflicts};
  }
  root.ZoneCore={copy,equal,empty,ring,geometry,areas,feature,document,create,createAreas,operation,current,merge,fields,stages};
})(globalThis);
