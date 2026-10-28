/* Panel klientów. CSV jest wspólnym źródłem danych po połączeniu. */
(function () {
  'use strict';
  const M = MapCore;
  const C = CRMCore, F = C.fields, $ = id => document.getElementById(id);
  const t = I18n.t, ask = value => confirm(I18n.message(value));
  const seed = JSON.parse($('initial-data').textContent);
  seed.records = seed.records.map(r => ({ ...C.cleanRecord(r), Id: r.Id || C.stableId(r), Etap: r.Etap || 'Nowy' }));
  seed.headers = C.cleanHeaders(seed.headers);
  // Existing storage keys also contain user notes and must remain stable.
  const STORE = 'pracownia.crm.v1';
  const SORT_STORE = 'pracownia.sort';
  let sorting = { field: 'priority', direction: 'asc' };
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORE) || 'null');
    if (saved && Object.hasOwn(C.sortFields, saved.field) && ['asc', 'desc'].includes(saved.direction)) sorting = { field: saved.field, direction: saved.direction };
  } catch { /* Invalid preferences never block access to company data. */ }
  let local = { patches: {}, added: [], imported: null, meta: null, info: null };
  let storageOK = true, storageError = '', browserStore;
  try { browserStore = new BrowserStore(localStorage, STORE); const stored = browserStore.load(); if (stored) local = stored; }
  catch (error) { storageOK = false; storageError = error.message; }
  local = { ...local, patches: Object.fromEntries(Object.entries(local.patches).map(([id, patch]) => [id, C.cleanRecord(patch)])), added: local.added.map(C.cleanRecord), imported: local.imported?.map(C.cleanRecord) || null, ...(local.headers ? { headers: C.cleanHeaders(local.headers) } : {}) };
  let base = local.imported || seed.records;
  let headers = local.headers || [...new Set([...seed.headers, ...base.flatMap(Object.keys), ...local.added.flatMap(Object.keys)])];
  let records = C.overlay(base, local.patches, local.added);
  let fileHandle = null, connected = false, busy = false, fileText = null, connectionError = '';
  let selected = null, editOriginal = null, actionOriginal = null, returnFocus = null;
  let browseIds = [], statusOriginal = null, statusSaving = false, excludeOriginal = null;
  let priorityOriginal = null, prioritySaving = false;
  let toastTimer = null;
  let github = null, githubBusy = false, fileBusy = false, lastGitHubPoll = 0;
  let authorName = '';
  try { const saved = localStorage.getItem('pracownia.author'); if (['T', 'K'].includes(saved)) authorName = saved; } catch {}
  let draftId = null;
  const pendingCalls = new Map();
  const callsInProgress = new Set();
  const priorityInProgress = new Set();
  let callOriginal = null, callSaving = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const val = (record, name) => record[F[name]] || '';
  const today = () => { const date = new Date(); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); };
  const prettyDate = value => { if (!value) return ''; const date = new Date(value + 'T12:00:00'); return Number.isNaN(+date) ? value : date.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short', year: 'numeric' }); };
  const stageSlug = value => C.norm(value).replace(/\s+/g, '-');
  const stagePill = record => '<span class="stage-pill ' + esc(stageSlug(record.Etap)) + '">' + esc(t(record.Etap || 'Nowy')) + '</span>';
  const byId = id => records.find(r => r.Id === id);
  const hasPending = () => Object.keys(local.patches).length > 0 || local.added.length > 0;

  function dateTime(value) { const date = new Date(value); return value && Number.isFinite(+date) ? date.toLocaleString(I18n.locale(), { dateStyle: 'short', timeStyle: 'short' }) : t('brak informacji'); }
  function displayCallHistory(record) { try { return C.callHistory(record); } catch { return []; } }
  function requireProfile() {
    if (['T', 'K'].includes(authorName)) return true;
    $('profileSelect').focus();
    toast('Wybierz T lub K w nagłówku, aby zapisać zmianę.', true);
    return false;
  }
  async function ensureAuthor() {
    if (!requireProfile()) throw new Error('Wybierz T lub K w nagłówku, aby zapisać zmianę.');
    return authorName;
  }
  function updateFileInfo() {
    const meta = hasPending() && local.meta ? local.meta : C.fileMeta(records);
    const at = connected && local.info?.modifiedAt ? local.info.modifiedAt : meta.at || local.info?.modifiedAt;
    const by = meta.by || local.info?.by || '';
    const fileName = github ? github.config.path : local.info?.name || 'klienci.csv';
    const source = github && connected ? 'Wspólna baza GitHub' : connected ? 'Połączony plik CSV' : 'Kopia w tej przeglądarce';
    $('fileInfo').innerHTML = '<div>' + icon('note') + '<strong>' + esc(fileName) + '</strong><span>' + esc(t(source)) + '</span></div><div><span>' + esc(t('Ostatnia edycja pliku:')) + '</span><strong>' + esc(dateTime(at)) + '</strong>' + (by ? '<span>· ' + esc(by) + '</span>' : '') + '</div>' + (local.info?.uploadedFileModifiedAt ? '<span>' + esc(t('Wczytany CSV zmieniono:')) + ' ' + esc(dateTime(local.info.uploadedFileModifiedAt)) + '</span>' : '') + (hasPending() ? '<span class="unsaved-file">' + esc(t('Zmiany lokalne — zapisz lub eksportuj CSV')) + '</span>' : '');
  }
  async function adoptShared(result, info = {}) {
    base = result.records.map(r => ({ ...r })); records = [...base]; headers = result.headers;
    local = { patches: {}, added: [], imported: base, meta: C.fileMeta(base), info: { name: github ? github.config.path : 'klienci.csv', modifiedAt: result.at || '', by: result.by || '', sha: result.sha || null, ...info } }; await persist();
  }
  function switchConnectionMode(kind) {
    const gh = kind === 'github'; $('githubConnectFields').hidden = !gh; $('localConnectFields').hidden = gh;
    $('connectGitHub').hidden = !gh; $('chooseCSV').hidden = gh;
    $('githubMode').classList.toggle('selected', gh); $('fileMode').classList.toggle('selected', !gh);
  }
  async function connectGitHub() {
    if (busy || githubBusy) return;
    $('connectGitHub').disabled = true; $('connectError').hidden = true; githubBusy = true;
    let candidate;
    try {
      if (connected || fileHandle || github) throw new Error('Najpierw rozłącz obecne źródło, aby przełączyć repozytorium.');
      const raw = $('ghRepo').value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
      const pieces = raw.split('/'); if (pieces.length !== 2) throw new Error('Podaj repozytorium jako właściciel/nazwa.');
      const config = { owner: pieces[0], repo: pieces[1], branch: $('ghBranch').value.trim(), path: $('ghPath').value.trim() };
      candidate = new GitHubCSV(config, $('ghToken').value); let result = await candidate.connect();
      if (result.missing && records.length) {
        if (!ask('W repozytorium nie ma jeszcze tego CSV. Zapisać w nim obecną listę ' + records.length + ' firm?')) { candidate.close(); return; }
        result = await candidate.save([], {}, records, await ensureAuthor());
      } else if (hasPending()) {
        if (!ask('Przenieść lokalne zmiany do wspólnego CSV? Jeśli zmieniono te same pola, zapis zostanie wstrzymany.')) { candidate.close(); return; }
        result = await candidate.save(base, local.patches, local.added, await ensureAuthor());
      }
      github = candidate; connected = true; fileHandle = null; connectionError = ''; lastGitHubPoll = Date.now();
      try { localStorage.setItem('pracownia.github.config', JSON.stringify(config)); } catch {}
      $('ghToken').value = ''; await adoptShared(result); render(); $('connectDialog').close();
      toast('Połączono wspólną bazę. Druga osoba używa tego samego repozytorium.');
    } catch (error) { candidate?.close(); $('ghToken').value = ''; $('connectError').textContent = I18n.message(error.message); $('connectError').hidden = false; }
    finally { githubBusy = false; $('connectGitHub').disabled = false; }
  }
  async function commitBatch(originals, patches, added, author, at) {
    if (busy) throw new Error('Poczekaj na zakończenie poprzedniego zapisu.');
    if (githubBusy) throw new Error('Trwa odświeżanie wspólnej bazy. Spróbuj zapisać ponownie za chwilę.');
    if (fileBusy) throw new Error('Trwa odświeżanie pliku. Spróbuj zapisać ponownie za chwilę.');
    if (github) {
      if (!connected) throw new Error('Wspólna baza jest rozłączona. Połącz GitHub ponownie przed zapisem.');
      busy = true; connectionUI();
      try { const result = await github.save(originals, patches, added, author); await adoptShared(result); connectionError = ''; lastGitHubPoll = Date.now(); }
      catch (error) { connectionError = 'Zapis do GitHuba nie powiódł się. Zmiana nie jest oznaczona jako zapisana.'; throw error; }
      finally { busy = false; connectionUI(); }
    } else if (connected && fileHandle) {
      busy = true; connectionUI();
      try {
        const text = await (await fileHandle.getFile()).text(), latest = C.parseCSV(text);
        const outcome = C.merge(originals, latest.records, patches, added);
        if (outcome.conflicts.length) throw new Error('Te same pola zmieniła druga osoba: ' + outcome.conflicts.map(x => x.field).join(', ') + '. Odśwież kartę klienta.');
        await writeRecords(C.stampFile(outcome.records, at, author), latest.headers, text); connectionError = '';
      } catch (error) { connectionError = 'Nie zapisano zmian do pliku. Sprawdź połączenie i spróbuj ponownie.'; throw error; }
      finally { busy = false; connectionUI(); }
    } else {
      busy = true;
      try {
        const next = { ...local, patches: { ...local.patches }, added: [...local.added, ...added], meta: { at, by: author } };
        for (const [id, patch] of Object.entries(patches)) {
          if (!byId(id)) throw new Error('Tej firmy nie ma już w bazie. Odśwież listę.');
          const previous = Object.hasOwn(next.patches, id) ? next.patches[id] : {};
          next.patches = { ...next.patches, [id]: { ...previous, ...patch } };
        }
        await persist(next, true); local = next;
        records = C.stampFile(C.overlay(base, local.patches, local.added), at, author);
      } finally { busy = false; connectionUI(); }
    }
    render();
  }
  // Keep saved outcome values unchanged; use simpler labels in the interface.
  const callOutcomeLabel = outcome => ({ 'Brak odpowiedzi': 'Nie odebrał', 'Brak zainteresowania': 'Nie zainteresowany' })[outcome] || outcome;
  function callOutcomeHTML(event) {
    if (!event?.outcome) return '';
    const tone = ['positive', 'followup', 'positive', 'neutral', 'negative', 'neutral'][C.callOutcomes.indexOf(event.outcome)] || 'neutral';
    return `<span class="call-outcome ${tone}">${esc(t(callOutcomeLabel(event.outcome)))}</span>`;
  }
  function renderCallOptions(value = '') {
    $('callOutcome').innerHTML = '<option value="">' + esc(t('Wybierz wynik')) + '</option>' + C.callOutcomes.map(outcome => `<option value="${esc(outcome)}">${esc(t(callOutcomeLabel(outcome)))}</option>`).join('');
    $('callOutcome').value = value;
  }
  function callControls() {
    const pending = callOriginal && pendingCalls.has(callOriginal.Id);
    $('callOutcome').disabled = callSaving || !!pending;
    $('callNotes').readOnly = callSaving || !!pending;
    for (const id of ['saveCall', 'closeCall', 'cancelCall']) $(id).disabled = callSaving;
  }
  function registerPhone(id) {
    const record = byId(id); if (!record || busy || callSaving || !requireProfile()) return;
    const history = displayCallHistory(record);
    const pending = pendingCalls.get(id);
    if (pending && history.some(e => e.id === pending.eventId)) { pendingCalls.delete(id); toast('Ten telefon jest już zapisany we wspólnej bazie.'); return; }
    callOriginal = pending?.original || { ...record };
    $('callCompanyName').textContent = record.Firma;
    renderCallOptions(pending?.details.outcome || '');
    $('callNotes').value = pending?.details.notes || '';
    $('callError').hidden = !pending;
    $('callError').textContent = pending ? t('Dane rozmowy zachowano. Ponów zapis, aby uniknąć zdublowania telefonu.') : '';
    $('callSaveHint').textContent = t(connected ? (github ? 'Zmiany zapiszą się we wspólnym CSV na GitHubie.' : 'Zmiany zapiszą się w klienci.csv.') : 'Zmiany zapiszą się w tej przeglądarce.');
    callControls(); $('callDialog').showModal();
    $(pending ? 'saveCall' : 'callOutcome').focus();
  }
  function closeCall() {
    if (callSaving) return;
    if (($('callOutcome').value || $('callNotes').value.trim()) && !ask('Zamknąć okno bez zapisywania rozmowy?')) return;
    $('callDialog').close();
  }
  async function submitCall(event) {
    event.preventDefault();
    if (!callOriginal || callSaving || busy) return;
    const id = callOriginal.Id, pending = pendingCalls.get(id);
    const details = pending?.details || { outcome: $('callOutcome').value, notes: $('callNotes').value.trim() };
    if (!C.callOutcomes.includes(details.outcome)) {
      $('callError').textContent = t('Wybierz wynik rozmowy przed zapisem.'); $('callError').hidden = false; $('callOutcome').focus(); return;
    }
    callSaving = true;
    callsInProgress.add(id);
    callControls(); $('callError').hidden = true;
    try {
      const author = await ensureAuthor();
      const operation = pending || { original: callOriginal, eventId: C.uid(), details };
      if (!pending) operation.patch = C.callPatch(callOriginal, author, new Date().toISOString(), operation.eventId, details);
      pendingCalls.set(id, operation);
      await saveChange(id, operation.patch, operation.original); pendingCalls.delete(id);
      $('callDialog').close();
      if (selected === id) openClient(id, true);
      toast('Zapisano rozmowę z wynikiem i opisem.');
    } catch (error) {
      // Local-only failures cannot have written remotely; allow correcting the draft.
      if (!github && !connected) pendingCalls.delete(id);
      $('callError').textContent = I18n.message(error.message) + (pendingCalls.has(id) ? ' ' + t('Dane rozmowy zachowano. Ponów zapis, aby uniknąć zdublowania telefonu.') : '');
      $('callError').hidden = false;
    } finally { callSaving = false; callsInProgress.delete(id); callControls(); }
  }
  async function importCSV(file) {
    if (!file) return;
    try {
      if (busy || githubBusy || fileBusy) throw new Error('Poczekaj na zakończenie zapisu.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Limit importu wynosi 10 MB.');
      const parsed = C.parseCSV(await file.text()); parsed.records.forEach(C.callHistory);
      if (busy || githubBusy || fileBusy) throw new Error('Poczekaj na zakończenie zapisu.');
      const plan = C.importPlan(records, parsed.records);
      if (!connected) {
        busy = true;
        try {
          const patches = Object.assign(Object.create(null), local.patches);
          for (const [id, patch] of Object.entries(plan.patches)) patches[id] = { ...(patches[id] || {}), ...patch };
          const nextRecords = C.overlay(base, patches, [...local.added, ...plan.added]);
          const fileAt = file.lastModified ? new Date(file.lastModified).toISOString() : '';
          const meta = C.fileMeta(nextRecords), nextHeaders = [...new Set([...headers, ...parsed.headers])];
          const next = { ...local, patches, added: [...local.added, ...plan.added], meta, headers: nextHeaders, info: { name: file.name || 'klienci.csv', modifiedAt: meta.at || fileAt, uploadedFileModifiedAt: fileAt } };
          await persist(next, true); local = next; headers = nextHeaders; records = nextRecords;
        } finally { busy = false; connectionUI(); }
        render(); return;
      }
      if (!plan.added.length && !Object.keys(plan.patches).length) return;
      const author = await ensureAuthor(), at = new Date().toISOString();
      for (const patch of Object.values(plan.patches)) { patch.Modyfikacja = at; patch.Edytowal = author; }
      await commitBatch(records.map(r => ({ ...r })), plan.patches, plan.added.map(r => ({ ...r, Modyfikacja: r.Modyfikacja || at, Edytowal: r.Edytowal || author })), author, at);
    } catch (error) { toast(error.message, true); }
  }
  async function autoLoadCSV() {
    if (!storageOK || (records.length && local.info?.kind !== 'public-csv') || connected || hasPending() || !/^https?:$/.test(window.location?.protocol || '')) return;
    const previous = records;
    try {
      const response = await fetch(new URL(document.body.dataset.csvUrl || 'klienci.csv', window.location.href), { cache: 'no-store', credentials: 'omit' });
      if (!response.ok || Number(response.headers.get('Content-Length') || 0) > 10 * 1024 * 1024) return;
      const text = await response.text(); if (text.length > 10 * 1024 * 1024 || records !== previous || connected || busy || githubBusy || fileBusy || hasPending()) return;
      const parsed = C.parseCSV(text); parsed.records.forEach(C.callHistory);
      base = parsed.records; records = [...base]; headers = parsed.headers;
      local = { patches: {}, added: [], imported: base, meta: C.fileMeta(base), info: { name: 'klienci.csv', kind: 'public-csv', modifiedAt: response.headers.get('Last-Modified') || C.fileMeta(base).at } };
      await persist(); render();
    } catch { /* No public CSV is required. The direct file picker stays available. */ }
  }

  function toast(text, error = false) {
    $('toast').textContent = I18n.message(text); $('toast').classList.toggle('error', error); $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8500 : 4000);
  }
  async function persist(next = local, required = false) {
    try {
      if (!browserStore) throw new Error('Zapis lokalny niedostępny');
      await browserStore.save({ ...next, headers: next.headers || headers }); storageOK = true; storageError = '';
    } catch (error) {
      storageOK = false; storageError = error.message;
      if (required) throw error;
    } finally { connectionUI(); }
  }
  function download(name, text, type = 'text/csv;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function connectionUI() {
    const el = $('saveState');
    el.className = 'save-state' + (connected ? ' connected' : connectionError || !storageOK ? ' error' : '');
    let label = connected ? (github ? 'GitHub · wspólna baza' : 'Połączono z CSV · na żywo') : fileHandle ? 'Plik czeka na połączenie' : storageOK ? 'Zapis w przeglądarce' : 'Zapis lokalny niedostępny';
    if (busy) label = github ? 'Zapisywanie do GitHuba…' : connected && fileHandle ? 'Zapisywanie do CSV…' : 'Zapisywanie w przeglądarce…';
    if (connectionError) label = 'Sprawdź połączenie z CSV';
    el.innerHTML = '<span class="status-dot"></span>' + esc(t(label));
    el.title = I18n.message(connected ? (github ? 'Wspólna baza odświeża się co 15 sekund.' : 'Zmiany pliku sprawdzane co 3 sekundy.') : 'Połącz CSV, żeby panel i asystent pracowali na tej samej liście.');
    $('connectButton').innerHTML = icon('link') + esc(t(connected ? 'Połączono' : 'Wspólna baza GitHub'));
    $('disconnectButton').hidden = !fileHandle && !github;
    $('connectionNotice').hidden = !connectionError && storageOK;
    $('connectionNotice').textContent = I18n.message(connectionError || storageError || 'Zapis w przeglądarce jest niedostępny. Połącz CSV lub eksportuj zmiany przed zamknięciem.');
    $('formSaveHint').textContent = I18n.message(connected ? (github ? 'Zmiany zapiszą się we wspólnym CSV na GitHubie.' : 'Zmiany zapiszą się w klienci.csv.') : 'Zmiany zapiszą się w tej przeglądarce.');
    updateFileInfo(); I18n.bindUI(document);
  }

  function refreshIndustries() {
    const control = $('industryFilter'), previous = control.value;
    const groups = [...new Set(records.map(C.industry))].sort((a, b) => a.localeCompare(b, I18n.language()));
    control.innerHTML = '<option value="">' + esc(t('Wszystkie branże')) + '</option>' + groups.map(v => '<option value="' + esc(v) + '">' + esc(t(v)) + '</option>').join('');
    if (groups.includes(previous)) control.value = previous;
  }
  function filteredRecords() {
    const query = C.norm($('search').value.trim()), stage = $('stageFilter').value;
    const visible = records.filter(r => {
      if (!stage && (M.state(r) === 'wykreslona' || r.Mapa_status === 'przejrzana')) return false;
      if (stage === '__reviewed' && r.Mapa_status !== 'przejrzana') return false;
      if (stage === 'Odrzucony' && M.state(r) !== 'wykreslona') return false;
      if (stage && !['__reviewed', 'Odrzucony'].includes(stage) && r.Etap !== stage) return false;
      if ($('industryFilter').value && C.industry(r) !== $('industryFilter').value) return false;
      if ($('callFilter').value === 'yes' && !r.Dzwoniono || $('callFilter').value === 'no' && r.Dzwoniono) return false;
      if ($('priorityFilter').value && C.priorityValue(r) !== ($('priorityFilter').value === 'none' ? '' : $('priorityFilter').value)) return false;
      if ($('pinFilter').value === 'pinned' && !C.isPinned(r) || $('pinFilter').value === 'unpinned' && C.isPinned(r)) return false;
      return !query || C.norm([r.Firma, r.Branza, r.Miejscowosc, r.Telefon, r.Email, r.Strona, r.Notatki, r['Sprawdzony problem'], r['Nastepny krok'], t(C.industry(r))].join(' ')).includes(query);
    });
    return C.sortRecords(visible, { ...sorting, locale: I18n.language() });
  }
  function renderSorting() {
    const labels = ['updated', 'added', 'called'].includes(sorting.field) ? ['Od najstarszych', 'Od najnowszych'] :
      sorting.field === 'due' ? ['Od najbliższego terminu', 'Od najdalszego terminu'] :
      sorting.field === 'status' ? ['Od pierwszego etapu', 'Od ostatniego etapu'] :
      sorting.field === 'priority' ? ['Od najwyższego priorytetu', 'Od najniższego priorytetu'] : ['A → Z', 'Z → A'];
    $('sortField').value = sorting.field;
    $('sortDirection').innerHTML = labels.map((label, index) => '<option value="' + (index ? 'desc' : 'asc') + '">' + esc(t(label)) + '</option>').join('');
    $('sortDirection').value = sorting.direction;
  }
  function render() {
    refreshIndustries(); renderSorting(); connectionUI();
    const visible = filteredRecords();
    $('resultsLabel').textContent = I18n.message('Wyświetlono ' + visible.length + ' z ' + records.length + ' firm');
    if (!visible.length) {
      $('clientsContent').innerHTML = '<div class="empty-state"><p>' + esc(t(records.length ? 'Brak firm dla tych filtrów.' : 'Wczytaj CSV, aby wyświetlić firmy.')) + '</p><button class="button primary" data-import-csv>' + esc(t('Wczytaj CSV')) + '</button>' + (records.length ? '<button class="button" data-clear-filters>' + esc(t('Wyczyść filtry')) + '</button>' : '') + '</div>';
    } else renderTable(visible);
    I18n.bindUI(document);
    document.dispatchEvent(new CustomEvent('crm:data'));
  }
  function phoneHTML(record, prominent = false) {
    const phone = record.Telefon || '';
    if (!phone) return `<span class="muted">${esc(t('Brak numeru telefonu'))}</span>`;
    const digitCount = phone.replace(/\D/g, '').length;
    const simple = /^\+?[\d\s()-]{7,25}$/.test(phone) && digitCount >= 7 && digitCount <= 15;
    const numbers = simple ? [phone] : [...phone.matchAll(/(?<![\d+])\+?\d[\d\s().-]*\d(?!\d)/g)].map(match => match[0]).filter(number => {
      const count = number.replace(/\D/g, '').length;
      return count === 9 || (number.startsWith('+') && count >= 7 && count <= 15) || (count === 11 && number.startsWith('48'));
    });
    const unique = [...new Set(numbers)];
    return `<div class="phone-contact${prominent ? ' prominent' : ''}">
      <div class="phone-numbers">${unique.map(number => {
        const dial = number.replace(/[^+\d]/g, '');
        return `<span class="phone-number"><a class="phone-link" href="tel:${esc(dial)}">${esc(number)}</a>${prominent ? `<button type="button" class="button copy-phone" data-copy-phone="${esc(dial)}">${esc(t('Kopiuj'))}</button>` : ''}</span>`;
      }).join('')}</div>
      ${!simple ? `<span class="phone-context">${esc(phone)}</span>` : ''}
    </div>`;
  }

  function contactHTML(record) {
    const phone = record.Telefon || '';
    const email = record.Email || '';
    const url = C.safeURL(record.Strona);
    const emailLink = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
      : esc(email);
    const parts = [
      phone ? phoneHTML(record) : '',
      email ? `<span>${emailLink}</span>` : '',
      url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.split('/')[2])} ↗</a>` : '',
      !phone && !email && !url ? '—' : '',
    ];
    return `<div class="contact-lines">${parts.join('')}</div>`;
  }

  function statusButton(record) {
    return `<button type="button" class="status-trigger" data-status="${esc(record.Id)}" aria-label="${esc(t('Zmień status'))}">
      ${stagePill(record)}<span aria-hidden="true">▾</span>
    </button>`;
  }

  function priorityOptions(value) {
    return [{ value: '', label: 'Nie ustawiono' }, ...C.priorities].map(item => `<option value="${esc(item.value)}"${item.value === value ? ' selected' : ''}>${esc(t(item.label) + (item.description ? ' — ' + t(item.description) : ''))}</option>`).join('');
  }
  function pinButton(record) {
    const pinned = C.isPinned(record), label = t(pinned ? 'Odepnij' : 'Przypnij');
    return `<button type="button" class="button pin-button${pinned ? ' pinned' : ''}" data-pin="${esc(record.Id)}" aria-pressed="${pinned}" aria-label="${esc(label)}" title="${esc(label)}">${icon('pin')}</button>`;
  }
  function priorityControl(record) {
    const value = C.priorityValue(record), level = C.priorities.find(item => item.value === value);
    const hint = t('Priorytet') + ': ' + (level ? level.label + ' — ' + t(level.description) : t('Nie ustawiono'));
    return `<button type="button" class="priority-trigger ${esc(value || 'none')}" data-priority="${esc(record.Id)}" aria-label="${esc(t('Zmień priorytet'))}" title="${esc(hint)}"><span>${esc(level?.label || 'LVL —')}</span><span aria-hidden="true">▾</span></button>`;
  }
  function statusControls(record) {
    return `<div class="status-line">${statusButton(record)}${pinButton(record)}</div>`;
  }
  async function updatePriority(id, patch, control) {
    const record = byId(id);
    if (!record || busy || priorityInProgress.has(id) || !requireProfile()) return;
    if (Object.entries(patch).every(([key, value]) => String(record[key] || '') === value)) return;
    const focused = document.activeElement === control;
    priorityInProgress.add(id); if (control) control.disabled = true;
    try {
      await saveChange(id, patch, { ...record });
      if (selected === id) openClient(id, true);
      if (focused) {
        const key = control.dataset.pin ? 'pin' : 'priority', container = selected === id ? $('drawer') : $('clientsContent');
        const replacement = [...container.querySelectorAll('[data-' + key + ']')].find(element => element.dataset[key] === id);
        (replacement || $('search')).focus();
      }
      toast('Zapisano priorytet i przypięcie.');
    } catch (error) { toast(error.message, true); }
    finally { priorityInProgress.delete(id); if (control) control.disabled = false; }
  }
  function renderPriorityOptions(record) {
    const options = [...C.priorities, { value: '', label: 'Nie ustawiono', description: 'Bez priorytetu' }];
    $('priorityOptions').innerHTML = options.map(item => `<label class="status-option"><input type="radio" name="priority" value="${esc(item.value)}"${C.priorityValue(record) === item.value ? ' checked' : ''}><span><strong>${esc(t(item.label))}</strong><small>${esc(t(item.description))}</small></span></label>`).join('');
    I18n.bindUI($('priorityDialog'));
  }
  function openPriority(id) {
    const record = byId(id); if (!record || busy || prioritySaving || priorityInProgress.has(id) || !requireProfile()) return;
    priorityOriginal = { ...record };
    $('priorityCompanyName').textContent = record.Firma; $('priorityError').hidden = true;
    renderPriorityOptions(record); $('priorityDialog').showModal();
  }
  async function changePriority(event) {
    if (event.target.name !== 'priority' || !priorityOriginal || busy || prioritySaving) return;
    const value = event.target.value;
    if (!['', ...C.priorities.map(item => item.value)].includes(value) || value === C.priorityValue(priorityOriginal)) return;
    const original = priorityOriginal; prioritySaving = true; priorityInProgress.add(original.Id);
    $('priorityOptions').disabled = true; $('closePriority').disabled = true; $('priorityError').hidden = true;
    try {
      await saveChange(original.Id, { [F.priority]: value }, original);
      $('priorityDialog').close(); if (selected === original.Id) openClient(original.Id, true);
      toast('Zapisano priorytet.');
    } catch (error) {
      renderPriorityOptions(original); $('priorityError').textContent = I18n.message(error.message); $('priorityError').hidden = false;
    } finally { prioritySaving = false; priorityInProgress.delete(original.Id); $('priorityOptions').disabled = false; $('closePriority').disabled = false; }
  }
  function togglePin(control) {
    const record = byId(control.dataset.pin); if (!record) return;
    return updatePriority(record.Id, { Przypieta: C.isPinned(record) ? '' : 'tak' }, control);
  }

  function renderTable(items) {
    const rows = items.map(record => `
      <tr class="client-row${C.isPinned(record) ? ' pinned-row' : ''}" tabindex="0" data-client="${esc(record.Id)}" aria-label="${esc(t('Otwórz'))} ${esc(record.Firma)}">
        <td>
          <strong class="firm-name">${esc(record.Firma)}</strong>
          <span class="firm-meta">${esc(t(C.industry(record)))} · ${esc(record.Miejscowosc || '')}</span>
          <span class="firm-meta">${esc(t('Dodał'))}: ${esc(record.Dodal || t('Nie zapisano'))}</span>
          <span class="firm-meta">${esc(t('Aktualizacja'))}: ${esc(dateTime(record.Modyfikacja) || '—')}</span>
        </td>
        <td class="status-cell">${statusControls(record)}</td>
        <td class="priority-cell">${priorityControl(record)}</td>
        <td>${contactHTML(record)}</td>
        <td><span class="cell-text company-notes" data-content title="${esc(record.Notatki || '')}">${esc(record.Notatki || '—')}</span></td>
        <td>
          <span class="cell-text">${esc(record['Nastepny krok'] || '—')}</span>
          ${record.Termin ? `<span class="due${record.Termin < today() ? ' overdue' : ''}">${esc(prettyDate(record.Termin))}</span>` : ''}
        </td>
        <td>
          <button class="button call-button" type="button" data-call="${esc(record.Id)}">${esc(t('Dzwoniliśmy'))}</button>
          ${record.Dzwoniono
            ? `<small class="called-label">${esc(dateTime(record.Dzwoniono))}<br>${esc(record.Dzwonil || '')}</small>`
            : `<small class="muted">${esc(t('Jeszcze nie dzwoniono'))}</small>`}
          ${callOutcomeHTML(displayCallHistory(record).at(-1))}
        </td>
      </tr>
    `).join('');
    $('clientsContent').innerHTML = `
      <table class="client-table">
        <thead><tr>
          <th>${esc(t('Firma'))}</th>
          <th>${esc(t('Status'))}</th>
          <th>${esc(t('Priorytet'))}</th>
          <th>${esc(t('Kontakt'))}</th>
          <th>${esc(t('Notatki'))}</th>
          <th>${esc(t('Następny krok'))}</th>
          <th>${esc(t('Wykonany telefon'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function detailBlock(label, value, extra = '') {
    return `<section class="detail-block ${extra}">
      <h3>${esc(t(label))}</h3>
      <p data-content>${esc(value || '—')}</p>
    </section>`;
  }

  function openClient(id, preserve = false, resetDraft = false) {
    const record = byId(id); if (!record) return;
    const preview = record.Google_place_id ? window.GoogleMapSession?.get(record.Google_place_id) : null;
    const pendingName = record.Google_place_id && record.Firma === 'Do weryfikacji — ' + record.Google_place_id;
    const heading = pendingName ? preview?.name || t('Do weryfikacji') : record.Firma;
    const googleAttribution = '<span class="gmp-attribution" translate="no">Google Maps</span>';

    const scroll = selected === id && preserve ? ['.company-grid', '.company-analysis', '.company-actions'].map(selector => [selector, $('drawer').querySelector(selector)?.scrollTop || 0]) : [];
    const same = selected === id, draft = same && preserve && !resetDraft && actionDirty() ? { next: $('actionNext').value, due: $('actionDue').value, notes: $('actionNotes').value, consent: $('actionConsent').value, original: actionOriginal } : null;
    if (!selected || !preserve) { browseIds = filteredRecords().map(r => r.Id); returnFocus = document.activeElement; }
    if (!browseIds.includes(id)) browseIds.push(id);
    selected = id; actionOriginal = { ...record };
    const index = browseIds.indexOf(id), sources = (record.Zrodla || record.Strona || '').split(/\s*\|\s*|\n/).map(C.safeURL).filter(Boolean);
    const history = displayCallHistory(record).slice().reverse();
    $('drawer').innerHTML = `
      <div class="company-toolbar${C.isPinned(record) ? ' pinned-toolbar' : ''}">
        <button class="button" data-close-drawer>← ${esc(t('Firmy'))}</button>
        <div class="company-heading">
          <h2 id="drawerTitle" data-content>${esc(heading)}</h2>
          ${pendingName && preview?.name ? googleAttribution : ''}
          <span class="muted">${esc(record.Miejscowosc || '')} · ${esc(record.Branza || '')}</span>
        </div>
        <div class="company-pagination">
          <button class="button" data-navigate="-1" ${index <= 0 ? 'disabled' : ''} aria-label="${esc(t('Poprzednia firma'))}">←</button>
          <span>${index + 1} / ${browseIds.length}</span>
          <button class="button" data-navigate="1" ${index >= browseIds.length - 1 ? 'disabled' : ''} aria-label="${esc(t('Następna firma'))}">→</button>
          <button class="button" data-edit-client>${esc(t('Edytuj firmę'))}</button>
        </div>
      </div>
      <div class="call-bar">
        <div>${phoneHTML({ Telefon: record.Telefon || preview?.phone || '' }, true)}${!record.Telefon && preview?.phone ? googleAttribution + '<small class="muted"> · ' + esc(t('Podgląd — numer nie jest zapisany w CSV')) + '</small>' : ''}</div>
        <div class="call-actions">${record.Google_place_id ? `<button class="button" type="button" data-google-preview="${esc(record.Google_place_id)}">${esc(t('Dane Google'))}</button>` : ''}<button class="button" type="button" data-exclude="${esc(id)}">${esc(t(M.state(record) === 'wykreslona' ? 'Przywróć' : 'Wykreśl'))}</button>${statusControls(record)}${priorityControl(record)}<button type="button" class="button primary" data-call="${esc(id)}">${esc(t('Dzwoniliśmy'))}</button></div>
      </div>
      <div class="company-grid">
        <div class="company-analysis">
          ${preview ? `<section class="google-preview">${googleAttribution}<p data-content>${esc(preview.address)}</p>${preview.website ? `<a href="${esc(preview.website)}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz stronę'))} ↗</a>` : ''}<p class="muted">${esc(t('Podgląd Google. Własne dane uzupełnij z niezależnego źródła.'))}</p></section>` : ''}
          <div class="company-contact">
            ${record.Strona && C.safeURL(record.Strona) ? `<a href="${esc(C.safeURL(record.Strona))}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz stronę'))} ↗</a>` : ''}
            ${record.Email ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.Email) ? `<a href="mailto:${esc(record.Email)}">${esc(record.Email)}</a>` : `<span>${esc(record.Email)}</span>`) : ''}
            <span class="muted">${esc(t('Dodał'))}: ${esc(record.Dodal || t('Nie zapisano'))}${record.Dodano ? ' · ' + esc(dateTime(record.Dodano)) : ''}</span>
            <span class="muted">${esc(t('Ostatnia edycja firmy'))}: ${esc(record.Modyfikacja ? dateTime(record.Modyfikacja) : '—')}${record.Edytowal ? ' · ' + esc(record.Edytowal) : ''}</span>
          </div>
          <div class="analysis-grid">
            ${detailBlock('Co zauważyliśmy', record['Sprawdzony problem'])}
            ${detailBlock('Argument do rozmowy', record['Argument do rozmowy'])}
            <details class="analysis-details"><summary>${esc(t('Źródła i pozostałe dane'))}</summary><div class="analysis-grid">
            <section class="detail-block wide">
              <h3>${esc(t('Źródła'))}${record['Data sprawdzenia zrodel'] ? ' · ' + esc(prettyDate(record['Data sprawdzenia zrodel'])) : ''}</h3>
              ${sources.map(url => `<a class="source-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)} ↗</a>`).join('')}
            </section>
            ${detailBlock('Co faktycznie sprawdzono', record['Zakres weryfikacji'], 'wide')}
            ${record['Zrodlo kontaktu'] ? detailBlock('Źródło kontaktu', record['Zrodlo kontaktu']) : ''}
            ${record.Status ? detailBlock('Stan weryfikacji / kontaktu', record.Status) : ''}
            ${record.Google_place_id ? `<a class="source-link" href="${esc(M.placeURL(record.Google_place_id))}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz w Google Maps'))} ↗</a>` : ''}
            ${record.Powod_wykreslenia ? detailBlock('Powód wykreślenia', record.Powod_wykreslenia) : ''}
            ${record.Wycena ? detailBlock('Wycena', record.Wycena) : ''}
            </div></details>
          </div>
        </div>
        <div class="company-actions">
          <section class="next-step-fields">
            <div class="drawer-field">
              <label for="actionNext">${esc(t('Następny krok'))}</label>
              <textarea id="actionNext" rows="3" placeholder="${esc(t('Co trzeba zrobić dalej?'))}">${esc(record['Nastepny krok'])}</textarea>
            </div>
            <div class="drawer-field">
              <label for="actionDue">${esc(t('Termin działania'))}</label>
              <input id="actionDue" type="date" value="${esc(record.Termin)}">
            </div>
          </section>
          <div class="last-call">
            <strong>${esc(t('Ostatni zapisany telefon'))}:</strong>
            ${esc(record.Dzwoniono ? dateTime(record.Dzwoniono) + ' · ' + (record.Dzwonil || '') : t('Jeszcze nie dzwoniono'))}
          </div>
          <div class="drawer-field">
            <label for="actionNotes">${esc(t('Notatki'))}</label>
            <textarea id="actionNotes" rows="8">${esc(record.Notatki)}</textarea>
          </div>
          <button type="button" class="button primary save-actions" id="saveActions">${esc(t('Zapisz'))}</button>
          <section class="call-history" aria-labelledby="callHistoryTitle">
            <div class="call-history-heading"><h3 id="callHistoryTitle">${esc(t('Historia rozmów'))}</h3><span class="muted">${esc(record.Liczba_polaczen || history.length)}</span></div>
            ${history.map((event, index) => `<details class="call-entry"${index === 0 ? ' open' : ''}>
              <summary><span class="call-entry-meta"><time datetime="${esc(event.at)}">${esc(dateTime(event.at))}</time><span>${esc(event.by)}</span></span>${callOutcomeHTML(event) || `<span class="muted">${esc(t('Nie zapisano wyniku'))}</span>`}</summary>
              ${event.notes?.trim() || event.count > 1 ? `<div class="call-entry-body">${event.notes?.trim() ? `<p data-content>${esc(event.notes)}</p>` : ''}${event.count > 1 ? `<small class="muted">${esc(t('Liczba telefonów w starszym wpisie'))}: ${event.count}</small>` : ''}</div>` : ''}
            </details>`).join('') || `<p class="call-history-empty">${esc(t('Tutaj pojawią się wyniki i ustalenia zapisanych rozmów.'))}</p>`}
          </section>
          <details class="secondary-fields">
            <summary>${esc(t('Historia i uzgodnienia'))}</summary>
            <div class="drawer-field">
              <label for="actionConsent">${esc(t('Uzgodniony kontakt — data i zakres'))}</label>
              <textarea id="actionConsent" rows="3">${esc(record['Zgoda data i zakres'])}</textarea>
            </div>
          </details>
        </div>
      </div>
    `;
    $('drawer').hidden = false; $('companiesPanel').inert = true; $('companiesPanel').setAttribute('aria-hidden', 'true');
    if (draft) { $('actionNext').value = draft.next; $('actionDue').value = draft.due; $('actionNotes').value = draft.notes; $('actionConsent').value = draft.consent; actionOriginal = draft.original; }
    for (const [selector, position] of scroll) { const element = $('drawer').querySelector(selector); if (element) element.scrollTop = position; }
    I18n.bindUI($('drawer'));
    if (!preserve) $('drawer').querySelector('[data-close-drawer]').focus();
  }
  function actionDirty() {
    return selected && !$('drawer').hidden && actionOriginal && $('actionNext') && ['actionNext', 'actionDue', 'actionNotes', 'actionConsent'].some((id, index) => $(id).value !== (actionOriginal[['Nastepny krok', 'Termin', 'Notatki', 'Zgoda data i zakres'][index]] || ''));
  }
  function confirmLeavingActions() { return !actionDirty() || ask('Masz niezapisane działania lub notatki. Opuścić je bez zapisywania?'); }
  function closeDrawer(force = false) {
    if (!force && !confirmLeavingActions()) return false;
    $('drawer').hidden = true; $('companiesPanel').inert = false; $('companiesPanel').removeAttribute('aria-hidden'); selected = null; browseIds = [];
    if (returnFocus?.isConnected) returnFocus.focus(); return true;
  }
  function navigateCompany(direction) {
    if (busy || !confirmLeavingActions()) return;
    const index = browseIds.indexOf(selected), id = browseIds[index + direction]; if (id && byId(id)) openClient(id, true);
  }
  const stageDescriptions = { Nowy: 'Nowa firma w bazie', 'Do sprawdzenia': 'Dane wymagają sprawdzenia', Rozmowa: 'Kontakt z firmą w toku', Oferta: 'Firma na etapie oferty', 'W realizacji': 'Trwa realizacja', Pozyskany: 'Potwierdzona współpraca', Odrzucony: 'Nie kontynuujemy kontaktu', Archiwum: 'Ukryj z głównej listy' };
  function renderStatusOptions(record) {
    $('statusOptions').innerHTML = C.stages.map(stage => '<label class="status-option"><input type="radio" name="stage" value="' + esc(stage) + '"' + (stage === record.Etap ? ' checked' : '') + '><span><strong>' + esc(t(stage)) + '</strong><small>' + esc(t(stageDescriptions[stage])) + '</small></span></label>').join('');
    I18n.bindUI($('statusDialog'));
  }
  function openStatus(id) {
    const record = byId(id); if (!record || busy || statusSaving || !requireProfile()) return; statusOriginal = { ...record };
    $('statusCompanyName').textContent = record.Firma; $('statusError').hidden = true;
    renderStatusOptions(record); $('statusDialog').showModal();
  }
  async function changeStatus(event) {
    if (event.target.name !== 'stage' || !statusOriginal || busy || statusSaving) return;
    const stage = event.target.value;
    if (!C.stages.includes(stage)) return;
    if (stage === statusOriginal.Etap) return;
    const original = statusOriginal; statusSaving = true;
    $('statusOptions').disabled = true; $('closeStatus').disabled = true; $('statusError').hidden = true;
    try { await saveChange(original.Id, { Etap: stage }, original); $('statusDialog').close(); if (selected === original.Id) openClient(original.Id, true); toast('Zmieniono etap współpracy.'); }
    catch (error) { renderStatusOptions(original); $('statusError').textContent = I18n.message(error.message); $('statusError').hidden = false; }
    finally { statusSaving = false; $('statusOptions').disabled = false; $('closeStatus').disabled = false; }
  }

  const formSchema = [
    ['name', 'Nazwa firmy *', 'text', 'Pełna nazwa firmy', true], ['url', 'Strona internetowa', 'url', 'https://…', true],
    ['industry', 'Branża', 'text', 'np. Detailing'], ['city', 'Miejscowość', 'text', 'np. Pruszcz Gdański'],
    ['phone', 'Telefon', 'text', 'Publiczny numer firmy'], ['email', 'E-mail', 'text', 'Adres kontaktowy'],
    ['stage', 'Etap współpracy', 'stage'], ['priority', 'Priorytet', 'priority'],
    ['next', 'Następny krok', 'textarea', 'Co konkretnie warto zrobić?', true], ['due', 'Termin działania', 'date'], ['price', 'Ustalona wycena', 'text', 'Uzupełnij po przygotowaniu oferty'],
    ['issue', 'Zaobserwowany problem', 'textarea', 'Tylko sprawdzone obserwacje; zaznacz niepewność.', true],
    ['argument', 'Argument do rozmowy', 'textarea', 'Dlaczego ta zmiana może pomóc firmie?', true],
    ['sources', 'Źródła', 'textarea', 'Adresy stron oddziel pionową kreską | lub nową linią.', true],
    ['checked', 'Data sprawdzenia źródeł', 'date'], ['scope', 'Zakres weryfikacji', 'textarea', 'Co sprawdzono, a co wymaga potwierdzenia?', true],
    ['notes', 'Twoje notatki', 'textarea', 'Dodatkowe informacje i ustalenia', true]
  ];
  function openForm(record = null) {
    if (!requireProfile() || (selected && !confirmLeavingActions())) return;
    editOriginal = record ? { ...record } : null; draftId = record?.Id || C.uid();
    $('formTitle').textContent = I18n.message(record ? 'Edytuj dane firmy' : 'Dodaj nową firmę');
    $('submitForm').innerHTML = record ? 'Zapisz zmiany' + icon('check') : 'Dodaj klienta' + icon('plus');
    $('formError').hidden = true;
    const basic = ['name', 'url', 'city', 'phone', 'email', 'notes'];
    const ordered = [...formSchema.filter(row => basic.includes(row[0])), ...formSchema.filter(row => !basic.includes(row[0]))];
    $('formFields').innerHTML = '<div class="form-grid">' + ordered.map(([key, label, type, placeholder, full]) => {
      const value = record ? val(record, key) : key === 'stage' ? 'Nowy' : '';
      let input;
      if (type === 'textarea') input = '<textarea name="' + key + '" id="f-' + key + '" placeholder="' + esc(t(placeholder)) + '" maxlength="30000">' + esc(value) + '</textarea>';
      else if (type === 'stage') input = '<select id="f-stage" name="stage">' + C.stages.map(s => '<option value="' + esc(s) + '"' + (s === value ? ' selected' : '') + '>' + esc(t(s)) + '</option>').join('') + '</select>';
      else if (type === 'priority') input = '<select id="f-priority" name="priority">' + priorityOptions(record ? C.priorityValue(record) : '') + '</select>';
      else input = '<input id="f-' + key + '" name="' + key + '" type="' + type + '" value="' + esc(value) + '" placeholder="' + esc(t(placeholder || '')) + '"' + (key === 'name' ? ' required maxlength="250"' : ' maxlength="5000"') + '>';
      return (key === 'industry' ? '</div><details class="advanced-fields"><summary>' + esc(t('Więcej informacji (opcjonalnie)')) + '</summary><div class="form-grid">' : '') + '<div class="form-field' + (full ? ' full' : '') + '"><label for="f-' + key + '">' + esc(t(label)) + '</label>' + input + '</div>';
    }).join('') + '</div></details>';
    I18n.bindUI($('editDialog')); $('editDialog').showModal(); $('f-name').focus();
  }
  function changedFields(record, form) {
    const patch = {};
    for (const [name] of formSchema) {
      const value = String(form.get(name) || '').trim(); const key = F[name];
      if (name === 'priority') {
        if (!['', ...C.priorities.map(item => item.value)].includes(value)) throw new Error('Wybierz poprawny priorytet.');
        if (record && C.priorityValue(record) === value) continue;
      }
      if (!record || String(record[key] || '') !== value) patch[key] = value;
    }
    return patch;
  }

  async function writeRecords(newRecords, currentHeaders, expectedText) {
    const nextText = C.csvText(newRecords, currentHeaders);
    const writer = await fileHandle.createWritable({ mode: 'exclusive' });
    try {
      const latestText = await (await fileHandle.getFile()).text();
      if (latestText !== expectedText) throw new Error('Plik właśnie się zmienił. Spróbuj zapisać ponownie; niczego nie nadpisano.');
      await writer.write(nextText); await writer.close();
    }
    catch (error) { try { await writer.abort(); } catch {} throw error; }
    fileText = nextText; const file = await fileHandle.getFile();
    await adoptShared({ records: newRecords, headers: C.parseCSV(nextText).headers }, { name: file.name || 'klienci.csv', modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : C.fileMeta(newRecords).at });
  }
  async function saveChange(id, patch, original, newRecord = null) {
    if (busy) throw new Error('Poczekaj na zakończenie poprzedniego zapisu.');
    if (!newRecord && !Object.keys(patch).length) return;
    const author = await ensureAuthor(), at = new Date().toISOString();
    const selection = patch.Etap && ['Odrzucony', 'Archiwum'].includes(patch.Etap) ? M.decision(original, 'wykreslona', author, patch.Powod_wykreslenia ?? original?.Powod_wykreslenia ?? '', at) : patch.Etap && original && M.state(original) === 'wykreslona' ? M.decision(original, 'dodana', author, '', at) : {};
    const update = { ...selection, ...patch, Modyfikacja: at, Edytowal: author };
    if (update.Etap) update.Status = 'Etap: ' + update.Etap + ' — ustawiono przez ' + author;
    const added = newRecord ? [{ ...newRecord, Dodal: author, Dodano: at, Modyfikacja: at, Edytowal: author }] : [];
    await commitBatch(original ? [{ ...original }] : [], newRecord ? {} : { [id]: update }, added, author, at);
  }
  async function submitForm(event) {
    event.preventDefault();
    const form = new FormData($('clientForm')); const patch = changedFields(editOriginal, form);
    if (!String(form.get('name') || '').trim()) { $('formError').textContent = I18n.message('Podaj nazwę firmy.'); $('formError').hidden = false; return; }
    if (form.get('url') && !C.safeURL(form.get('url'))) { $('formError').textContent = I18n.message('Podaj pełny adres strony zaczynający się od https:// lub http://.'); $('formError').hidden = false; return; }
    $('submitForm').disabled = true;
    try {
      let id = editOriginal?.Id || draftId;
      if (!editOriginal) {
        const duplicate = records.find(r => C.norm(r.Firma.trim()) === C.norm(String(form.get('name')).trim()) && r.Etap !== 'Archiwum');
        if (duplicate) throw new Error('Taka firma jest już w bazie. Otwórz jej kartę, żeby uzupełnić informacje.');
        const record = Object.fromEntries(headers.map(k => [k, '']));
        Object.assign(record, patch, { Id: id, Status: 'Potencjalny klient — zainteresowanie niepotwierdzone' });
        await saveChange(id, {}, null, record);
      } else await saveChange(id, patch, editOriginal);
      $('editDialog').close(); toast(editOriginal ? 'Zapisano zmiany w danych firmy.' : 'Nowy klient jest już na liście.');
      openClient(id, true, true);
    } catch (error) { $('formError').textContent = I18n.message(error.message); $('formError').hidden = false; }
    finally { $('submitForm').disabled = false; }
  }

  function fileDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('pracownia-file-handles', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function rememberHandle(handle) {
    try {
      const db = await fileDB();
      await new Promise((resolve, reject) => { const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').put(handle, 'csv'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    } catch { /* Połączenie działa także bez trwałego uchwytu. */ }
  }
  async function restoreHandle() {
    try {
      const db = await fileDB(); const handle = await new Promise((resolve, reject) => { const request = db.transaction('handles').objectStore('handles').get('csv'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close();
      if (!handle || github) return;
      fileHandle = handle;
      if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted' && !hasPending()) await establishConnection(handle);
      else connectionUI();
    } catch { /* Przeglądarka może wymagać ponownego wybrania pliku. */ }
  }
  async function establishConnection(handle) {
    if (busy || githubBusy || fileBusy) throw new Error('Trwa poprzedni zapis. Spróbuj ponownie za chwilę.');
    if (github) throw new Error('Najpierw rozłącz GitHub, żeby wybrać plik na komputerze.');
    const previous = records;
    const file = await handle.getFile(), text = await file.text(), parsed = C.parseCSV(text);
    parsed.records.forEach(C.callHistory);
    if (records !== previous || busy || githubBusy || fileBusy || github) throw new Error('Dane zmieniły się podczas łączenia. Spróbuj ponownie.');
    if (hasPending()) {
      const outcome = C.merge(base, parsed.records, local.patches, local.added);
      if (outcome.conflicts.length) {
        throw new Error('Plik i panel mają różne zmiany tych samych danych: ' + outcome.conflicts.slice(0, 4).map(c => c.name + ' / ' + c.field).join('; ') + '. Najpierw wyeksportuj wersję z panelu. Nie zmieniono pliku.');
      }
      const permission = ask('Masz zmiany zapisane w tej przeglądarce. Przenieść je do wybranego CSV? Pozostałe dane z pliku zostaną zachowane. Anuluj, żeby najpierw wyeksportować kopię.');
      if (!permission) return false;
      fileHandle = handle; busy = true;
      try { const author = await ensureAuthor(); await writeRecords(C.stampFile(outcome.records, new Date().toISOString(), author), parsed.headers, text); } finally { busy = false; }
    } else {
      base = parsed.records; records = [...base]; headers = parsed.headers; fileText = text;
      local = { patches: {}, added: [], imported: base, meta: C.fileMeta(base), info: { name: file.name || 'klienci.csv', modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : '' } }; await persist();
    }
    fileHandle = handle; connected = true; connectionError = ''; await persist(); await rememberHandle(handle); render();
    return true;
  }
  function openConnection() {
    $('connectError').hidden = true;
    $('chooseCSV').textContent = I18n.message(fileHandle && !connected ? 'Połącz ponownie z plikiem' : 'Wybierz klienci.csv');
    try { const config = JSON.parse(localStorage.getItem('pracownia.github.config') || 'null'); if (config) { $('ghRepo').value = config.owner + '/' + config.repo; $('ghBranch').value = config.branch; $('ghPath').value = config.path; } } catch {}
    $('connectDialog').showModal(); switchConnectionMode(github || !fileHandle ? 'github' : 'file'); connectionUI();
  }
  async function chooseCSV() {
    if (!('showOpenFilePicker' in window)) {
      $('connectError').textContent = I18n.message('Ta przeglądarka nie obsługuje bezpośredniego zapisu do pliku. Otwórz panel w Chrome lub Edge albo korzystaj z przycisków Importuj i Eksportuj CSV.');
      $('connectError').hidden = false; return;
    }
    $('chooseCSV').disabled = true;
    try {
      let handle = fileHandle && !connected ? fileHandle : null;
      if (handle) {
        if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Przeglądarka nie udzieliła dostępu do zapisu. Możesz ponownie wybrać plik po rozłączeniu.');
      } else {
        [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Lista klientów CSV', accept: { 'text/csv': ['.csv'] } }] });
        if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Pozwól zapisywać zmiany, aby połączyć listę.');
      }
      const established = await establishConnection(handle);
      if (established) { $('connectDialog').close(); toast('Połączono z CSV. Zmiany asystenta pojawią się automatycznie.'); }
    } catch (error) { if (error.name !== 'AbortError') { $('connectError').textContent = I18n.message(error.message); $('connectError').hidden = false; } }
    finally { $('chooseCSV').disabled = false; }
  }
  async function disconnect() {
    if (busy || githubBusy) return;
    connected = false; fileHandle = null; connectionError = ''; fileText = null;
    if (github) { github.close(); github = null; } $('ghToken').value = '';
    local = { patches: {}, added: [], imported: records.map(r => ({ ...r })), meta: C.fileMeta(records), info: local.info }; base = [...records]; await persist();
    try { const db = await fileDB(); const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').delete('csv'); tx.oncomplete = () => db.close(); } catch {}
    $('connectDialog').close(); render(); toast('Rozłączono plik. Bieżąca lista zostaje w przeglądarce.');
  }
  async function pollFile() {
    if (!connected || busy || githubBusy || fileBusy || document.hidden) return;
    if (github) {
      if (Date.now() - lastGitHubPoll < 15000) return;
      githubBusy = true; lastGitHubPoll = Date.now(); const session = github;
      try { const result = await session.read(); if (github !== session || !connected) return; if (result.sha !== local.info?.sha) { await adoptShared(result, { sha: result.sha }); render(); if (selected && !actionDirty() && !$('editDialog').open) { if (byId(selected)) openClient(selected, true); else closeDrawer(true); } } connectionError = ''; connectionUI(); }
      catch { connectionError = 'Nie odświeżono wspólnej bazy. Ostatnia kopia zostaje widoczna; kolejne odświeżenie za 15 s.'; connectionUI(); }
      finally { githubBusy = false; } return;
    }
    if (!fileHandle) return;
    const session = fileHandle; fileBusy = true;
    try {
      const file = await session.getFile(); const text = await file.text();
      if (fileHandle !== session || !connected || text === fileText) return;
      const parsed = C.parseCSV(text); parsed.records.forEach(C.callHistory);
      fileText = text; base = parsed.records; headers = parsed.headers; records = [...base];
      local = { patches: {}, added: [], imported: base, meta: C.fileMeta(base), info: { name: file.name || 'klienci.csv', modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : '' } }; connectionError = ''; await persist(); render();
      if (selected && $('drawer').hidden === false && !actionDirty() && !$('editDialog').open) {
        if (byId(selected)) openClient(selected, true); else closeDrawer(true);
      }
      toast('Lista zaktualizowana z pliku CSV.');
    } catch (error) {
      if (fileHandle !== session || !connected) return;
      connected = false; connectionError = 'Połączenie z CSV przerwane. Ostatnie dane są zachowane. Kliknij Połącz CSV, aby wznowić synchronizację.';
      connectionUI();
    } finally { fileBusy = false; }
  }

  async function decidePlace(entity, value, reason = '') {
    const author = await ensureAuthor();
    const existing = M.matchRecord(entity, records);
    if (existing?.Google_place_id && value === 'przejrzana') return existing;
    const patch = { ...M.decision(existing, value, author, reason), Google_place_id: entity.id };
    if (existing) await saveChange(existing.Id, patch, { ...existing });
    else {
      const record = { ...M.draft(entity), ...patch };
      await saveChange(record.Id, {}, null, record);
    }
    return M.matchRecord(entity, records);
  }
  function openExclude(id) {
    const record = byId(id); if (!record || busy || !requireProfile()) return;
    if (M.state(record) === 'wykreslona') {
      saveChange(id, { ...M.decision(record, 'dodana', authorName), Etap: 'Do sprawdzenia' }, { ...record })
        .then(() => { if (selected === id) openClient(id, true); }).catch(error => toast(error.message, true));
      return;
    }
    excludeOriginal = { ...record }; $('excludeName').textContent = record.Firma;
    $('excludeReason').value = ''; $('excludeError').hidden = true; $('excludeDialog').showModal();
  }
  $('excludeForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!excludeOriginal || busy) return;
    const record = excludeOriginal; $('saveExclude').disabled = true;
    try {
      await saveChange(record.Id, M.decision(record, 'wykreslona', await ensureAuthor(), $('excludeReason').value.trim()), record);
      $('excludeDialog').close(); if (selected === record.Id) openClient(record.Id, true);
    } catch (error) { $('excludeError').textContent = I18n.message(error.message); $('excludeError').hidden = false; }
    finally { $('saveExclude').disabled = false; }
  });
  for (const id of ['closeExclude', 'cancelExclude']) $(id).onclick = () => $('excludeDialog').close();
  $('excludeDialog').addEventListener('close', () => { excludeOriginal = null; });
  window.CRM = {
    records: () => records.map(record => ({ ...record })), profile: () => authorName,
    decidePlace,
    open: id => { if (window.PanelUI?.showTab('companies')) { openClient(id); return true; } return false; },
  };
  $('stageFilter').innerHTML += C.stages.map(stage => '<option value="' + esc(stage) + '">' + esc(t(stage === 'Odrzucony' ? 'Wykreślone' : stage)) + '</option>').join('') + '<option value="__reviewed">' + esc(t('Przejrzane na mapie')) + '</option>';
  for (const id of ['search', 'industryFilter', 'stageFilter', 'callFilter', 'priorityFilter', 'pinFilter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', render);
  for (const id of ['sortField', 'sortDirection']) $(id).addEventListener('change', () => {
    if (id === 'sortField') {
      const field = $('sortField').value;
      if (!Object.hasOwn(C.sortFields, field)) return;
      sorting = { field, direction: ['updated', 'added', 'called'].includes(field) ? 'desc' : 'asc' };
    } else {
      if (!['asc', 'desc'].includes($('sortDirection').value)) return;
      sorting.direction = $('sortDirection').value;
    }
    try { localStorage.setItem(SORT_STORE, JSON.stringify(sorting)); } catch {}
    render();
  });
  $('addClient').onclick = () => openForm();
  $('clientsContent').addEventListener('click', event => {
    const pin = event.target.closest('[data-pin]'); if (pin) return togglePin(pin);
    const priority = event.target.closest('[data-priority]'); if (priority) { openPriority(priority.dataset.priority); return; }
    const status = event.target.closest('[data-status]'); if (status) { openStatus(status.dataset.status); return; }
    const call = event.target.closest('[data-call]'); if (call) { registerPhone(call.dataset.call); return; }
    if (event.target.closest('a[href]')) return;
    const item = event.target.closest('[data-client]'); if (item) { openClient(item.dataset.client); return; }
    if (event.target.closest('[data-import-csv]')) $('importButton').click();
    if (event.target.closest('[data-clear-filters]')) { for (const id of ['search', 'industryFilter', 'stageFilter', 'callFilter', 'priorityFilter', 'pinFilter']) $(id).value = ''; render(); }
  });
  $('clientsContent').addEventListener('keydown', event => { if (event.target.closest('button,a,input,select')) return; const row = event.target.closest('tr[data-client]'); if (row && ['Enter', ' '].includes(event.key)) { event.preventDefault(); openClient(row.dataset.client); } });
  $('drawer').addEventListener('click', async event => {
    const priority = event.target.closest('[data-priority]'); if (priority) { openPriority(priority.dataset.priority); return; }
    const pin = event.target.closest('[data-pin]'); if (pin) { await togglePin(pin); return; }
    const preview = event.target.closest('[data-google-preview]'); if (preview) { window.GoogleMapSession?.open(preview.dataset.googlePreview); return; }
    const exclude = event.target.closest('[data-exclude]'); if (exclude) { openExclude(exclude.dataset.exclude); return; }
    const copy = event.target.closest('[data-copy-phone]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copyPhone); toast('Skopiowano numer telefonu.'); }
      catch { toast('Nie udało się skopiować. Zaznacz numer i skopiuj go ręcznie.', true); }
      return;
    }
    const status = event.target.closest('[data-status]'); if (status) { openStatus(status.dataset.status); return; }
    const call = event.target.closest('[data-call]'); if (call) { await registerPhone(call.dataset.call); return; }
    if (event.target.closest('[data-close-drawer]')) closeDrawer();
    if (event.target.closest('[data-edit-client]')) openForm(byId(selected));
    const navigation = event.target.closest('[data-navigate]'); if (navigation) navigateCompany(Number(navigation.dataset.navigate));
    if (event.target.closest('#saveActions')) {
      const button = $('saveActions'), id = selected; button.disabled = true;
      const patch = {}, mapping = { actionNext: 'Nastepny krok', actionDue: 'Termin', actionNotes: 'Notatki', actionConsent: 'Zgoda data i zakres' };
      const submitted = Object.fromEntries(Object.keys(mapping).map(field => [field, $(field).value]));
      for (const [field, key] of Object.entries(mapping)) { const value = submitted[field].trim(); if (value !== (actionOriginal[key] || '')) patch[key] = value; }
      try {
        await saveChange(id, patch, actionOriginal);
        if (selected === id) {
          const current = Object.fromEntries(Object.keys(mapping).map(field => [field, $(field).value]));
          openClient(id, true, true);
          for (const field of Object.keys(mapping)) if (current[field] !== submitted[field]) $(field).value = current[field];
        }
        toast('Zapisano działania i notatki.');
      }
      catch (error) { toast(error.message, true); button.disabled = false; }
    }
  });
  $('statusForm').addEventListener('submit', event => event.preventDefault());
  $('statusOptions').addEventListener('change', changeStatus);
  $('closeStatus').onclick = () => { if (!statusSaving) $('statusDialog').close(); };
  $('statusDialog').addEventListener('cancel', event => { if (statusSaving) event.preventDefault(); });
  $('statusDialog').addEventListener('close', () => { statusOriginal = null; });
  $('priorityForm').addEventListener('submit', event => event.preventDefault());
  $('priorityOptions').addEventListener('change', changePriority);
  $('closePriority').onclick = () => { if (!prioritySaving) $('priorityDialog').close(); };
  $('priorityDialog').addEventListener('cancel', event => { if (prioritySaving) event.preventDefault(); });
  $('priorityDialog').addEventListener('close', () => { priorityOriginal = null; });
  $('callForm').addEventListener('submit', submitCall);
  $('closeCall').onclick = closeCall; $('cancelCall').onclick = closeCall;
  $('callDialog').addEventListener('cancel', event => { event.preventDefault(); closeCall(); });
  $('callDialog').addEventListener('close', () => { callOriginal = null; });
  document.addEventListener('crm:beforetab', event => { if (busy || githubBusy) { event.preventDefault(); return; } if (selected && !closeDrawer()) event.preventDefault(); });
  $('clientForm').addEventListener('submit', submitForm);
  function closeForm() {
    const changed = Object.keys(changedFields(editOriginal, new FormData($('clientForm')))).length;
    const meaningful = editOriginal ? changed : [...new FormData($('clientForm'))].some(([key, value]) => !['stage', 'priority'].includes(key) && value.trim());
    if (meaningful && !ask('Zamknąć formularz bez zapisywania zmian?')) return;
    $('editDialog').close(); editOriginal = null;
  }
  $('closeForm').onclick = closeForm; $('cancelForm').onclick = closeForm;
  $('editDialog').addEventListener('cancel', event => { event.preventDefault(); closeForm(); });
  $('editDialog').addEventListener('close', () => { editOriginal = null; });
  $('connectButton').onclick = openConnection;
  $('closeConnect').onclick = () => $('connectDialog').close(); $('chooseCSV').onclick = chooseCSV; $('disconnectButton').onclick = disconnect;
  $('exportButton').onclick = () => {
    const meta = local.meta || C.fileMeta(records);
    download('klienci-' + today() + '.csv', C.csvText(meta.at ? C.stampFile(records, meta.at, meta.by) : records, headers));
    toast('Pobrano pełny CSV z datą edycji, statusami i historią telefonów.');
  };
  $('importButton').onclick = () => { $('importFile').value = ''; $('importFile').click(); };
  $('importFile').addEventListener('change', event => importCSV(event.target.files[0]));
  $('companiesPanel').addEventListener('dragover', event => { if (event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); $('companiesPanel').classList.add('dragover'); } });
  $('companiesPanel').addEventListener('dragleave', event => { if (!event.relatedTarget || !$('companiesPanel').contains(event.relatedTarget)) $('companiesPanel').classList.remove('dragover'); });
  $('companiesPanel').addEventListener('drop', event => { event.preventDefault(); $('companiesPanel').classList.remove('dragover'); importCSV(event.dataTransfer.files[0]); });
  $('githubMode').onclick = () => switchConnectionMode('github'); $('fileMode').onclick = () => switchConnectionMode('file');
  $('connectGitHub').onclick = connectGitHub;
  $('profileSelect').value = authorName;
  $('profileSelect').addEventListener('change', () => {
    if (busy || githubBusy || callsInProgress.size || priorityInProgress.size) { $('profileSelect').value = authorName; return; }
    authorName = ['T', 'K'].includes($('profileSelect').value) ? $('profileSelect').value : '';
    try { localStorage.setItem('pracownia.author', authorName); } catch {}
  });
  document.addEventListener('keydown', event => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === '/' && !$('companiesPanel').hidden && !typing && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open && $('drawer').hidden) { event.preventDefault(); $('search').focus(); }
    if (event.key === 'Escape' && !$('drawer').hidden && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open) closeDrawer();
    if (!typing && !$('drawer').hidden && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open && !event.altKey && !event.ctrlKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigateCompany(event.key === 'ArrowLeft' ? -1 : 1); }

  });
  window.addEventListener('beforeunload', event => {
    if (busy || githubBusy || actionDirty() || $('editDialog').open || $('callDialog').open || (!storageOK && records.length)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORE && event.key !== null) return;
    storageOK = false; storageError = 'Inna karta zmieniła lokalną kopię. Wyeksportuj swoje dane i odśwież stronę przed dalszym zapisem.';
    connectionUI();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollFile(); });
  document.addEventListener('crm:language', () => { render(); if (selected) openClient(selected, true); if ($('callDialog').open) renderCallOptions($('callOutcome').value); I18n.bindUI($('editDialog')); I18n.bindUI($('statusDialog')); if ($('priorityDialog').open && priorityOriginal) renderPriorityOptions(priorityOriginal); });
  render(); restoreHandle(); autoLoadCSV(); setInterval(pollFile, 3000);
})();
