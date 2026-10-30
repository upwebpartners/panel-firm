/* Opcjonalny tytuł karty. Ustaw ENABLED = false, aby wrócić do UP — Firmy.
   Hasła zmienisz poniżej. Moduł nie jest potrzebny do działania panelu. */
(function(root){
  'use strict';
  const ENABLED = true;
  const PHRASES = {
    pl: ['Mniej wymówek. Więcej działania.', 'Nikt nie zrobi tego za Ciebie.', 'Celuj wyżej. Pracuj mocniej.', 'Nie czekaj na idealny moment.'],
    en: ['Fewer excuses. More action.', 'Nobody will do it for you.', 'Aim higher. Work harder.', 'Stop waiting for the perfect moment.'],
  };
  if(!ENABLED || typeof document==='undefined')return;
  const motion=root.matchMedia?.('(prefers-reduced-motion: reduce)');
  let timer=null,index=0,length=0,deleting=false;
  const language=()=>root.I18n?.language()==='en'?'en':'pl';
  const baseTitle=()=>PHRASES[language()][0];
  function stop(){if(timer!==null)root.clearTimeout(timer);timer=null;}
  function tick(){
    timer=null;
    if(document.hidden || motion?.matches)return;
    const phrases=PHRASES[language()],phrase=phrases[index];
    length+=deleting?-1:1;
    document.title=length?phrase.slice(0,length):'\u00a0';
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
