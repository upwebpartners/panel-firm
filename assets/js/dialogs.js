/* Shared, asynchronous confirmations. Untrusted names and notes stay plain text. */
(function(root){
  'use strict';
  if(typeof document==='undefined'||!document.getElementById('confirmDialog'))return;
  const $=id=>document.getElementById(id),queue=[];
  let active=null,finishing=false;
  function render(){
    if(!active)return;
    const {message,options}=active,t=root.I18n.t;
    $('confirmTitle').textContent=t(options.title||'Potwierdź działanie');
    $('confirmMessage').textContent=root.I18n.message(message);
    $('confirmAccept').textContent=t(options.accept||'Potwierdź');
    $('confirmCancel').textContent=t(options.cancel||'Anuluj');
    $('confirmClose').setAttribute('aria-label',t('Zamknij'));
    $('confirmAccept').className='button '+(options.danger?'danger':'primary');
    $('confirmDialog').classList.toggle('destructive',!!options.danger);
    $('confirmDetails').replaceChildren();
    for(const part of options.sections||[]){
      const section=document.createElement('section'),heading=document.createElement('h3'),text=document.createElement('p');
      heading.textContent=t(part.label);text.textContent=String(part.text??'');text.setAttribute('data-content','');
      section.append(heading,text);$('confirmDetails').append(section);
    }
    $('confirmDetails').hidden=!(options.sections?.length);
  }
  function next(){
    if(active||!queue.length)return;
    active=queue.shift();render();
    try{$('confirmDialog').showModal();$('confirmCancel').focus();}
    catch{finish(false);}
  }
  function finish(answer){
    if(!active||finishing)return;finishing=true;
    const current=active;active=null;
    if($('confirmDialog').open)$('confirmDialog').close();
    if(current.focus?.isConnected)current.focus.focus();
    finishing=false;current.resolve(answer===true);next();
  }
  function request(message,options={}){
    const key=options.key||JSON.stringify([message,options.title,options.accept,options.cancel,options.danger,options.sections]);
    const existing=[active,...queue].find(item=>item?.key===key);if(existing)return existing.promise;
    let resolve;const promise=new Promise(done=>{resolve=done;});
    queue.push({message:String(message),options:{...options},key,promise,resolve,focus:active?.focus||document.activeElement});next();return promise;
  }
  $('confirmAccept').addEventListener('click',()=>finish(true));
  $('confirmCancel').addEventListener('click',()=>finish(false));
  $('confirmClose').addEventListener('click',()=>finish(false));
  $('confirmDialog').addEventListener('cancel',event=>{event.preventDefault();finish(false);});
  $('confirmDialog').addEventListener('close',()=>{if(active&&!finishing&&!$('confirmDialog').open)finish(false);});
  document.addEventListener('crm:language',render);
  root.PanelDialogs={confirm:request,isOpen:()=>!!active};
})(globalThis);
