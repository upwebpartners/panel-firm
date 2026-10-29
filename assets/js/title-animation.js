/* Opcjonalny tytuł karty. Ustaw ENABLED = false, aby wrócić do UP — Firmy.
   Hasła zmienisz poniżej. Moduł nie jest potrzebny do działania panelu. */
(function(root){
  'use strict';
  const ENABLED = true;
  const PHRASES = {
    pl: ['Działamy!', 'Każdy krok się liczy.', 'Krok po kroku do celu.'],
    en: ['Let’s get to work!', 'Every step counts.', 'One step at a time.'],
  };
  if(!ENABLED || typeof document==='undefined')return;
  const motion=root.matchMedia?.('(prefers-reduced-motion: reduce)');
  let timer=null,index=0,length=0,deleting=false;
  const language=()=>root.I18n?.language()==='en'?'en':'pl';
  const baseTitle=()=> 'UP — '+(language()==='en'?'Companies':'Firmy');
  function stop(){if(timer!==null)root.clearTimeout(timer);timer=null;}
  function tick(){
    timer=null;
    if(document.hidden || motion?.matches)return;
    const phrases=PHRASES[language()],phrase=phrases[index];
    length+=deleting?-1:1;
    document.title=length?'UP — '+phrase.slice(0,length):baseTitle();
    let delay=deleting?65:110;
    if(length===phrase.length){deleting=true;delay=2400;}
    else if(length===0){deleting=false;index=(index+1)%phrases.length;delay=900;}
    timer=root.setTimeout(tick,delay);
  }
  function restart(){
    stop();index=0;length=0;deleting=false;document.title=baseTitle();
    if(!document.hidden && !motion?.matches)timer=root.setTimeout(tick,1400);
  }
  // I18n leaves the title to this optional module while it is loaded.
  root.PanelTitle={active:true};
  document.addEventListener('crm:language',restart);
  document.addEventListener('visibilitychange',restart);
  motion?.addEventListener?.('change',restart);
  root.addEventListener('pagehide',stop);
  root.addEventListener('pageshow',restart);
  restart();
})(globalThis);
