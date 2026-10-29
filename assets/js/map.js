/* Google details are attributed separately in CSV; the API key stays in browser settings. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !document.getElementById('businessMap')) return;
  const $ = id => document.getElementById(id), C = root.CRMCore, M = root.MapCore, t = root.I18n.t;
  let map, library, Marker, key = '', loading, selected = null, cardId = null, selectionVersion = 0, pending = false, waitingPlace = null;
  const GOOGLE_KEY_STORE = 'pracownia.google.key';
  let initialization = null, forgottenKey = false, waitingRefresh = null;
  let placesInitialization = null, hydrating = false, previewFrame = null;
  const places = new Map(), details = new Set(), markers = new Map(), loadedSaved = new Set();
  const detailLoads = new Map(), contactErrors = new Map();
  const refreshingPlaces = new Set();
  const colors = { nowa: '#3478c9', przejrzana: '#c08b22', dodana: '#27804d', wykreslona: '#797979' };
  const labels = { nowa: 'Nowa', przejrzana: 'Przejrzana', dodana: 'Dodana', wykreslona: 'Wykreślona' };
  const filters = { nowa: 'showNew', przejrzana: 'showReviewed', dodana: 'showAdded', wykreslona: 'showExcluded' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  function status(message) { $('mapStatus').textContent = root.I18n.message(message); }
  function record(entity) { return M.matchRecord(entity, root.CRM.records()); }
  function savedKey() { try { return root.localStorage.getItem(GOOGLE_KEY_STORE) || ''; } catch { return ''; } }
  function rememberKey(value) {
    try { root.localStorage.setItem(GOOGLE_KEY_STORE, value); forgottenKey = false; }
    catch { throw new Error('Mapa działa, ale przeglądarka nie pozwoliła zapamiętać klucza. Sprawdź jej ustawienia.'); }
  }
  function settings() {
    $('googleError').hidden = true; $('googleKey').value = savedKey() || (forgottenKey ? '' : key);
    $('forgetGoogleKey').hidden = !savedKey(); $('googleDialog').showModal(); $('googleKey').focus();
  }
  function loadGoogle(apiKey, quiet = false) {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); delete root.__crmGoogleReady; loading = null; reject(new Error('Google Maps nie odpowiedział. Sprawdź internet i spróbuj ponownie.')); }, 20000);
      root.__crmGoogleReady = () => { clearTimeout(timer); delete root.__crmGoogleReady; resolve(); };
      root.gm_authFailure = () => {
        clearTimeout(timer); const message = 'Google odrzucił klucz. Sprawdź usługi, rozliczenia i ograniczenia domeny.';
        status(message); $('googleError').textContent = t(message); $('googleError').hidden = false;
        if (!quiet && !$('googleDialog').open) $('googleDialog').showModal(); reject(new Error(message));
      };
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(apiKey) + '&v=weekly&loading=async&language=' + encodeURIComponent(root.I18n.language()) + '&callback=__crmGoogleReady';
      script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin';
      script.onerror = () => { clearTimeout(timer); delete root.__crmGoogleReady; loading = null; script.remove(); reject(new Error('Nie udało się wczytać Google Maps. Sprawdź internet.')); };
      document.head.append(script);
    });
    return loading;
  }
  async function ensurePlaces(apiKey, quiet = false) {
    if (library) return library;
    if (!placesInitialization) placesInitialization = (async () => {
      key = apiKey;
      await loadGoogle(apiKey, quiet);
      library = await root.google.maps.importLibrary('places'); return library;
    })();
    try { return await placesInitialization; }
    catch (error) { placesInitialization = null; throw error; }
  }
  function contactsChanged() {
    if (!root.requestAnimationFrame) { document.dispatchEvent(new root.CustomEvent('crm:google-preview')); return; }
    if (previewFrame !== null) return;
    previewFrame = root.requestAnimationFrame(() => { previewFrame = null; document.dispatchEvent(new root.CustomEvent('crm:google-preview')); });
  }
  async function fetchDetails(id, { refresh = false } = {}) {
    if (details.has(id) && !refresh) return places.get(id);
    if (detailLoads.has(id)) return detailLoads.get(id);
    const task = (async () => {
      const place = new library.Place({ id, requestedLanguage: root.I18n.language() });
      const fetch = () => place.fetchFields({ fields: ['id','displayName','location','nationalPhoneNumber','websiteURI','formattedAddress'] });
      if (root.Network) await root.Network.withTimeout(fetch); else await fetch();
      const entity = M.fromGoogle(place);
      places.set(id, entity); details.add(id); contactErrors.delete(id);
      await root.CRM.savePlaceDetails?.(entity, { refresh }); return entity;
    })();
    detailLoads.set(id, task);
    try { return await task; }
    catch (error) { contactErrors.set(id, { retryAt: Date.now() + 60000, message: error.message }); throw error; }
    finally { detailLoads.delete(id); contactsChanged(); }
  }
  async function refreshPlace(id) {
    if (refreshingPlaces.has(id)) return;
    const apiKey = savedKey() || (forgottenKey ? '' : key);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) { waitingRefresh = id; settings(); return; }
    refreshingPlaces.add(id); contactErrors.delete(id); contactsChanged();
    try {
      await ensurePlaces(apiKey);
      await fetchDetails(id, { refresh: true });
      draw(); return true;
    } finally { refreshingPlaces.delete(id); contactsChanged(); }
  }
  function visibleContacts() {
    return (root.CRM.visibleRecords?.() || []).filter(row => row.Google_place_id && !M.storedDetails(row) &&
      (!row.Telefon || !C.safeURL(row.Strona) || !row.Firma || row.Firma === 'Do weryfikacji — ' + row.Google_place_id));
  }
  async function loadVisibleContacts() {
    if (hydrating || document.hidden || !visibleContacts().some(row => !details.has(row.Google_place_id))) return;
    const apiKey = savedKey() || (forgottenKey ? '' : key);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(apiKey)) return;
    const eligible = () => visibleContacts().find(row => !details.has(row.Google_place_id) && !detailLoads.has(row.Google_place_id) && !(contactErrors.get(row.Google_place_id)?.retryAt > Date.now()));
    if (!eligible()) return;
    hydrating = true; contactsChanged();
    try {
      await ensurePlaces(apiKey, true);
      const worker = async () => {
        while (!document.hidden) {
          const row = eligible(); if (!row) break;
          const operation = fetchDetails(row.Google_place_id); contactsChanged();
          try { await operation; } catch { /* Each failed row retains a retry button; other contacts continue. */ }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      draw();
    } catch (error) {
      for (const row of visibleContacts()) if (!details.has(row.Google_place_id)) contactErrors.set(row.Google_place_id, { retryAt: Date.now() + 60000, message: error.message });
      contactsChanged();
    } finally { hydrating = false; contactsChanged(); }
  }
  async function initialize(apiKey) {
    if (map) return;
    if (!initialization) initialization = (async () => {
      await ensurePlaces(apiKey);
      const maps = await root.google.maps.importLibrary('maps');
      Marker = (await root.google.maps.importLibrary('marker')).Marker;
      map = new maps.Map($('businessMap'), { center: { lat: 54.2622, lng: 18.6362 }, zoom: 15,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: true });
      map.addListener('click', event => { if (root.ZoneUI?.mapClick(event)) return; if (event.placeId) { event.stop(); selectPlace(event.placeId); } });
      document.dispatchEvent(new root.CustomEvent('crm:mapready', { detail: { map, maps } }));
      status('Kliknij firmę Google lub wyszukaj firmy w widocznym obszarze.');
      draw();
      if (waitingPlace) { const id = waitingPlace; waitingPlace = null; await selectPlace(id); }
    })();
    try { await initialization; } catch (error) { initialization = null; throw error; }
  }
  async function ensureMap() {
    if (map) { root.google.maps.event.trigger(map, 'resize'); return; }
    const remembered = savedKey();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(remembered)) { settings(); return; }
    try { key = remembered; await initialize(key); }
    catch (error) { settings(); $('googleError').textContent = root.I18n.message(error.message); $('googleError').hidden = false; }
  }
  function draw() {
    if (!map) return;
    for (const marker of markers.values()) marker.setMap(null);
    markers.clear();
    const filtering = Object.values(filters).some(id => !$(id).checked);
    // Google cannot hide individual native POIs. In filtered mode use only loaded overlays.
    map.setOptions({ styles: filtering ? [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }] : null });
    for (const entity of places.values()) {
      const current = record(entity), state = M.state(current);
      if (!$(filters[state]).checked) continue;
      const declined = state !== 'wykreslona' && current?.Etap === 'Odrzucony';
      const marker = new Marker({ map, position: { lat: entity.lat, lng: entity.lon },
        title: (entity.name || (current ? C.companyName(current) : t('Firma z mapy'))) + ' · ' + t(declined ? 'Odrzucony — odmowa klienta' : labels[state]),
        icon: { path: root.google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: declined ? '#b02b36' : colors[state], fillOpacity: 1, strokeWeight: 2, strokeColor: '#ffffff' },
        label: { text: declined ? 'O' : ({ nowa:'N', przejrzana:'P', dodana:'+', wykreslona:'×' })[state], color:'#ffffff', fontSize:'10px' } });
      marker.addListener('click', () => { if (!root.ZoneUI?.editing()) selectPlace(entity.id); }); markers.set(entity.id, marker);
    }
    if (selected && details.has(selected)) showCard(places.get(selected));
  }
  function showCard(entity) {
    const current = record(entity), state = M.state(current);
    const oldFields = $('mapExcludeFields'), oldReason = $('mapExcludeReason');
    const draft = cardId === entity.id && oldFields && oldReason ? { visible: !oldFields.hidden, value: oldReason.value } : null;
    cardId = entity.id;
    $('mapPlace').hidden = false;
    const stateLabel = state === 'przejrzana' && !current?.Mapa_potwierdzono ? 'Starsze oznaczenie — niepotwierdzone' : labels[state];
    $('mapPlace').innerHTML = `<div class="map-place-heading"><div><h2>${esc(entity.name || (current ? C.companyName(current) : t('Firma z mapy')))}</h2><span style="color:${colors[state]}">${esc(t(stateLabel))}</span>${state === 'przejrzana' && current?.Mapa_potwierdzono ? '<p class="small-copy">' + esc(t('Potwierdził')) + ': ' + esc(current.Mapa_edytowal) + ' · ' + esc(new Date(current.Mapa_potwierdzono).toLocaleString(root.I18n.locale())) + '</p>' : ''}</div><button type="button" class="icon-button" data-map-close aria-label="${esc(t('Zamknij'))}">×</button></div>
      <p data-content>${esc(entity.address || '')}</p>
      ${entity.phone ? `<p><a href="tel:${esc(entity.phone.replace(/[^+\d]/g,''))}">${esc(entity.phone)}</a></p>` : `<p class="muted">${esc(t('Brak numeru telefonu'))}</p>`}
      ${entity.website ? `<p><a href="${esc(entity.website)}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz stronę'))} ↗</a></p>` : ''}
      <p><a href="${esc(M.placeURL(entity.id))}" target="_blank" rel="noopener noreferrer">Google Maps ↗</a></p>
      <p class="small-copy">${esc(t('Dane z Google Maps — niepotwierdzone w innym źródle'))}</p>
      ${state !== 'wykreslona' && current?.Etap === 'Odrzucony' ? `<p class="map-declined">${esc(t('Odrzucony — odmowa klienta'))}</p>` : ''}
      <div class="map-place-actions">
        ${state === 'nowa' || state === 'przejrzana' && !current?.Mapa_potwierdzono ? `<button class="button" data-map-reviewed>${esc(t(state === 'nowa' ? 'Oznacz jako przejrzaną' : 'Potwierdź przejrzenie'))}</button>` : ''}
        ${state === 'dodana' ? `<button class="button primary" data-map-open>${esc(t('Otwórz firmę'))}</button>` : `<button class="button primary" data-map-add>${esc(t(state === 'wykreslona' ? 'Przywróć w Firmach' : 'Dodaj do firm'))}</button>`}
        ${state !== 'wykreslona' ? `<button class="button" data-map-exclude>${esc(t('Wykreśl'))}</button>` : ''}
        ${state === 'wykreslona' && !C.isMapDecisionOnly(current) ? `<button class="button delete-company" data-map-delete>${esc(t('Usuń dane firmy'))}</button>` : ''}
      </div>
      ${state === 'wykreslona' ? `<p data-content>${esc(current?.Powod_wykreslenia || '')}</p>` : ''}
      <div id="mapExcludeFields" hidden><label for="mapExcludeReason">${esc(t('Powód (opcjonalnie)'))}</label><textarea id="mapExcludeReason" rows="2"></textarea><button class="button" data-map-confirm>${esc(t('Potwierdź wykreślenie'))}</button><button class="button" data-map-cancel>${esc(t('Anuluj'))}</button></div>`;
    $('mapPlace').querySelectorAll('button').forEach(button => { button.disabled = pending; });
    if (draft) { $('mapExcludeFields').hidden = !draft.visible; $('mapExcludeReason').value = draft.value; }
    root.I18n.bindUI($('mapPlace'));
  }
  async function selectPlace(id) {
    const version = ++selectionVersion; selected = id; $('mapPlace').hidden = true;
    try {
      if (!details.has(id)) {
        status('Pobieranie danych firmy z Google…');
        await fetchDetails(id);
        if (version !== selectionVersion) return;
      }
      if (version !== selectionVersion) return;
      const entity = places.get(id); showCard(entity);
      status('Dane Google — sprawdź aktualność przed zapisaniem własnych danych firmy.');
    } catch (error) { status(error.message); }
  }
  async function search(text = '') {
    if (!map) { await ensureMap(); if (!map) return; }
    if (pending) return;
    pending = true; $('mapSearchArea').disabled = true; $('mapSearchText').disabled = true;
    try {
      status('Szukanie firm…');
      const fields = ['id','displayName','location','formattedAddress','types'];
      let result;
      if (text.trim()) result = await library.Place.searchByText({ textQuery: text.trim(), language: root.I18n.language(), fields, maxResultCount: 20, locationBias: map.getBounds() });
      else {
        const center = map.getCenter(), edge = map.getBounds().getNorthEast();
        const distance = Math.max(Math.abs(center.lat() - edge.lat()) * 111000, Math.abs(center.lng() - edge.lng()) * 111000 * Math.cos(center.lat() * Math.PI / 180));
        if (distance > 5000) throw new Error('Przybliż mapę, aby przeszukać mniejszy obszar.');
        result = await library.Place.searchNearby({ fields, language: root.I18n.language(), maxResultCount: 20, locationRestriction: { center, radius: Math.max(100, Math.min(50000, distance * 1.42)) }, rankPreference: library.SearchNearbyRankPreference.DISTANCE });
      }
      for (const place of result.places || []) { const entity = M.fromGoogle(place); if (!details.has(entity.id)) places.set(entity.id, entity); }
      document.dispatchEvent(new root.CustomEvent('crm:google-preview'));
      draw();
      if (text.trim() && result.places?.length) map.panTo(result.places[0].location);
      status('Wyniki Google: ' + (result.places?.length || 0) + '/20. To nie jest pełna lista firm w okolicy.');
    } catch (error) { status(error.message); }
    finally { pending = false; $('mapSearchArea').disabled = false; $('mapSearchText').disabled = false; if (selected && details.has(selected)) showCard(places.get(selected)); }
  }
  async function loadSaved() {
    if (!map) { await ensureMap(); if (!map) return; }
    if (pending) return;
    pending = true; $('mapKnown').disabled = true;
    const candidates = root.CRM.records().filter(r => r.Google_place_id && !loadedSaved.has(r.Google_place_id));
    let loaded = 0;
    try {
      for (const row of candidates.slice(0, 50)) {
        if (!details.has(row.Google_place_id)) {
          await fetchDetails(row.Google_place_id);
        }
        loadedSaved.add(row.Google_place_id); loaded++;
      }
      document.dispatchEvent(new root.CustomEvent('crm:google-preview'));
      status('Wczytano oznaczenia: ' + loaded + '. Pozostało: ' + Math.max(0, candidates.length - loaded) + '.');
    } catch (error) { status(error.message); }
    finally { pending = false; $('mapKnown').disabled = false; draw(); }
  }
  $('googleForm').addEventListener('submit', async event => {
    event.preventDefault(); const candidate = $('googleKey').value.trim();
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(candidate)) { $('googleError').textContent = t('Wpisz poprawny klucz API Google.'); $('googleError').hidden = false; return; }
    $('connectGoogle').disabled = true;
    try {
      if (key && key !== candidate && loading) {
        rememberKey(candidate); $('googleKey').value = ''; $('googleDialog').close(); root.location.reload(); return;
      }
      key = candidate; await ensurePlaces(key); rememberKey(key);
      contactErrors.clear(); $('googleKey').value = ''; $('googleDialog').close();
      if (waitingRefresh) { const id = waitingRefresh; waitingRefresh = null; await refreshPlace(id); }
      else if (!$('mapPanel').hidden || waitingPlace) await initialize(key);
      else void loadVisibleContacts();
    }
    catch (error) { if (!$('googleDialog').open) settings(); $('googleError').textContent = root.I18n.message(error.message); $('googleError').hidden = false; }
    finally { $('connectGoogle').disabled = false; }
  });
  $('closeGoogle').onclick = () => $('googleDialog').close();
  $('forgetGoogleKey').onclick = () => {
    try {
      root.localStorage.removeItem(GOOGLE_KEY_STORE); forgottenKey = true;
      $('googleKey').value = ''; $('forgetGoogleKey').hidden = true;
      status('Zapisany klucz usunięty. Bieżąca mapa działa do zamknięcia strony.'); $('googleDialog').close();
    } catch { $('googleError').textContent = t('Nie udało się usunąć zapisanego klucza. Sprawdź ustawienia przeglądarki.'); $('googleError').hidden = false; }
  };
  $('mapSettings').onclick = settings;
  $('mapSearchArea').onclick = () => search();
  $('mapSearchText').onclick = () => search($('mapQuery').value);
  $('mapQuery').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search($('mapQuery').value); } });
  $('mapKnown').onclick = loadSaved;
  Object.values(filters).forEach(id => $(id).addEventListener('change', () => { draw(); status('Filtry obejmują wczytane znaczniki. Przy filtrowaniu bazowe wizytówki Google są ukryte.'); }));
  $('mapPlace').addEventListener('click', async event => {
    if (event.target.closest('[data-map-close]')) { selected = null; selectionVersion++; $('mapPlace').hidden = true; return; }
    if (!selected || pending) return;
    const entity = places.get(selected); if (!entity) return;
    if (event.target.closest('[data-map-open]')) { const row = record(entity); if (row) root.CRM.open(row.Id); return; }
    if (event.target.closest('[data-map-delete]')) { const row = record(entity); if (row) await root.CRM.remove(row.Id); draw(); return; }
    if (event.target.closest('[data-map-exclude]')) { $('mapExcludeFields').hidden = false; $('mapExcludeReason').focus(); return; }
    if (event.target.closest('[data-map-cancel]')) { $('mapExcludeFields').hidden = true; return; }
    const add = event.target.closest('[data-map-add]'), exclude = event.target.closest('[data-map-confirm]'), reviewed = event.target.closest('[data-map-reviewed]');
    if (!add && !exclude && !reviewed) return;
    pending = true; $('mapPlace').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const row = await root.CRM.decidePlace(entity, add ? 'dodana' : reviewed ? 'przejrzana' : 'wykreslona', exclude ? $('mapExcludeReason').value.trim() : '');
      if (add) root.CRM.open(row.Id);
      draw();
    } catch (error) { status(error.message); }
    finally { pending = false; if (selected && details.has(selected)) showCard(places.get(selected)); }
  });
  root.GoogleMapSession = {
    ensureMap,
    map: () => map,
    closeCard: () => { selected = null; selectionVersion++; $('mapPlace').hidden = true; },
    refresh: refreshPlace,
    isRefreshing: id => refreshingPlaces.has(id),
    get: id => places.has(id) ? { ...places.get(id) } : M.storedDetails(root.CRM.records().find(row => row.Google_place_id === id)),
    contactState: id => details.has(id) || M.storedDetails(root.CRM.records().find(row => row.Google_place_id === id)) ? 'ready' : detailLoads.has(id) ? 'loading' : contactErrors.has(id) ? 'failed' : !savedKey() && (!key || forgottenKey) ? 'key' : hydrating ? 'loading' : 'pending',
    loadContact: id => {
      if (!savedKey() && (!key || forgottenKey)) { settings(); return; }
      contactErrors.delete(id); void loadVisibleContacts();
    },
    open: id => {
      if (!root.PanelUI.showTab('map')) return;
      if (!map) { waitingPlace = id; ensureMap(); }
      else selectPlace(id);
    },
  };
  document.addEventListener('crm:tab', event => {
    if (event.detail.tab !== 'map') { void loadVisibleContacts(); return; }
    ensureMap();
  });
  document.addEventListener('crm:data', () => { draw(); void loadVisibleContacts(); });
  document.addEventListener('crm:view', () => { void loadVisibleContacts(); });
  document.addEventListener('crm:profile', () => {
    for (const row of root.CRM.visibleRecords?.() || []) if (!M.storedDetails(row) && details.has(row.Google_place_id)) void root.CRM.savePlaceDetails?.(places.get(row.Google_place_id));
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void loadVisibleContacts(); });
  document.addEventListener('crm:language', () => { if (selected && details.has(selected)) showCard(places.get(selected)); });
  if (!$('mapPanel').hidden) ensureMap();
  else void loadVisibleContacts();
  contactsChanged();
})(globalThis);
