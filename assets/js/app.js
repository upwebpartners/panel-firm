/* Panel klientów. CSV jest wspólnym źródłem danych po połączeniu. */
(function () {
  'use strict';
  const M = MapCore;
  const C = CRMCore, F = C.fields, $ = id => document.getElementById(id);
  const t = I18n.t, ask = (value, options) => window.PanelDialogs.confirm(value, options);
  const seed = JSON.parse($('initial-data').textContent);
  seed.records = seed.records.map(r => ({ ...C.cleanRecord(r), Id: r.Id || C.stableId(r), Etap: C.normalizeStage(r.Etap || 'Nowy') }));
  seed.headers = C.cleanHeaders(seed.headers);
  // Existing storage keys also contain user notes and must remain stable.
  const STORE = 'pracownia.crm.v1';
  const SORT_STORE = 'pracownia.sort';
  const HIDE_REJECTED_STORE = 'pracownia.hide-rejected';
  const HIDDEN_STAGES_STORE = 'pracownia.hidden-stages';
  const CALL_AUTO_STATUS_STORE = 'pracownia.call-auto-status';
  let callAutoStatus = true;
  try { callAutoStatus = localStorage.getItem(CALL_AUTO_STATUS_STORE) !== 'false'; } catch {}
  let hiddenStages = new Set(['Archiwum']);
  try {
    const saved = JSON.parse(localStorage.getItem(HIDDEN_STAGES_STORE) || 'null');
    if (Array.isArray(saved) && saved.every(stage => typeof stage === 'string')) hiddenStages = new Set(saved.map(C.normalizeStage).filter(stage => C.stages.includes(stage)));
    else if (localStorage.getItem(HIDE_REJECTED_STORE) === 'true') hiddenStages.add('Odrzucony');
  } catch {}
  const GITHUB_SESSION_STORE = 'pracownia.github.session';
  const SORT_VERSION = 2;
  let sorting = { field: 'added', direction: 'desc' };
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_STORE) || 'null');
    if (saved?.version === SORT_VERSION && Object.hasOwn(C.sortFields, saved.field) && ['asc', 'desc'].includes(saved.direction)) sorting = { field: saved.field, direction: saved.direction };
  } catch { /* Invalid preferences never block access to company data. */ }
  let local = { patches: {}, added: [], imported: null, meta: null, info: null };
  let storageOK = true, storageError = '', browserStore;
  try { browserStore = new BrowserStore(localStorage, STORE); const stored = browserStore.load(); if (stored) local = stored; }
  catch (error) { storageOK = false; storageError = error.message; }
  local = { ...local, removed: local.removed || {}, patches: Object.fromEntries(Object.entries(local.patches).map(([id, patch]) => [id, C.cleanRecord(patch)])), added: local.added.map(C.cleanRecord), imported: local.imported?.map(C.cleanRecord) || null, ...(local.headers ? { headers: C.cleanHeaders(local.headers) } : {}) };
  let base = local.imported || seed.records;
  let headers = local.headers || [...new Set([...seed.headers, ...base.flatMap(Object.keys), ...local.added.flatMap(Object.keys)])];
  let records = C.overlay(base, local.patches, local.added, local.removed);
  let fileHandle = null, connected = false, busy = false, fileText = null, connectionError = '';
  let selected = null, editOriginal = null, actionOriginal = null, returnFocus = null, formSaving = false, formInitialName = '';
  let deferredCompanyRefresh = null;
  let browseIds = [], statusOriginal = null, statusSaving = false, excludeOriginal = null;
  let priorityOriginal = null, prioritySaving = false;
  let toastTimer = null;
  let saveProgress = null, progressTimer = null, progressHideTimer = null;
  let github = null, githubBusy = false, fileBusy = false, lastGitHubPoll = 0;
  let rememberedGitHub = null, restoringGitHub = false, changingSource = false;
  let restoreRetryAt = 0, restoreFailures = 0;
  let syncRunning = false, syncError = null, syncRetryTimer = null, syncFailures = 0;
  let localWriteChain = Promise.resolve();
  let placeDetailsChain = Promise.resolve();
  let authorName = '';
  try { const saved = localStorage.getItem('pracownia.author'); if (['T', 'K'].includes(saved)) authorName = saved; } catch {}
  let draftId = null;
  const pendingCalls = new Map();
  const callsInProgress = new Set();
  const priorityInProgress = new Set();
  const deletionsInProgress = new Set();
  let callOriginal = null, callSaving = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const val = (record, name) => record[F[name]] || '';
  const today = () => { const date = new Date(); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); };
  const prettyDate = value => { if (!value) return ''; const date = new Date(value + 'T12:00:00'); return Number.isNaN(+date) ? value : date.toLocaleDateString(I18n.locale(), { day: 'numeric', month: 'short', year: 'numeric' }); };
  const stageSlug = value => C.norm(value).replace(/\s+/g, '-');
  const stagePill = record => '<span class="stage-pill ' + esc(stageSlug(record.Etap)) + '">' + esc(t(record.Etap || 'Nowy')) + '</span>';
  let indexedRows = null, indexedRecords = null, renderedRows = null, clientsMarkup = null;
  function showClients(markup) {
    if (clientsMarkup === markup) return;
    $('clientsContent').innerHTML = markup; clientsMarkup = markup;
    I18n.bindUI($('clientsContent'));
  }
  function recordIndex() {
    if (indexedRows !== records) { indexedRows = records; indexedRecords = C.recordIndex(records); }
    return indexedRecords;
  }
  const byId = id => recordIndex().ids.get(id);
  const companyPreview = record => (record.Google_place_id ? window.GoogleMapSession?.get(record.Google_place_id) : null) || M.storedDetails(record);
  const hasPending = () => Object.keys(local.patches).length > 0 || local.added.length > 0 || Object.keys(local.removed || {}).length > 0;
  const hasQueued = () => !!local.sync && hasPending();
  const targetKey = config => config ? JSON.stringify([String(config.owner || '').toLowerCase(), String(config.repo || '').toLowerCase(), config.branch, String(config.path || '').trim().replace(/^\/+/, '')]) : '';
  const sameTarget = (a, b) => targetKey(a) === targetKey(b);
  function writeLocal(action) {
    const result = localWriteChain.then(action);
    localWriteChain = result.catch(() => {}); return result;
  }
  function structuredRemovals(removed = {}) {
    return Object.fromEntries(Object.entries(removed).map(([id, versions]) => [id, versions.map(record => ({ ...record }))]));
  }
  function refreshCompanyView() {
    render();
    if (selected && byId(selected)) openClient(selected, true);
  }
  async function enqueueShared(target, originals, patches, added, author, at) {
    await writeLocal(async () => {
      if (hasQueued() && !sameTarget(local.sync.target, target)) throw new Error('Najpierw wyślij oczekujące zmiany do poprzedniej bazy.');
      const merged = C.merge(originals, records, patches, added);
      if (merged.conflicts.length) throw new Error('Te dane zmieniły się w panelu. Otwórz ponownie kartę firmy.');
      busy = true;
      try {
        const desired = new Map(merged.records.map(record => [record.Id, record]));
        const next = { ...local, patches: { ...local.patches }, added: [...local.added, ...added], imported: base,
          meta: { at, by: author }, sync: { ...local.sync, target: { ...target }, author } };
        for (const [id, patch] of Object.entries(patches)) {
          const values = Object.fromEntries(Object.keys(patch).map(key => [key, desired.get(id)?.[key] ?? patch[key]]));
          next.patches = { ...next.patches, [id]: { ...(next.patches[id] || {}), ...values } };
        }
        await persist(next, true); local = next;
        records = C.stampFile(C.overlay(base, local.patches, local.added, local.removed), at, author);
      } finally { busy = false; connectionUI(); }
    });
    render(); kickSync();
  }
  function blockedSync(error) { return error?.code !== 'RATE_LIMIT' && (['CONFLICT', 'OUTDATED_CLIENT'].includes(error?.code) || [401,403,404,422].includes(error?.status)); }
  function kickSync() {
    if (syncRetryTimer || syncError && blockedSync(syncError)) return;
    void flushQueue();
  }
  async function flushQueue(resolveConflicts = false) {
    if (syncRunning || githubBusy || !github || !connected || !hasQueued() || !sameTarget(local.sync.target, github.config)) return;
    if (syncError && blockedSync(syncError) && !resolveConflicts) return;
    clearTimeout(syncRetryTimer); syncRetryTimer = null;
    const session = github; syncRunning = true; syncError = null; connectionError = ''; connectionUI();
    try {
      while (hasQueued() && github === session && connected) {
        const sent = await writeLocal(async () => {
          if (local.sync.inflight) return local.sync.inflight;
          const batch = {
          base: base.map(record => ({ ...record })),
          patches: Object.fromEntries(Object.entries(local.patches).map(([id, patch]) => [id, { ...patch }])),
          added: local.added.map(record => ({ ...record })), removed: structuredRemovals(local.removed), author: local.sync.author
          };
          const next = { ...local, sync: { ...local.sync, inflight: batch } };
          await persist(next, true); local = next; return batch;
        });
        if (Object.keys(sent.removed || {}).length && session.removalVersion !== 1) {
          const error = new Error('Odśwież panel przez Ctrl+Shift+R przed usuwaniem firmy.'); error.code = 'OUTDATED_CLIENT'; throw error;
        }
        await trackSave('github', async () => {
          const newIds = new Set(sent.added.map(record => record.Id));
          const updates = Object.fromEntries(Object.entries(sent.patches).filter(([id]) => !newIds.has(id)));
          const additions = C.overlay([], sent.patches, sent.added, sent.removed);
          const result = resolveConflicts ? await saveShared(session, sent.base, updates, additions, sent.author, true, sent.removed) : await session.save(sent.base, updates, additions, sent.author, sent.removed);
          await writeLocal(async () => {
            if (github !== session || !connected) return;
            const remaining = Object.fromEntries(Object.entries(local.patches).map(([id, patch]) => [id, { ...patch }]));
            for (const [id, patch] of Object.entries(sent.patches)) {
              for (const [key, value] of Object.entries(patch)) if (remaining[id]?.[key] === value) delete remaining[id][key];
              if (remaining[id] && !Object.keys(remaining[id]).length) delete remaining[id];
            }
            const accepted = new Set(sent.added.map(record => record.Id));
            const added = local.added.filter(record => !accepted.has(record.Id));
            const removed = structuredRemovals(local.removed);
            for (const [id, versions] of Object.entries(sent.removed || {})) if (JSON.stringify(removed[id]) === JSON.stringify(versions)) delete removed[id];
            const pending = added.length || Object.keys(remaining).length || Object.keys(removed).length;
            const nextBase = result.records.map(record => ({ ...record }));
            const nextHeaders = [...new Set([...result.headers, ...headers])];
            const next = { ...local, patches: remaining, added, removed, imported: nextBase, headers: nextHeaders,
              sync: pending ? { ...local.sync, inflight: null } : null, meta: pending ? local.meta : C.fileMeta(nextBase),
              info: { ...local.info, name: session.config.path, modifiedAt: result.at || '', by: result.by || '', sha: result.sha || null } };
            await persist(next, true);
            base = nextBase; headers = nextHeaders; local = next;
            records = C.overlay(base, local.patches, local.added, local.removed);
            lastGitHubPoll = Date.now(); connectionError = ''; syncFailures = 0;
          });
        });
        refreshCompanyView();
      }
    } catch (error) {
      if (github === session && connected) {
        syncError = error;
        // A reported conflict means no write occurred. A network failure may
        // hide a successful write, so retain that exact batch for safe replay.
        let restoredRemoval = false;
        if (error.code === 'CONFLICT') await writeLocal(async () => {
          const removed = structuredRemovals(local.removed);
          const restored = new Map((error.conflicts || []).filter(conflict => conflict.removal && conflict.current && Object.hasOwn(removed, conflict.id)).map(conflict => [conflict.id, conflict.current]));
          for (const id of restored.keys()) delete removed[id];
          const nextBase = base.map(record => ({ ...(restored.get(record.Id) || record) }));
          for (const [id, record] of restored) if (!nextBase.some(row => row.Id === id)) nextBase.push({ ...record });
          const pending = Object.keys(local.patches).length || local.added.length || Object.keys(removed).length;
          const next = { ...local, removed, imported: nextBase, sync: pending ? { ...local.sync, inflight: null } : null };
          try {
            await persist(next, true); local = next; base = nextBase;
            records = C.overlay(base, local.patches, local.added, local.removed);
            restoredRemoval = restored.size > 0;
          } catch { /* Keep the durable batch if local storage is unavailable. */ }
        });
        connectionError = error.code === 'CONFLICT' ? 'Konflikt zapisu. Lokalne zmiany są zachowane. Kliknij Porównaj zmiany.' : 'Nie wysłano zmian do GitHuba. Zostały zachowane w przeglądarce.';
        if (restoredRemoval) {
          connectionError = 'Nie usunięto firmy, bo druga osoba zmieniła jej dane. Firma wróciła na listę. Otwórz ją i sprawdź przed ponownym usunięciem.';
          if (error.conflicts.every(conflict => conflict.removal)) syncError = null;
          refreshCompanyView();
        } else connectionError += ' ' + I18n.message(error.message);
        if (!blockedSync(error)) syncRetryTimer = setTimeout(() => { syncRetryTimer = null; kickSync(); }, Math.max((error.retryAt || 0) - Date.now(), Math.min(30000, 2000 * 2 ** Math.min(syncFailures++, 4))));
      }
    } finally { syncRunning = false; connectionUI(); if (!syncError && hasQueued()) kickSync(); }
  }

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
    $('fileInfo').innerHTML = '<div>' + icon('note') + '<strong>' + esc(fileName) + '</strong><span>' + esc(t(source)) + '</span></div><div><span>' + esc(t('Ostatnia edycja pliku:')) + '</span><strong>' + esc(dateTime(at)) + '</strong>' + (by ? '<span>· ' + esc(by) + '</span>' : '') + '</div>' + (local.info?.uploadedFileModifiedAt ? '<span>' + esc(t('Wczytany CSV zmieniono:')) + ' ' + esc(dateTime(local.info.uploadedFileModifiedAt)) + '</span>' : '');
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
  function rememberGitHub(config, token) {
    const session = { version: 1, config: { ...config }, token };
    try { localStorage.setItem(GITHUB_SESSION_STORE, JSON.stringify(session)); rememberedGitHub = session; return true; }
    catch { return false; }
  }
  async function restoreGitHub() {
    let raw;
    try { raw = localStorage.getItem(GITHUB_SESSION_STORE); } catch { return false; }
    if (!raw) return false;
    rememberedGitHub = {}; restoringGitHub = true; githubBusy = true; restoreRetryAt = 0; connectionUI();
    let candidate, reading = false;
    try {
      let session;
      try { session = JSON.parse(raw); }
      catch { throw new Error('Zapisane połączenie jest nieprawidłowe. Zmień je w ustawieniach GitHuba.'); }
      if (session?.version !== 1 || typeof session.token !== 'string' || !session.token.trim() || !session.config || !['owner', 'repo', 'branch', 'path'].every(key => typeof session.config[key] === 'string')) throw new Error('Zapisane połączenie jest nieprawidłowe. Zmień je w ustawieniach GitHuba.');
      rememberedGitHub = session;
      candidate = new GitHubCSV(session.config, session.token);
      reading = true;
      const result = await candidate.connect(); reading = false;
      if (result.missing) throw new Error('Na GitHubie nie ma tego CSV. Wybierz zastąpienie bazy obecną listą, aby go utworzyć.');
      await writeLocal(async () => {
        if (hasQueued() && !sameTarget(local.sync.target, session.config)) throw new Error('Oczekujące zmiany należą do innej bazy. Połącz poprzednie repozytorium.');
        const plan = C.sharedConnectionPlan(base, result.records, local.patches, local.added);
        if (!hasQueued() && (plan.added.length || Object.keys(plan.patches).length)) throw new Error('Masz lokalne zmiany. W ustawieniach GitHuba wybierz, czy je połączyć, czy wczytać wspólną bazę.');
        github = candidate; connected = true; connectionError = ''; lastGitHubPoll = Date.now();
        if (!hasQueued()) await adoptShared(result);
      });
      render();
      restoreFailures = 0;
      if (selected && !actionDirty()) { if (byId(selected)) openClient(selected, true); else closeDrawer(true); }
    } catch (error) {
      candidate?.close(); connectionError = I18n.message('Nie połączono zapamiętanej bazy. Otwórz ustawienia GitHuba.') + ' ' + I18n.message(error.message);
      if (reading && !blockedSync(error)) restoreRetryAt = Math.max(error.retryAt || 0, Date.now() + Math.min(30000, 5000 * 2 ** Math.min(restoreFailures++, 3)));
    } finally { restoringGitHub = false; githubBusy = false; connectionUI(); kickSync(); }
    return true;
  }
  function updateSaveProgress() {
    if (!saveProgress) return;
    const zones = window.ZoneUI?.status();
    if (zones?.pending || zones?.error) { $('saveProgress').hidden = true; return; }
    const labels = {
      github: { saving: 'Zapis do GitHuba…', saved: 'Zapisano w bazie', failed: 'Nie zapisano w bazie' },
      file: { saving: 'Zapis do CSV…', saved: 'Zapisano plik CSV', failed: 'Nie zapisano pliku CSV' },
      browser: { saving: 'Zapis lokalny…', saved: 'Zapisano w przeglądarce', failed: 'Nie zapisano lokalnie' }
    };
    const elapsed = saveProgress.elapsed ?? Math.max(0, Date.now() - saveProgress.startedAt);
    $('saveProgress').hidden = false; $('saveProgress').className = 'save-progress ' + saveProgress.state;
    $('saveProgressLabel').textContent = t(labels[saveProgress.target][saveProgress.state]);
    $('saveProgressTime').textContent = (elapsed / 1000).toLocaleString(I18n.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s';
  }
  async function trackSave(target, operation) {
    clearInterval(progressTimer); clearTimeout(progressHideTimer);
    saveProgress = { target, startedAt: Date.now(), state: 'saving' }; updateSaveProgress();
    progressTimer = setInterval(updateSaveProgress, 200);
    try {
      const result = await operation();
      saveProgress.state = 'saved'; return result;
    } catch (error) { saveProgress.state = 'failed'; throw error; }
    finally {
      clearInterval(progressTimer); progressTimer = null;
      saveProgress.elapsed = Math.max(0, Date.now() - saveProgress.startedAt); updateSaveProgress();
      if (saveProgress.state === 'saved') progressHideTimer = setTimeout(() => { $('saveProgress').hidden = true; }, 6000);
    }
  }
  function updateGitHubModeHint() {
    const hints = {
      remote: 'Wczyta bazę z GitHuba zamiast lokalnej kopii. Przy łączeniu niczego nie zapisze na GitHubie.',
      replace: 'Wyśle całą obecną listę do GitHuba i zastąpi wspólną bazę, także notatki, statusy i rozmowy. Poprosi o potwierdzenie.',
      merge: 'Połączy lokalne zmiany z bazą na GitHubie. W razie różnych notatek pokaże obie wersje.'
    };
    $('ghDataModeHint').textContent = t(hints[$('ghDataMode').value] || hints.remote);
  }
  async function saveShared(client, originals, patches, added, author, reviewFields = false, removed = {}) {
    let before = originals.map(record => ({ ...record }));
    const pending = Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, { ...patch }]));
    for (;;) {
      try { return await client.save(before, pending, added, author, removed); }
      catch (error) {
        if (error.code !== 'CONFLICT' || !error.conflicts?.length || error.conflicts.some(conflict => (!reviewFields && conflict.field !== 'Notatki') || !Object.hasOwn(pending[conflict.id] || {}, conflict.field) || !before.some(record => record.Id === conflict.id))) throw error;
        for (const conflict of error.conflicts) {
          if (conflict.field !== 'Notatki') {
            const message = conflict.name + ' · ' + t(conflict.field) + '\n\n' + t('Zapisać swoją wersję tego pola? Anuluj zachowa obie wersje bez zmian na GitHubie.');
            if (!await ask(message, { title: 'Porównaj zmiany', accept: 'Zachowaj moją wersję', sections: [{ label: 'Na GitHubie:', text: String(conflict.value ?? '') }, { label: 'W tej przeglądarce:', text: String(pending[conflict.id][conflict.field] ?? '') }] })) throw error;
            before = before.map(record => record.Id === conflict.id ? { ...record, [conflict.field]: conflict.value } : record);
            continue;
          }
          const shared = String(conflict.value ?? ''), own = String(pending[conflict.id].Notatki ?? '');
          const combined = !own || shared.includes(own) ? shared : !shared || own.includes(shared) ? own : shared + '\n\n' + own;
          const message = t('Różne notatki') + ' — ' + conflict.name + '\n\n' + t('Połączyć obie wersje i zapisać? Anuluj zachowa Twoją lokalną kopię.');
          if (!await ask(message, { title: 'Różne notatki', accept: 'Połącz notatki', sections: [{ label: 'Na GitHubie:', text: shared || t('(pusta notatka)') }, { label: 'W tej przeglądarce:', text: own || t('(pusta notatka)') }] })) {
            const cancelled = new Error('Przerwano zapis. Twoje lokalne zmiany zostały zachowane.');
            cancelled.code = 'CONFLICT'; cancelled.conflicts = error.conflicts; throw cancelled;
          }
          pending[conflict.id] = { ...pending[conflict.id], Notatki: combined, Modyfikacja: new Date().toISOString(), Edytowal: author };
          // Rebase only the note the person has just reviewed. Other fields
          // retain their original baseline and full conflict protection.
          before = before.map(record => record.Id === conflict.id ? { ...record, Notatki: shared } : record);
        }
      }
    }
  }
  async function connectGitHub() {
    if (busy || githubBusy || syncRunning) return;
    const controls = ['connectGitHub', 'ghDataMode', 'closeConnect', 'fileMode'];
    controls.forEach(id => { $(id).disabled = true; }); $('connectError').hidden = true; githubBusy = true; changingSource = true;
    let candidate;
    try {
      if (fileHandle) throw new Error('Najpierw rozłącz obecne źródło, aby przełączyć repozytorium.');
      const previous = github;
      const mode = $('ghDataMode').value || 'remote';
      if (!['remote', 'replace', 'merge'].includes(mode)) throw new Error('Wybierz bazę przy połączeniu.');
      if (selected && !await confirmLeavingActions()) return;
      const draftFields = ['actionNotes', 'actionConsent'];
      const draftBefore = selected ? draftFields.map(id => $(id).value) : null;
      const currentRecords = records.map(record => ({ ...record })), currentHeaders = [...headers];
      const raw = $('ghRepo').value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
      const pieces = raw.split('/'); if (pieces.length !== 2) throw new Error('Podaj repozytorium jako właściciel/nazwa.');
      const config = { owner: pieces[0], repo: pieces[1], branch: $('ghBranch').value.trim(), path: $('ghPath').value.trim() };
      const token = $('ghToken').value.trim();
      if (hasQueued() && !sameTarget(local.sync.target, config)) throw new Error('Najpierw wyślij oczekujące zmiany do poprzedniej bazy.');
      const resume = hasQueued() && mode !== 'replace';
      candidate = new GitHubCSV(config, token); let result = await candidate.connect();
      if (mode === 'remote') {
        if (result.missing) throw new Error('Na GitHubie nie ma tego CSV. Wybierz zastąpienie bazy obecną listą, aby go utworzyć.');
      } else if (mode === 'replace') {
        const author = await ensureAuthor();
        const message = t('Zastąpić bazę na GitHubie obecną listą?') + '\n\n' + config.owner + '/' + config.repo + '\n' + config.branch + ' / ' + config.path + '\n\n' + t('Na GitHubie:') + ' ' + result.records.length + '\n' + t('W tym panelu:') + ' ' + currentRecords.length + '\n\n' + t('Liczby oznaczają firmy. Cały wspólny plik zostanie zastąpiony, także notatki, statusy i historia rozmów.');
        if (!await ask(message, { title: 'Zastąpienie wspólnej bazy', accept: 'Zastąp bazę', danger: true })) { candidate.close(); return; }
        result = await trackSave('github', () => candidate.replace(currentRecords, currentHeaders, result.sha, author));
      } else if (result.missing && currentRecords.length) {
        if (!await ask('W repozytorium nie ma jeszcze tego CSV. Zapisać w nim obecną listę ' + currentRecords.length + ' firm?', { title: 'Utwórz wspólną bazę', accept: 'Zapisz bazę' })) { candidate.close(); return; }
        const author = await ensureAuthor();
        result = await trackSave('github', () => candidate.save([], {}, currentRecords, author));
      } else if (hasPending() && !resume) {
        const plan = C.sharedConnectionPlan(base, result.records, local.patches, local.added);
        if (plan.added.length || Object.keys(plan.patches).length) {
          if (!await ask('Przenieść lokalne zmiany do wspólnego CSV? Jeśli zmieniono te same pola, zapis zostanie wstrzymany.', { title: 'Połączenie zmian', accept: 'Przenieś zmiany' })) { candidate.close(); return; }
          const author = await ensureAuthor();
          result = await trackSave('github', () => saveShared(candidate, plan.base, plan.patches, plan.added, author));
        }
      }
      github = candidate; connected = true; fileHandle = null; connectionError = ''; lastGitHubPoll = Date.now();
      const remembered = rememberGitHub(config, token);
      try { localStorage.setItem('pracownia.github.config', JSON.stringify(config)); } catch {}
      $('ghToken').value = ''; if (!resume) await adoptShared(result);
      syncError = null; render(); $('connectDialog').close();
      if (previous && previous !== candidate) previous.close();
      if (selected) {
        if (byId(selected)) openClient(selected, true, draftBefore && draftFields.every((id, index) => $(id).value === draftBefore[index]));
        else closeDrawer(true);
      }
      toast(remembered ? 'Połączono wspólną bazę. Połączenie zostało zapamiętane w tej przeglądarce.' : 'Połączono, ale przeglądarka nie pozwoliła zapamiętać połączenia.', !remembered);
    } catch (error) { candidate?.close(); $('ghToken').value = ''; $('connectError').textContent = I18n.message(error.message); $('connectError').hidden = false; }
    finally { githubBusy = false; changingSource = false; controls.forEach(id => { $(id).disabled = false; }); connectionUI(); kickSync(); }
  }
  async function commitBatch(originals, patches, added, author, at) {
    if (changingSource) throw new Error('Poczekaj na zakończenie zmiany ustawień bazy.');
    const target = github?.config || rememberedGitHub?.config || local.sync?.target;
    if (target) return enqueueShared(target, originals, patches, added, author, at);
    if (busy) throw new Error('Poczekaj na zakończenie poprzedniego zapisu.');
    if (githubBusy) throw new Error('Trwa odświeżanie wspólnej bazy. Spróbuj zapisać ponownie za chwilę.');
    if (fileBusy) throw new Error('Trwa odświeżanie pliku. Spróbuj zapisać ponownie za chwilę.');
    if (rememberedGitHub && !connected) throw new Error('Najpierw połącz zapamiętaną bazę w ustawieniach GitHuba lub wybierz Rozłącz i zapomnij.');
    return trackSave(github ? 'github' : connected && fileHandle ? 'file' : 'browser', async () => {
      if (connected && fileHandle) {
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
          if (originals.some(original => !C.isMapDecisionOnly(original) && C.isMapDecisionOnly(byId(original.Id)))) throw new Error('Tej firmy nie ma już w bazie. Odśwież listę.');
          const next = { ...local, patches: { ...local.patches }, added: [...local.added, ...added], meta: { at, by: author } };
          for (const [id, patch] of Object.entries(patches)) {
            if (!byId(id)) throw new Error('Tej firmy nie ma już w bazie. Odśwież listę.');
            const previous = Object.hasOwn(next.patches, id) ? next.patches[id] : {};
            next.patches = { ...next.patches, [id]: { ...previous, ...patch } };
          }
          await persist(next, true); local = next;
          records = C.stampFile(C.overlay(base, local.patches, local.added, local.removed), at, author);
        } finally { busy = false; connectionUI(); }
      }
      render();
    });
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
    $('callAutoStatus').disabled = callSaving || !!pending;
    for (const id of ['saveCall', 'closeCall', 'cancelCall']) $(id).disabled = callSaving;
  }
  function registerPhone(id) {
    const record = byId(id); if (!record || busy || callSaving || !requireProfile()) return;
    const history = displayCallHistory(record);
    const pending = pendingCalls.get(id);
    if (pending && history.some(e => e.id === pending.eventId)) { pendingCalls.delete(id); toast('Ten telefon jest już zapisany we wspólnej bazie.'); return; }
    callOriginal = pending?.original || { ...record };
    $('callCompanyName').textContent = companyTitle(record).name;
    renderCallOptions(pending?.details.outcome || '');
    $('callNotes').value = pending?.details.notes || '';
    $('callAutoStatus').checked = pending?.autoStatus ?? callAutoStatus;
    $('callError').hidden = !pending;
    $('callError').textContent = pending ? t('Dane rozmowy zachowano. Ponów zapis, aby uniknąć zdublowania telefonu.') : '';
    $('callSaveHint').textContent = t(github || rememberedGitHub?.config || local.sync?.target ? '' : connected ? 'Zmiany zapiszą się w klienci.csv.' : 'Zmiany zapiszą się w tej przeglądarce.');
    callControls(); $('callDialog').showModal();
    $(pending ? 'saveCall' : 'callOutcome').focus();
  }
  async function closeCall() {
    if (callSaving) return;
    const original = callOriginal;
    if (($('callOutcome').value || $('callNotes').value.trim()) && !await ask('Zamknąć okno bez zapisywania rozmowy?', { title: 'Niezapisana rozmowa', accept: 'Porzuć zmiany', danger: true })) return;
    if (callSaving || callOriginal !== original) return;
    $('callDialog').close();
  }
  async function submitCall(event) {
    event.preventDefault();
    if (!callOriginal || callSaving || busy) return;
    const id = callOriginal.Id, pending = pendingCalls.get(id);
    const details = pending?.details || { outcome: $('callOutcome').value, notes: $('callNotes').value.trim() };
    const autoStatus = pending?.autoStatus ?? $('callAutoStatus').checked;
    if (!C.callOutcomes.includes(details.outcome)) {
      $('callError').textContent = t('Wybierz wynik rozmowy przed zapisem.'); $('callError').hidden = false; $('callOutcome').focus(); return;
    }
    callSaving = true;
    callsInProgress.add(id);
    callControls(); $('callError').hidden = true;
    try {
      const author = await ensureAuthor();
      const operation = pending || { original: callOriginal, eventId: C.uid(), details, autoStatus };
      if (!pending) {
        operation.patch = C.callPatch(callOriginal, author, new Date().toISOString(), operation.eventId, details);
        const stage = autoStatus ? { 'Zainteresowany': 'Rozmowa', 'Brak zainteresowania': 'Odrzucony' }[details.outcome] : null;
        if (stage && stage !== callOriginal.Etap) operation.patch.Etap = stage;
      }
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
      if (busy || changingSource || fileBusy) throw new Error('Poczekaj na zakończenie zapisu.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Limit importu wynosi 10 MB.');
      const parsed = C.parseCSV(await file.text()); parsed.records.forEach(C.callHistory);
      if (busy || changingSource || fileBusy) throw new Error('Poczekaj na zakończenie zapisu.');
      const plan = C.importPlan(records, parsed.records);
      if (!connected && !rememberedGitHub?.config && !local.sync?.target) {
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
    if (!storageOK || (records.length && local.info?.kind !== 'public-csv') || connected || rememberedGitHub || hasPending() || !/^https?:$/.test(window.location?.protocol || '')) return;
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
    const statusHint = t(connected ? (github ? 'Wspólna baza odświeża się co 3 sekundy.' : 'Zmiany pliku sprawdzane co 3 sekundy.') : 'Połącz CSV, żeby panel i asystent pracowali na tej samej liście.');
    const target = github?.config || rememberedGitHub?.config || local.sync?.target;
    const zones = window.ZoneUI?.status() || {};
    let globalLabel = target ? connected ? 'GitHub · połączono' : 'GitHub · brak połączenia' : connected ? 'Plik CSV' : 'Baza lokalna';
    if (restoringGitHub) globalLabel = 'GitHub · łączenie…';
    if (hasQueued()) globalLabel = syncRunning ? 'GitHub · wysyłanie…' : 'GitHub · oczekuje na zapis';
    if (connectionError || !storageOK) globalLabel = target ? 'GitHub · sprawdź zapis' : 'Baza · sprawdź zapis';
    if (!connectionError && storageOK && (zones.pending || zones.error)) globalLabel = zones.error ? 'Strefy · sprawdź zapis' : zones.running ? 'Strefy · wysyłanie…' : 'Strefy · oczekują na zapis';
    const badge = $('databaseStatus');
    $('databaseStatusLabel').innerHTML = '<span class="status-dot"></span><span>' + esc(t(globalLabel)) + '</span>';
    badge.className = 'database-status' + (connectionError || !storageOK || zones.error ? ' error' : hasQueued() || zones.pending ? ' pending' : connected ? ' connected' : '');
    badge.title = (target ? target.owner + '/' + target.repo + ' · ' + target.branch + ' / ' + target.path + '\n' : '') + I18n.message(connectionError || storageError || (hasQueued() ? 'Zmiany są zachowane w przeglądarce i zostaną wysłane w tle.' : statusHint));
    $('retrySync').hidden = !hasQueued() || syncRunning || restoringGitHub;
    $('retrySync').textContent = t(syncError?.code === 'CONFLICT' ? 'Porównaj zmiany' : 'Ponów zapis');
    $('retrySync').title = $('retrySync').textContent; $('retrySync').setAttribute('aria-label', $('retrySync').textContent);
    if (zones.pending || zones.error) {
      $('saveProgress').hidden = true;
      badge.title += '\n' + t('Strefy') + ': ' + I18n.message(zones.error?.message || (zones.running ? 'Zapisywanie…' : 'Oczekuje na zapis'));
      if (!zones.running) { $('retrySync').hidden = false; $('retrySync').textContent = t(zones.error?.code === 'CONFLICT' ? 'Porównaj strefy' : 'Ponów zapis'); $('retrySync').title = $('retrySync').textContent; $('retrySync').setAttribute('aria-label', $('retrySync').textContent); }
    }
    $('connectGitHub').disabled = syncRunning || githubBusy;
    $('connectButton').innerHTML = icon('link') + esc(t(connected ? 'Połączono' : 'Wspólna baza GitHub'));
    $('disconnectButton').hidden = !fileHandle && !github && !rememberedGitHub;
    $('disconnectButton').textContent = t(github || rememberedGitHub ? 'Rozłącz i zapomnij' : 'Rozłącz plik');
    $('connectionNotice').hidden = !connectionError && storageOK;
    $('connectionNotice').textContent = I18n.message(connectionError || storageError || 'Zapis w przeglądarce jest niedostępny. Połącz CSV lub eksportuj zmiany przed zamknięciem.');
    $('formSaveHint').textContent = I18n.message(target ? '' : connected ? 'Zmiany zapiszą się w klienci.csv.' : 'Zmiany zapiszą się w tej przeglądarce.');
    updateFileInfo();
    document.dispatchEvent(new CustomEvent('crm:connection'));
  }

  function directoryRecords() {
    const reviewed = $('stageFilter').value === '__reviewed';
    return records.filter(record => record.Mapa_status !== 'wykreslona' && (record.Mapa_status === 'przejrzana') === reviewed);
  }
  function filteredRecords() {
    const query = C.norm($('search').value.trim()), stage = $('stageFilter').value;
    const visible = directoryRecords().filter(r => {
      if (hiddenStages.has(r.Etap)) return false;
      if (stage === 'Odrzucony' && r.Etap !== 'Odrzucony') return false;
      if (stage && !['__reviewed', 'Odrzucony'].includes(stage) && r.Etap !== stage) return false;
      if ($('callFilter').value === 'yes' && !r.Dzwoniono || $('callFilter').value === 'no' && r.Dzwoniono) return false;
      if ($('priorityFilter').value && C.priorityValue(r) !== ($('priorityFilter').value === 'none' ? '' : $('priorityFilter').value)) return false;
      if ($('pinFilter').value === 'pinned' && !C.isPinned(r) || $('pinFilter').value === 'unpinned' && C.isPinned(r)) return false;
      if (!query) return true;
      const contact = companyContact(r);
      return C.norm([companyTitle(r).name, r.Branza, r.Miejscowosc, contact.phone, contact.email, contact.url, contact.address, r.Notatki, r['Sprawdzony problem'], r['Nastepny krok'], t(C.industry(r))].join(' ')).includes(query);
    });
    // Sort by the visible names, then return the unchanged canonical records.
    const originals = new Map(visible.map(record => [record.Id, record]));
    return C.sortRecords(visible.map(record => ({ ...record, Firma: companyTitle(record).name })), { ...sorting, locale: I18n.language() }).map(record => originals.get(record.Id));
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
    renderSorting(); connectionUI();
    renderHiddenStages();
    const visible = filteredRecords();
    const total = directoryRecords().length;
    $('resultsLabel').textContent = I18n.message('Wyświetlono ' + visible.length + ' z ' + total + ($('stageFilter').value === '__reviewed' ? ' przejrzanych miejsc' : ' firm'));
    if (!visible.length) {
      showClients('<div class="empty-state"><p>' + esc(t(records.length ? 'Brak firm dla tych filtrów.' : 'Wczytaj CSV, aby wyświetlić firmy.')) + '</p><button class="button primary" data-import-csv>' + esc(t('Wczytaj CSV')) + '</button>' + (records.length ? '<button class="button" data-clear-filters>' + esc(t('Wyczyść filtry')) + '</button>' : '') + '</div>');
    } else renderTable(visible);
    const changed = renderedRows !== records;
    renderedRows = records;
    document.dispatchEvent(new CustomEvent(changed ? 'crm:data' : 'crm:view'));
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

  function companyContact(record) {
    const preview = companyPreview(record);
    const ownURL = C.safeURL(record.Strona), previewURL = C.safeURL(preview?.website);
    return {
      phone: record.Telefon || preview?.phone || '', email: record.Email || '',
      url: ownURL || previewURL, address: record.Adres || preview?.address || '',
      google: !!((!record.Telefon && preview?.phone) || (!ownURL && previewURL))
    };
  }
  function contactHTML(record) {
    const { phone, email, url } = companyContact(record);
    const emailLink = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
      : esc(email);
    const parts = [
      phone ? phoneHTML({ Telefon: phone }) : '',
      email ? `<span>${emailLink}</span>` : '',
      url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.split('/')[2])} ↗</a>` : '',
      !phone && !email && !url ? '—' : '',
    ];
    if (record.Google_place_id && (!record.Telefon || !C.safeURL(record.Strona))) {
      const state = M.storedDetails(record) ? 'ready' : window.GoogleMapSession?.contactState?.(record.Google_place_id);
      if (state !== 'ready') parts.push(state === 'loading' ? '<small class="muted">' + esc(t('Pobieranie kontaktu…')) + '</small>' : '<button type="button" class="text-button contact-load" data-load-contact="' + esc(record.Google_place_id) + '">' + esc(t(state === 'key' ? 'Ustaw klucz Google — kontakt' : state === 'failed' ? 'Ponów pobranie kontaktu' : 'Wczytaj kontakt z mapy')) + '</button>');
    }
    return `<div class="contact-lines">${parts.join('')}</div>`;
  }

  function statusButton(record) {
    return `<button type="button" class="status-trigger" data-status="${esc(record.Id)}" aria-label="${esc(t('Zmień status'))}">
      ${stagePill(record)}<span aria-hidden="true">▾</span>
    </button>`;
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
    return `<div class="status-line">${pinButton(record)}${statusButton(record)}</div>`;
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
    $('priorityCompanyName').textContent = companyTitle(record).name; $('priorityError').hidden = true;
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

  function googleAttribution(record) {
    return '<a class="gmp-attribution" translate="no" href="' + esc(M.placeURL(record.Google_place_id)) + '" target="_blank" rel="noopener noreferrer">Google Maps ↗</a>';
  }
  function companyTitle(record) {
    const pending = record.Google_place_id && (!String(record.Firma || '').trim() || record.Firma === 'Do weryfikacji — ' + record.Google_place_id);
    const preview = pending ? companyPreview(record) : null;
    return { name: pending && !preview?.name && !record.Google_nazwa ? t('Firma z mapy') : C.companyName(record, preview?.name), google: !!(pending && (preview?.name || record.Google_nazwa)) };
  }
  function callButton(record) {
    return `<button class="button call-button" type="button" data-call="${esc(record.Id)}" aria-label="${esc(t('Zapisz rozmowę'))}" title="${esc(t('Zapisz rozmowę'))}">${icon('phone')}</button>`;
  }
  function rejectionContent(record) {
    const clock = C.rejectionClock(record, Date.now());
    if (!clock) return '';
    if (clock.unknown) return esc(t('Data odrzucenia nie została zapisana.'));
    const duration = (days, hours) => days + ' ' + t('dni') + ' ' + hours + ' ' + t('godz.');
    return '<span>' + esc(t('Odrzucono')) + ': ' + esc(dateTime(clock.at)) + '</span><span>' + esc(t('Minęło')) + ': ' + esc(duration(clock.elapsedDays, clock.elapsedHours)) + '</span><strong>' + esc(clock.expired ? t('Minęło 30 dni') : t('Do 30 dni') + ': ' + duration(clock.remainingDays, clock.remainingHours)) + '</strong>';
  }
  function rejectionHTML(record) {
    return record.Etap === 'Odrzucony' ? '<div class="rejection-clock" data-rejected-id="' + esc(record.Id) + '">' + rejectionContent(record) + '</div>' : '';
  }
  function refreshRejectionClocks() {
    if (document.hidden) return;
    document.querySelectorAll('[data-rejected-id]').forEach(element => {
      const record = byId(element.dataset.rejectedId);
      if (record) element.innerHTML = rejectionContent(record);
    });
  }
  function renderTable(items) {
    const rows = items.map(record => {
      const title = companyTitle(record);
      return `
      <tr class="client-row${C.isPinned(record) ? ' pinned-row' : ''}" tabindex="0" data-client="${esc(record.Id)}" aria-label="${esc(t('Otwórz'))} ${esc(title.name)}">
        <td>
          <strong class="firm-name">${esc(title.name)}</strong>
          ${title.google || companyContact(record).google ? googleAttribution(record) : ''}
          <span class="firm-meta">${esc(t(C.industry(record)))} · ${esc(record.Miejscowosc || '')}</span>
          <span class="firm-meta">${esc(t('Dodał'))}: ${esc(record.Dodal || t('Nie zapisano'))}</span>
          <span class="firm-meta">${esc(t('Aktualizacja'))}: ${esc(dateTime(record.Modyfikacja) || '—')}</span>
        </td>
        <td class="status-cell">${statusControls(record)}${rejectionHTML(record)}</td>
        <td class="priority-cell">${priorityControl(record)}</td>
        <td>${contactHTML(record)}</td>
        <td><span class="company-notes" data-content>${esc(record.Notatki || '—')}</span></td>
        <td>
          <div class="call-summary">${callButton(record)}<div class="call-summary-info">${record.Dzwoniono
            ? `${callOutcomeHTML(displayCallHistory(record).at(-1))}<small class="called-label">${esc(dateTime(record.Dzwoniono))}<span class="call-author">${esc(record.Dzwonil || '')}</span></small>`
            : `<small class="muted">${esc(t('Jeszcze nie dzwoniono'))}</small>`}</div></div>
        </td>
      </tr>
    `;
    }).join('');
    showClients(`
      <table class="client-table">
        <thead><tr>
          <th>${esc(t('Firma'))}</th>
          <th>${esc(t('Status'))}</th>
          <th>${esc(t('Priorytet'))}</th>
          <th>${esc(t('Kontakt'))}</th>
          <th>${esc(t('Notatki'))}</th>
          <th>${esc(t('Wykonany telefon'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `);
  }

  function detailBlock(label, value, extra = '', editField = '') {
    return `<section class="detail-block ${extra}">
      <div class="detail-heading"><h3>${esc(t(label))}</h3>${editField ? `<button type="button" class="text-button" data-edit-client data-edit-focus="${esc(editField)}">${esc(t('Edytuj'))}</button>` : ''}</div>
      <p data-content>${esc(value || '—')}</p>
    </section>`;
  }

  function editingCompanyField() {
    const active = document.activeElement;
    return active && $('drawer').contains(active) && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable);
  }
  function openClient(id, preserve = false, resetDraft = false) {
    const record = byId(id); if (!record) return;
    // Background responses must not replace the field being typed into: keep
    // its caret, selection, undo history and composition until focus leaves.
    if (selected === id && preserve && !resetDraft && editingCompanyField()) { deferredCompanyRefresh = id; return; }
    deferredCompanyRefresh = null;
    if (record.Mapa_status === 'wykreslona') { if (selected === id) closeDrawer(true); return; }
    const preview = companyPreview(record);
    const title = companyTitle(record);

    const scroll = selected === id && preserve ? ['.company-grid', '.company-analysis', '.company-actions'].map(selector => [selector, $('drawer').querySelector(selector)?.scrollTop || 0]) : [];
    const same = selected === id, draft = same && preserve && !resetDraft && actionDirty() ? { notes: $('actionNotes').value, consent: $('actionConsent').value, original: actionOriginal } : null;
    if (!selected || !preserve) { browseIds = filteredRecords().map(r => r.Id); returnFocus = document.activeElement; }
    if (!browseIds.includes(id)) browseIds.push(id);
    selected = id; actionOriginal = { ...record };
    const index = browseIds.indexOf(id), sources = (record.Zrodla || record.Strona || '').split(/\s*\|\s*|\n/).map(C.safeURL).filter(Boolean);
    const history = displayCallHistory(record).slice().reverse();
    $('drawer').innerHTML = `
      <div class="company-toolbar${C.isPinned(record) ? ' pinned-toolbar' : ''}">
        <button class="button" data-close-drawer>← ${esc(t('Firmy'))}</button>
        <div class="company-heading">
          <h2 id="drawerTitle" data-content>${esc(title.name)}</h2>
          ${title.google ? googleAttribution(record) : ''}
          <span class="muted">${esc(record.Miejscowosc || '')} · ${esc(record.Branza || '')}</span>
        </div>
        <div class="company-pagination">
          <button class="button" data-navigate="-1" ${index <= 0 ? 'disabled' : ''} aria-label="${esc(t('Poprzednia firma'))}">←</button>
          <span>${index + 1} / ${browseIds.length}</span>
          <button class="button" data-navigate="1" ${index >= browseIds.length - 1 ? 'disabled' : ''} aria-label="${esc(t('Następna firma'))}">→</button>
          <button class="button primary" data-edit-client>${esc(t('Edytuj'))}</button>
          <button type="button" class="button delete-company" data-delete-client="${esc(record.Id)}">${esc(t('Usuń firmę'))}</button>
        </div>
      </div>
      <div class="call-bar">
        <div>${phoneHTML({ Telefon: record.Telefon || preview?.phone || '' }, true)}${!record.Telefon && preview?.phone ? googleAttribution(record) : ''}</div>
        <div class="call-actions">${record.Google_place_id ? `<button class="button" type="button" data-google-preview="${esc(record.Google_place_id)}">${esc(t('Dane Google'))}</button><button class="button" type="button" data-refresh-google="${esc(record.Google_place_id)}"${window.GoogleMapSession?.isRefreshing?.(record.Google_place_id) ? ' disabled' : ''}>${esc(t(window.GoogleMapSession?.isRefreshing?.(record.Google_place_id) ? 'Aktualizowanie danych…' : 'Aktualizuj z Google'))}</button>` : ''}<button class="button" type="button" data-exclude="${esc(id)}">${esc(t(M.state(record) === 'wykreslona' ? 'Przywróć' : 'Wykreśl z mapy'))}</button>${statusControls(record)}${priorityControl(record)}${callButton(record)}</div>
      </div>
      <div class="company-grid">
        <div class="company-analysis">
          ${preview ? `<section class="google-preview">${googleAttribution(record)}<p data-content>${esc(preview.address)}</p>${preview.phone ? phoneHTML({ Telefon: preview.phone }) : ''}${preview.website ? `<a href="${esc(preview.website)}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz stronę'))} ↗</a>` : ''}<p class="muted">${esc(t('Dane z Google Maps — niepotwierdzone w innym źródle'))}</p></section>` : ''}
          ${rejectionHTML(record)}
          <div class="company-contact">
            ${record.Adres ? `<span data-content>${esc(record.Adres)}</span>` : ''}
            ${record.Strona && C.safeURL(record.Strona) ? `<a href="${esc(C.safeURL(record.Strona))}" target="_blank" rel="noopener noreferrer">${esc(t('Otwórz stronę'))} ↗</a>` : ''}
            ${record.Email ? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.Email) ? `<a href="mailto:${esc(record.Email)}">${esc(record.Email)}</a>` : `<span>${esc(record.Email)}</span>`) : ''}
            <span class="muted">${esc(t('Dodał'))}: ${esc(record.Dodal || t('Nie zapisano'))}${record.Dodano ? ' · ' + esc(dateTime(record.Dodano)) : ''}</span>
            <span class="muted">${esc(t('Ostatnia edycja firmy'))}: ${esc(record.Modyfikacja ? dateTime(record.Modyfikacja) : '—')}${record.Edytowal ? ' · ' + esc(record.Edytowal) : ''}</span>
          </div>
          <div class="analysis-grid">
            <section class="detail-block wide next-step-block">
              <div class="detail-heading"><h3>${esc(t('Następny krok'))}</h3><button type="button" class="text-button" data-edit-client data-edit-focus="next">${esc(t('Edytuj'))}</button></div>
              <p id="nextStepDisplay" data-content>${esc(record['Nastepny krok'] || '—')}</p>
              ${record.Termin ? `<small class="next-step-date">${esc(t('Termin działania'))}: ${esc(prettyDate(record.Termin))}</small>` : ''}
            </section>
            ${detailBlock('Co zauważyliśmy', record['Sprawdzony problem'], '', 'issue')}
            ${detailBlock('Argument do rozmowy', record['Argument do rozmowy'], '', 'argument')}
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
    if (draft) { $('actionNotes').value = draft.notes; $('actionConsent').value = draft.consent; actionOriginal = draft.original; }
    for (const [selector, position] of scroll) { const element = $('drawer').querySelector(selector); if (element) element.scrollTop = position; }
    I18n.bindUI($('drawer'));
    if (!preserve) $('drawer').querySelector('[data-close-drawer]').focus();
    document.dispatchEvent(new CustomEvent('crm:view'));
  }
  function actionDirty() {
    return selected && !$('drawer').hidden && actionOriginal && ['actionNotes', 'actionConsent'].some((id, index) => $(id).value !== (actionOriginal[['Notatki', 'Zgoda data i zakres'][index]] || ''));
  }
  async function confirmLeavingActions() {
    if (!actionDirty()) return true;
    const id = selected;
    const draft = JSON.stringify([$('actionNotes').value, $('actionConsent').value]);
    const approved = await ask('Masz niezapisane działania lub notatki. Opuścić je bez zapisywania?', { title: 'Niezapisane zmiany', accept: 'Porzuć zmiany', danger: true });
    return approved && selected === id && draft === JSON.stringify([$('actionNotes').value, $('actionConsent').value]);
  }
  async function closeDrawer(force = false) {
    if (!force && !await confirmLeavingActions()) return false;
    deferredCompanyRefresh = null;
    $('drawer').hidden = true; $('companiesPanel').inert = false; $('companiesPanel').removeAttribute('aria-hidden'); selected = null; browseIds = [];
    document.dispatchEvent(new CustomEvent('crm:view'));
    if (returnFocus?.isConnected) returnFocus.focus(); return true;
  }
  async function navigateCompany(direction) {
    if (busy || !await confirmLeavingActions()) return;
    const index = browseIds.indexOf(selected), id = browseIds[index + direction]; if (id && byId(id)) openClient(id, true);
  }
  const stageDescriptions = { Nowy: 'Nowa firma w bazie', 'Do sprawdzenia': 'Dane wymagają sprawdzenia', Rozmowa: 'Kontakt z firmą w toku', 'W realizacji': 'Trwa realizacja', 'Współpraca': 'Współpracujemy z firmą', Odrzucony: 'Firma odrzuciła współpracę', Archiwum: 'Ukryj z głównej listy' };
  function renderStatusOptions(record) {
    $('statusOptions').innerHTML = C.stages.map(stage => '<label class="status-option"><input type="radio" name="stage" value="' + esc(stage) + '"' + (stage === record.Etap ? ' checked' : '') + '><span><strong>' + esc(t(stage)) + '</strong><small>' + esc(t(stageDescriptions[stage])) + '</small></span></label>').join('');
    I18n.bindUI($('statusDialog'));
  }
  function openStatus(id) {
    const record = byId(id); if (!record || busy || statusSaving || !requireProfile()) return; statusOriginal = { ...record };
    $('statusCompanyName').textContent = companyTitle(record).name; $('statusError').hidden = true;
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
    ['address', 'Adres', 'text', '', true],
    ['stage', 'Etap współpracy', 'stage'], ['priority', 'Priorytet', 'priority'],
    ['next', 'Następny krok', 'textarea', 'Co konkretnie warto zrobić?', true], ['due', 'Termin działania', 'date'], ['price', 'Ustalona wycena', 'text', 'Uzupełnij po przygotowaniu oferty'],
    ['issue', 'Co zauważyliśmy', 'textarea', 'Tylko sprawdzone obserwacje; zaznacz niepewność.', true],
    ['argument', 'Argument do rozmowy', 'textarea', 'Dlaczego ta zmiana może pomóc firmie?', true],
    ['sources', 'Źródła', 'textarea', 'Adresy stron oddziel pionową kreską | lub nową linią.', true],
    ['checked', 'Data sprawdzenia źródeł', 'date'], ['scope', 'Zakres weryfikacji', 'textarea', 'Co sprawdzono, a co wymaga potwierdzenia?', true],
    ['notes', 'Twoje notatki', 'textarea', 'Dodatkowe informacje i ustalenia', true],
    ['consent', 'Uzgodniony kontakt — data i zakres', 'textarea', '', true]
  ];
  async function openForm(record = null, focusField = '') {
    if (formSaving || !requireProfile() || (!record && selected && !await confirmLeavingActions())) return;
    const working = record ? { ...record } : null;
    formInitialName = record ? companyTitle(record).name : '';
    editOriginal = record ? { ...record } : null; draftId = record?.Id || C.uid();
    // Carry quick notes into the full editor without changing their conflict baseline.
    if (record && selected === record.Id && actionOriginal) for (const [id, key] of [['actionNotes', 'Notatki'], ['actionConsent', 'Zgoda data i zakres']]) {
      if ($(id).value !== (actionOriginal[key] || '')) { working[key] = $(id).value; editOriginal[key] = actionOriginal[key] || ''; }
    }
    $('editDialog').classList.toggle('company-edit-mode', !!record);
    $('formTitle').textContent = I18n.message(record ? 'Edytuj dane firmy' : 'Dodaj nową firmę');
    $('formCompanyName').textContent = record ? companyTitle(record).name : ''; $('formCompanyName').hidden = !record;
    $('submitForm').innerHTML = esc(t(record ? 'Zapisz zmiany' : 'Dodaj klienta')) + icon(record ? 'check' : 'plus');
    $('formFields').disabled = false;
    $('formError').hidden = true;
    const basic = ['name', 'url', 'city', 'phone', 'email', 'stage', 'priority', 'notes'];
    const ordered = [...formSchema.filter(row => basic.includes(row[0])), ...formSchema.filter(row => !basic.includes(row[0]))];
    const fieldHTML = ([key, label, type, placeholder, full]) => {
      const value = working ? key === 'name' ? companyTitle(working).name : val(working, key) : key === 'stage' ? 'Nowy' : '';
      const googleValue = record ? companyPreview(record)?.[({ phone: 'phone', url: 'website', address: 'address' })[key]] : '';
      if (googleValue && !value) placeholder = googleValue;
      if (type === 'stage' || type === 'priority') {
        const selectedValue = type === 'priority' ? (record ? C.priorityValue(record) : '') : value;
        const options = type === 'stage' ? C.stages.map(stage => ({ value: stage, label: stage })) : [...C.priorities, { value: '', label: 'Nie ustawiono' }];
        return '<fieldset class="form-field full form-choice-field" id="f-' + key + '"><legend>' + esc(t(label)) + '</legend><div class="form-choices">' + options.map((item, index) => '<label class="form-choice" for="f-' + key + '-' + index + '"' + (item.description ? ' title="' + esc(t(item.description)) + '"' : '') + '><input type="radio" id="f-' + key + '-' + index + '" name="' + key + '" value="' + esc(item.value) + '"' + (item.value === selectedValue ? ' checked' : '') + '><span>' + esc(t(item.label)) + '</span></label>').join('') + '</div></fieldset>';
      }
      let input;
      if (type === 'textarea') input = '<textarea name="' + key + '" id="f-' + key + '" rows="' + (key === 'notes' ? '6' : key === 'issue' ? '5' : '3') + '" placeholder="' + esc(t(placeholder || '')) + '" maxlength="30000">' + esc(value) + '</textarea>';
      else input = '<input id="f-' + key + '" name="' + key + '" type="' + type + '" value="' + esc(value) + '" placeholder="' + esc(t(placeholder || '')) + '"' + (key === 'name' ? ' required maxlength="250"' : ' maxlength="5000"') + '>';
      return '<div class="form-field' + (full ? ' full' : '') + '"><label for="f-' + key + '">' + esc(t(label)) + '</label>' + input + '</div>';
    };
    if (record) {
      const section = (title, keys, extra = '') => '<section class="company-edit-section ' + extra + '"><h3>' + esc(t(title)) + '</h3>' + (title === 'Dane firmy' && record.Google_place_id ? '<p class="company-edit-source">' + googleAttribution(record) + '<br>' + esc(t('Puste pola kontaktu korzystają z danych Google.')) + '</p>' : '') + '<div class="form-grid">' + keys.map(key => fieldHTML(formSchema.find(row => row[0] === key))).join('') + '</div></section>';
      $('formFields').innerHTML = '<div class="company-edit-layout">' +
        section('Plan i notatki', ['next', 'due', 'price', 'issue', 'argument', 'notes', 'consent'], 'company-edit-plan') +
        section('Dane firmy', ['name', 'url', 'phone', 'email', 'address', 'city', 'industry', 'stage', 'priority'], 'company-edit-contact') +
        section('Źródła i sprawdzenie', ['sources', 'checked', 'scope'], 'company-edit-sources') + '</div>';
    } else $('formFields').innerHTML = '<div class="form-grid">' + ordered.map(row => (row[0] === 'industry' ? '</div><details class="advanced-fields"><summary>' + esc(t('Więcej informacji (opcjonalnie)')) + '</summary><div class="form-grid">' : '') + fieldHTML(row)).join('') + '</div></details>';
    I18n.bindUI($('editDialog')); $('editDialog').showModal(); $('f-' + (record ? (F[focusField] && formSchema.some(row => row[0] === focusField) ? focusField : 'next') : 'name')).focus();
  }
  function changedFields(record, form) {
    const patch = {};
    for (const [name] of formSchema) {
      const value = String(form.get(name) || '').trim(); const key = F[name];
      if (name === 'name' && record && value === formInitialName) continue;
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
    const stage = newRecord?.Etap || patch.Etap;
    const selection = stage === 'Odrzucony' && original?.Etap !== 'Odrzucony' ? { Odrzucono: at } : {};
    const update = { ...selection, ...patch, Modyfikacja: at, Edytowal: author };
    if (update.Etap) update.Status = 'Etap: ' + update.Etap + ' — ustawiono przez ' + author;
    const added = newRecord ? [{ ...newRecord, ...selection, Etap: newRecord.Etap, Dodal: author, Dodano: at, Modyfikacja: at, Edytowal: author }] : [];
    await commitBatch(original ? [{ ...original }] : [], newRecord ? {} : { [id]: update }, added, author, at);
  }
  async function deleteCompany(id) {
    if (!requireProfile() || deletionsInProgress.has(id)) return;
    if (typeof C.retainedMapDecision !== 'function' || github && github.removalVersion !== 1) { toast('Odśwież panel przez Ctrl+Shift+R przed usuwaniem firmy.', true); return; }
    if (busy || changingSource || fileBusy) { toast('Poczekaj na zakończenie poprzedniego zapisu.', true); return; }
    const record = byId(id); if (!record) return;
    const original = { ...record };
    if (selected === id && actionOriginal && !C.sameCompany(actionOriginal, original)) { toast('Dane firmy zmieniły się. Otwórz ponownie kartę przed usunięciem.', true); return; }
    const batch = local.sync?.inflight;
    const inFlight = batch ? C.overlay(batch.base, batch.patches, batch.added, batch.removed).find(row => row.Id === id) : null;
    const versions = [original, base.find(row => row.Id === id), inFlight].filter(Boolean).map(row => ({ ...row }));
    const retained = C.retainedMapDecision(original);
    const decisionTarget = targetKey(github?.config || rememberedGitHub?.config || local.sync?.target);
    const message = t('Usunąć firmę na stałe?') + '\n\n' + companyTitle(original).name + '\n\n' + t(retained ? 'Usuniemy dane firmy, notatki i rozmowy. Zachowamy wyłącznie oznaczenie wykreślenia na mapie oraz jego historię. Dotyczy to obu osób.' : 'Z bieżącej bazy znikną wszystkie dane tej firmy, notatki i historia rozmów. Dotyczy to także drugiej osoby korzystającej z tej samej bazy.') + '\n\n' + t('Wcześniejsze wersje pliku pozostają w historii GitHuba.');
    if (!await ask(message, { title: retained ? 'Usuń dane firmy' : 'Usuń firmę', accept: retained ? 'Usuń dane firmy' : 'Usuń firmę', danger: true, key: 'delete-company:' + id })) return;
    if (deletionsInProgress.has(id)) return;
    if (decisionTarget !== targetKey(github?.config || rememberedGitHub?.config || local.sync?.target)) { toast('Baza zmieniła się. Sprawdź firmę i potwierdź usunięcie ponownie.', true); return; }
    deletionsInProgress.add(id);
    try {
      const author = await ensureAuthor(), at = new Date().toISOString();
      const target = github?.config || rememberedGitHub?.config || local.sync?.target;
      if (rememberedGitHub && !target) throw new Error('Najpierw połącz zapamiętaną bazę w ustawieniach GitHuba lub wybierz Rozłącz i zapomnij.');
      if (target || !connected || !fileHandle) {
        await writeLocal(async () => {
          if (!byId(id) || !C.sameCompany(original, byId(id))) throw new Error('Dane firmy zmieniły się. Otwórz ponownie kartę przed usunięciem.');
          if (target && hasQueued() && !sameTarget(target, local.sync.target)) throw new Error('Najpierw wyślij oczekujące zmiany do poprzedniej bazy.');
          busy = true;
          try {
            const patches = { ...local.patches }; delete patches[id];
            const added = local.added.filter(row => row.Id !== id);
            const removed = target ? { ...local.removed, [id]: versions } : {};
            const nextBase = target ? base : C.overlay(base, {}, [], { [id]: versions });
            const next = { ...local, patches, added, removed, imported: nextBase, meta: { at, by: author },
              sync: target ? { ...local.sync, target: { ...target }, author } : null };
            await persist(next, true); local = next; base = nextBase;
            records = C.overlay(base, local.patches, local.added, local.removed);
          } finally { busy = false; connectionUI(); }
        });
      } else {
        busy = true;
        try {
          await trackSave('file', async () => {
            const text = await (await fileHandle.getFile()).text(), latest = C.parseCSV(text);
            const result = C.merge([original], latest.records, {}, [], { [id]: versions });
            if (result.conflicts.length) throw new Error('Nie usunięto firmy, bo druga osoba zmieniła jej dane. Otwórz ponownie kartę.');
            await writeRecords(C.stampFile(result.records, at, author), latest.headers, text);
          });
        } finally { busy = false; connectionUI(); }
      }
      pendingCalls.delete(id); if (selected === id) closeDrawer(true);
      render(); kickSync(); toast('Usunięto firmę z listy.');
    } catch (error) { toast(error.message, true); }
    finally { deletionsInProgress.delete(id); }
  }
  async function submitForm(event) {
    event.preventDefault();
    if (formSaving) return;
    const original = editOriginal;
    const form = new FormData($('clientForm')); const patch = changedFields(editOriginal, form);
    if (!String(form.get('name') || '').trim()) { $('formError').textContent = I18n.message('Podaj nazwę firmy.'); $('formError').hidden = false; return; }
    if (form.get('url') && !C.safeURL(form.get('url'))) { $('formError').textContent = I18n.message('Podaj pełny adres strony zaczynający się od https:// lub http://.'); $('formError').hidden = false; return; }
    formSaving = true; $('formFields').disabled = true; $('submitForm').disabled = true; $('cancelForm').disabled = true; $('closeForm').disabled = true;
    try {
      let id = editOriginal?.Id || draftId;
      if (!editOriginal) {
        const duplicate = records.find(r => C.norm(r.Firma.trim()) === C.norm(String(form.get('name')).trim()) && r.Etap !== 'Archiwum');
        if (duplicate) throw new Error('Taka firma jest już w bazie. Otwórz jej kartę, żeby uzupełnić informacje.');
        const record = Object.fromEntries(headers.map(k => [k, '']));
        Object.assign(record, patch, { Id: id, Status: 'Potencjalny klient — zainteresowanie niepotwierdzone' });
        await saveChange(id, {}, null, record);
      } else await saveChange(id, patch, editOriginal);
      $('editDialog').close(); toast(original ? 'Zapisano zmiany w danych firmy.' : 'Nowy klient jest już na liście.');
      openClient(id, true, true);
      $('drawer').querySelector('[data-edit-client]')?.focus();
    } catch (error) { $('formError').textContent = I18n.message(error.message); $('formError').hidden = false; }
    finally { formSaving = false; $('formFields').disabled = false; $('submitForm').disabled = false; $('cancelForm').disabled = false; $('closeForm').disabled = false; }
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
      if (!handle || github || hasQueued()) return;
      fileHandle = handle;
      if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted' && !hasPending()) await establishConnection(handle);
      else connectionUI();
    } catch { /* Przeglądarka może wymagać ponownego wybrania pliku. */ }
  }
  async function establishConnection(handle) {
    if (busy || githubBusy || fileBusy) throw new Error('Trwa poprzedni zapis. Spróbuj ponownie za chwilę.');
    if (github || rememberedGitHub || hasQueued()) throw new Error('Najpierw wyślij oczekujące zmiany i rozłącz GitHub, żeby wybrać plik na komputerze.');
    const previous = records;
    const file = await handle.getFile(), text = await file.text(), parsed = C.parseCSV(text);
    parsed.records.forEach(C.callHistory);
    if (records !== previous || busy || githubBusy || fileBusy || github) throw new Error('Dane zmieniły się podczas łączenia. Spróbuj ponownie.');
    if (hasPending()) {
      const outcome = C.merge(base, parsed.records, local.patches, local.added);
      if (outcome.conflicts.length) {
        throw new Error('Plik i panel mają różne zmiany tych samych danych: ' + outcome.conflicts.slice(0, 4).map(c => c.name + ' / ' + c.field).join('; ') + '. Najpierw wyeksportuj wersję z panelu. Nie zmieniono pliku.');
      }
      const permission = await ask('Masz zmiany zapisane w tej przeglądarce. Przenieść je do wybranego CSV? Pozostałe dane z pliku zostaną zachowane. Anuluj, żeby najpierw wyeksportować kopię.', { title: 'Połączenie zmian', accept: 'Przenieś zmiany' });
      if (!permission) return false;
      if (records !== previous || busy || githubBusy || fileBusy || github) throw new Error('Dane zmieniły się podczas łączenia. Spróbuj ponownie.');
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
    $('connectError').textContent = I18n.message(connectionError || storageError || '');
    $('connectError').hidden = !connectionError && !storageError;
    $('ghDataMode').value = 'remote'; updateGitHubModeHint();
    $('chooseCSV').textContent = I18n.message(fileHandle && !connected ? 'Połącz ponownie z plikiem' : 'Wybierz klienci.csv');
    try { const config = JSON.parse(localStorage.getItem('pracownia.github.config') || 'null'); if (config) { $('ghRepo').value = config.owner + '/' + config.repo; $('ghBranch').value = config.branch; $('ghPath').value = config.path; } } catch {}
    const config = github?.config || rememberedGitHub?.config || local.sync?.target;
    if (config) { $('ghRepo').value = config.owner + '/' + config.repo; $('ghBranch').value = config.branch; $('ghPath').value = config.path; }
    $('ghToken').value = github?.token || rememberedGitHub?.token || '';
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
    try { localStorage.removeItem(GITHUB_SESSION_STORE); localStorage.removeItem('pracownia.github.config'); }
    catch { toast('Nie udało się usunąć zapamiętanego połączenia. Sprawdź ustawienia przeglądarki.', true); return; }
    rememberedGitHub = null; restoreRetryAt = 0; clearTimeout(syncRetryTimer); syncRetryTimer = null; syncError = null;
    connected = false; fileHandle = null; connectionError = ''; fileText = null;
    if (github) { github.close(); github = null; } $('ghToken').value = '';
    await writeLocal(async () => {
      if (!hasQueued()) {
        local = { patches: {}, added: [], imported: records.map(r => ({ ...r })), meta: C.fileMeta(records), info: local.info }; base = [...records]; await persist();
      }
    });
    try { const db = await fileDB(); const tx = db.transaction('handles', 'readwrite'); tx.objectStore('handles').delete('csv'); tx.oncomplete = () => db.close(); } catch {}
    $('connectDialog').close(); render(); toast('Rozłączono plik. Bieżąca lista zostaje w przeglądarce.');
  }
  async function pollFile() {
    refreshRejectionClocks();
    if (!connected && rememberedGitHub && restoreRetryAt && Date.now() >= restoreRetryAt && !githubBusy && !document.hidden) { await restoreGitHub(); return; }
    if (!connected || busy || githubBusy || fileBusy || document.hidden) return;
    if (github) {
      if (github.retryAt > Date.now()) return;
      if (hasQueued() || syncRunning) { kickSync(); return; }
      if (Date.now() - lastGitHubPoll < 3000) return;
      githubBusy = true; lastGitHubPoll = Date.now(); const session = github;
      try { const result = await session.read(); if (github !== session || !connected) return;
        await writeLocal(async () => {
          if (hasQueued() || github !== session || !connected) return;
          if (result.sha !== local.info?.sha) { await adoptShared(result, { sha: result.sha }); render(); if (selected && !actionDirty() && !$('editDialog').open) { if (byId(selected)) openClient(selected, true); else closeDrawer(true); } }
          connectionError = '';
        }); connectionUI();
      }
      catch (error) { connectionError = error.code === 'RATE_LIMIT' ? error.message : 'Nie odświeżono wspólnej bazy. Ostatnia kopia zostaje widoczna; kolejna próba za 3 s.'; connectionUI(); }
      finally { githubBusy = false; kickSync(); } return;
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
    if (existing && local.removed?.[existing.Id] && value === 'dodana') throw new Error('Dane tej firmy są właśnie usuwane. Przywróć ją po zakończeniu zapisu.');
    if (existing?.Google_place_id && value === 'przejrzana' && (M.state(existing) !== 'przejrzana' || existing.Mapa_potwierdzono)) return existing;
    const patch = { ...M.decision(existing, value, author, reason), Google_place_id: entity.id };
    if (existing && C.isMapDecisionOnly(existing) && value === 'dodana') Object.assign(patch, M.detailsPatch(entity), { Etap: 'Nowy' });
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
      saveChange(id, M.decision(record, 'dodana', authorName), { ...record })
        .then(() => { if (selected === id) openClient(id, true); }).catch(error => toast(error.message, true));
      return;
    }
    excludeOriginal = { ...record }; $('excludeName').textContent = companyTitle(record).name;
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
    zoneContext: () => {
      const config = github?.config || rememberedGitHub?.config || local.sync?.target;
      const session = connected ? github : null;
      return { target: config ? { owner: config.owner, repo: config.repo, branch: config.branch, path: config.path.replace(/[^/]+$/, 'strefy.geojson') } : null,
        session, request: session ? (path, options) => session.request(path, options) : null };
    },
    refreshConnection: connectionUI,
    notify: toast,
    records: () => records.map(record => ({ ...record })), profile: () => authorName,
    findPlace: entity => { const row = M.matchRecord(entity, records, recordIndex()); return row ? { ...row } : null; },
    placeRecord: id => { const row = recordIndex().places.get(id); return row ? { ...row } : null; },
    visibleRecords: () => $('companiesPanel').hidden ? [] : (selected && !$('drawer').hidden ? [byId(selected)].filter(Boolean) : filteredRecords()).map(record => ({ ...record })),
    decidePlace,
    remove: deleteCompany,
    savePlaceDetails: (entity, { refresh = false } = {}) => {
      const task = placeDetailsChain.then(async () => {
        const original = records.find(record => record.Google_place_id === entity.id);
        if (!original || C.isMapDecisionOnly(original) || !['T','K'].includes(authorName) || !refresh && M.storedDetails(original)) return;
        await saveChange(original.Id, M.detailsPatch(entity), { ...original });
      });
      placeDetailsChain = task.catch(error => { connectionError = I18n.message(error.message); connectionUI(); });
      return refresh ? task : placeDetailsChain;
    },
    open: id => { if (!byId(id) || byId(id).Mapa_status === 'wykreslona') return false; return window.PanelUI.showTab('companies').then(allowed => { if (!allowed || !byId(id)) return false; openClient(id); return true; }); },
  };
  $('stageFilter').innerHTML += C.stages.map(stage => '<option value="' + esc(stage) + '">' + esc(t(stage)) + '</option>').join('') + '<option value="__reviewed">' + esc(t('Przejrzane na mapie')) + '</option>';
  function rememberHiddenStages() { try { localStorage.setItem(HIDDEN_STAGES_STORE, JSON.stringify([...hiddenStages])); } catch {} }
  function renderHiddenStages() {
    const focused = document.activeElement?.dataset?.hideStage;
    $('hiddenStageSummary').textContent = t('Ukryj statusy') + (hiddenStages.size ? ' · ' + hiddenStages.size : '');
    $('hiddenStageOptions').innerHTML = C.stages.map(stage => '<label class="hidden-stage-option"><input type="checkbox" data-hide-stage="' + esc(stage) + '"' + (hiddenStages.has(stage) ? ' checked' : '') + '><span>' + esc(t(stage)) + '</span></label>').join('');
    if (focused && C.stages.includes(focused)) $('hiddenStageOptions').querySelector('[data-hide-stage="' + focused + '"]')?.focus();
  }
  $('hiddenStageOptions').addEventListener('change', event => {
    const stage = event.target.dataset?.hideStage; if (!C.stages.includes(stage)) return;
    if (event.target.checked) { hiddenStages.add(stage); if ($('stageFilter').value === stage) $('stageFilter').value = ''; }
    else hiddenStages.delete(stage);
    rememberHiddenStages(); render();
  });
  $('showAllStages').onclick = () => { hiddenStages.clear(); rememberHiddenStages(); render(); };
  for (const id of ['search', 'stageFilter', 'callFilter', 'priorityFilter', 'pinFilter']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
    if (id === 'stageFilter' && hiddenStages.delete($('stageFilter').value)) rememberHiddenStages();
    render();
  });
  for (const id of ['sortField', 'sortDirection']) $(id).addEventListener('change', () => {
    if (id === 'sortField') {
      const field = $('sortField').value;
      if (!Object.hasOwn(C.sortFields, field)) return;
      sorting = { field, direction: ['updated', 'added', 'called'].includes(field) ? 'desc' : 'asc' };
    } else {
      if (!['asc', 'desc'].includes($('sortDirection').value)) return;
      sorting.direction = $('sortDirection').value;
    }
    try { localStorage.setItem(SORT_STORE, JSON.stringify({ ...sorting, version: SORT_VERSION })); } catch {}
    render();
  });
  $('addClient').onclick = () => openForm();
  $('clientsContent').addEventListener('click', event => {
    const contact = event.target.closest('[data-load-contact]');
    if (contact) { window.GoogleMapSession?.loadContact?.(contact.dataset.loadContact); return; }
    const pin = event.target.closest('[data-pin]'); if (pin) return togglePin(pin);
    const priority = event.target.closest('[data-priority]'); if (priority) { openPriority(priority.dataset.priority); return; }
    const status = event.target.closest('[data-status]'); if (status) { openStatus(status.dataset.status); return; }
    const call = event.target.closest('[data-call]'); if (call) { registerPhone(call.dataset.call); return; }
    if (event.target.closest('a[href]')) return;
    const item = event.target.closest('[data-client]'); if (item) { openClient(item.dataset.client); return; }
    if (event.target.closest('[data-import-csv]')) $('importButton').click();
    if (event.target.closest('[data-clear-filters]')) { for (const id of ['search', 'stageFilter', 'callFilter', 'priorityFilter', 'pinFilter']) $(id).value = ''; hiddenStages.clear(); rememberHiddenStages(); render(); }
  });
  let menuCompanyId = null, menuCompanyRow = null;
  function closeCompanyMenu(restoreFocus = false) {
    $('companyMenu').hidden = true; menuCompanyId = null;
    if (restoreFocus && menuCompanyRow?.isConnected) menuCompanyRow.focus();
    menuCompanyRow = null;
  }
  function showCompanyMenu(row, x, y) {
    const record = byId(row.dataset.client);
    if (!record || record.Mapa_status === 'wykreslona') return;
    window.PanelUI?.closeMenus();
    menuCompanyId = record.Id; menuCompanyRow = row;
    const menu = $('companyMenu'); $('companyMenuName').textContent = companyTitle(record).name;
    menu.hidden = false;
    const width = window.innerWidth || document.documentElement.clientWidth || 1024;
    const height = window.innerHeight || document.documentElement.clientHeight || 768;
    menu.style.left = Math.max(8, Math.min(x, width - (menu.offsetWidth || 240) - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, height - (menu.offsetHeight || 240) - 8)) + 'px';
    $('companyMenu').querySelector('button')?.focus();
  }
  $('clientsContent').addEventListener('contextmenu', event => {
    const row = event.target.closest('tr[data-client]');
    if (!row) return;
    event.preventDefault(); showCompanyMenu(row, event.clientX, event.clientY);
  });
  $('clientsContent').addEventListener('keydown', event => {
    if (event.target.closest('button,a,input,select')) return;
    const row = event.target.closest('tr[data-client]'); if (!row) return;
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault(); const rect = row.getBoundingClientRect(); showCompanyMenu(row, rect.left + 20, rect.top + 20);
    } else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); openClient(row.dataset.client); }
  });
  $('companyMenu').addEventListener('click', async event => {
    const button = event.target.closest('[data-company-action]'); if (!button || !menuCompanyId) return;
    const id = menuCompanyId; closeCompanyMenu();
    if (!byId(id) || byId(id).Mapa_status === 'wykreslona') return;
    if (button.dataset.companyAction === 'open') openClient(id);
    if (button.dataset.companyAction === 'status') openStatus(id);
    if (button.dataset.companyAction === 'priority') openPriority(id);
    if (button.dataset.companyAction === 'exclude') openExclude(id);
    if (button.dataset.companyAction === 'delete') await deleteCompany(id);
  });
  $('companyMenu').addEventListener('keydown', event => {
    const buttons = [...$('companyMenu').querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) {
      event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (!$('companyMenu').hidden && !$('companyMenu').contains(event.target)) closeCompanyMenu(); }, true);
  document.addEventListener('focusin', event => { if (!$('companyMenu').hidden && !$('companyMenu').contains(event.target)) closeCompanyMenu(); }, true);
  document.addEventListener('crm:menu-open', () => closeCompanyMenu());
  document.addEventListener('keydown', event => {
    if ($('companyMenu').hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCompanyMenu(true); }
    if (event.key === 'Tab') closeCompanyMenu();
  });
  document.addEventListener('scroll', () => closeCompanyMenu(), true);
  document.addEventListener('crm:tab', () => closeCompanyMenu());
  window.addEventListener('resize', () => closeCompanyMenu());
  $('drawer').addEventListener('focusout', () => {
    Promise.resolve().then(() => {
      const id = deferredCompanyRefresh;
      if (id && selected === id && !$('drawer').hidden && !editingCompanyField()) openClient(id, true);
    });
  });
  $('drawer').addEventListener('click', async event => {
    const refresh = event.target.closest('[data-refresh-google]');
    if (refresh) {
      if (!requireProfile() || window.GoogleMapSession?.isRefreshing?.(refresh.dataset.refreshGoogle)) return;
      if (typeof window.GoogleMapSession?.refresh !== 'function') { toast('Odśwież panel przez Ctrl+Shift+R, aby zaktualizować dane Google.', true); return; }
      refresh.disabled = true;
      try {
        const updated = await window.GoogleMapSession?.refresh?.(refresh.dataset.refreshGoogle);
        if (updated) toast('Odświeżono dane Google. Własne dane firmy mają pierwszeństwo.');
      } catch (error) { toast(error.message, true); }
      finally { refresh.disabled = false; }
      return;
    }
    const remove = event.target.closest('[data-delete-client]'); if (remove) { await deleteCompany(remove.dataset.deleteClient); return; }
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
    if (event.target.closest('[data-close-drawer]')) { await closeDrawer(); return; }
    const edit = event.target.closest('[data-edit-client]'); if (edit) { await openForm(byId(selected), edit.dataset.editFocus || ''); return; }
    const navigation = event.target.closest('[data-navigate]'); if (navigation) { await navigateCompany(Number(navigation.dataset.navigate)); return; }
    if (event.target.closest('#saveActions')) {
      const button = $('saveActions'), id = selected; button.disabled = true;
      const patch = {}, mapping = { actionNotes: 'Notatki', actionConsent: 'Zgoda data i zakres' };
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
      catch (error) { toast(error.message, true); button.disabled = false; $('saveActions').disabled = false; }
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
  $('callAutoStatus').addEventListener('change', () => {
    if (callSaving || callOriginal && pendingCalls.has(callOriginal.Id)) return;
    callAutoStatus = $('callAutoStatus').checked;
    try { localStorage.setItem(CALL_AUTO_STATUS_STORE, String(callAutoStatus)); }
    catch { toast('Ustawienie działa teraz, ale przeglądarka nie pozwoliła zapamiętać go na później.', true); }
  });
  $('closeCall').onclick = closeCall; $('cancelCall').onclick = closeCall;
  $('callDialog').addEventListener('cancel', event => { event.preventDefault(); return closeCall(); });
  $('callDialog').addEventListener('close', () => { callOriginal = null; });
  document.addEventListener('crm:beforetab', event => { if (busy || changingSource) { event.preventDefault(); return; } if (selected) { event.detail.guard(confirmLeavingActions); event.detail.commit(() => closeDrawer(true)); } });
  $('clientForm').addEventListener('submit', submitForm);
  async function closeForm() {
    if (formSaving) return;
    const original = editOriginal;
    const changed = Object.keys(changedFields(editOriginal, new FormData($('clientForm')))).length;
    const meaningful = editOriginal ? changed : [...new FormData($('clientForm'))].some(([key, value]) => !['stage', 'priority'].includes(key) && value.trim());
    if (meaningful && !await ask('Zamknąć formularz bez zapisywania zmian?', { title: 'Niezapisane zmiany', accept: 'Porzuć zmiany', danger: true })) return;
    if (formSaving || editOriginal !== original) return;
    $('editDialog').close(); editOriginal = null;
  }
  $('closeForm').onclick = closeForm; $('cancelForm').onclick = closeForm;
  $('editDialog').addEventListener('cancel', event => { event.preventDefault(); return closeForm(); });
  $('editDialog').addEventListener('close', () => { editOriginal = null; });
  $('connectButton').onclick = openConnection;
  $('databaseStatus').onclick = openConnection;
  $('retrySync').onclick = async () => {
    const zones = window.ZoneUI?.status();
    if (zones?.error?.code !== 'RATE_LIMIT' && [401,403,404].includes(zones?.error?.status)) { openConnection(); return; }
    if (zones?.pending || zones?.error) { window.ZoneUI.retry(); return; }
    if (!github || !connected || syncError?.code !== 'RATE_LIMIT' && [401,403,404].includes(syncError?.status)) { openConnection(); return; }
    const deleted = (syncError?.conflicts || []).filter(conflict => conflict.field === 'Usunięty w pliku');
    if (deleted.length) {
      const message = t('Te firmy zostały usunięte ze wspólnej bazy:') + '\n\n' + deleted.map(conflict => conflict.name).join('\n') + '\n\n' + t('Odrzucić ich oczekujące zmiany w tej przeglądarce? Anuluj zachowa lokalną kopię. Możesz ją wcześniej wyeksportować do CSV.');
      if (!await ask(message, { title: 'Oczekujące zmiany usuniętych firm', accept: 'Odrzuć lokalne zmiany', danger: true })) return;
      try {
        const ids = new Set(deleted.map(conflict => conflict.id));
        await writeLocal(async () => {
          const patches = Object.fromEntries(Object.entries(local.patches).filter(([id]) => !ids.has(id)));
          const added = local.added.filter(record => !ids.has(record.Id));
          const removed = Object.fromEntries(Object.entries(local.removed || {}).filter(([id]) => !ids.has(id)));
          const nextBase = base.filter(record => !ids.has(record.Id));
          const pending = Object.keys(patches).length || added.length || Object.keys(removed).length;
          const next = { ...local, patches, added, removed, imported: nextBase, sync: pending ? { ...local.sync, inflight: null } : null };
          await persist(next, true); local = next; base = nextBase;
          records = C.overlay(base, local.patches, local.added, local.removed);
        });
        if (selected && ids.has(selected)) closeDrawer(true);
        syncError = null; connectionError = ''; render();
        if (!hasQueued()) { saveProgress = null; $('saveProgress').hidden = true; }
      } catch (error) { toast(error.message, true); return; }
    }
    void flushQueue(true);
  };
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
  $('ghDataMode').addEventListener('change', updateGitHubModeHint);
  $('connectDialog').addEventListener('cancel', event => { if (githubBusy) event.preventDefault(); });
  $('connectGitHub').onclick = connectGitHub;
  $('profileSelect').value = authorName;
  $('profileSelect').addEventListener('change', () => {
    if (busy || changingSource || callsInProgress.size || priorityInProgress.size) { $('profileSelect').value = authorName; return; }
    authorName = ['T', 'K'].includes($('profileSelect').value) ? $('profileSelect').value : '';
    try { localStorage.setItem('pracownia.author', authorName); } catch {}
    document.dispatchEvent(new CustomEvent('crm:profile'));
  });
  document.addEventListener('keydown', event => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable;
    if (window.PanelDialogs.isOpen()) return;
    if (event.key === '/' && !$('companiesPanel').hidden && !typing && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open && $('drawer').hidden) { event.preventDefault(); $('search').focus(); }
    if (event.key === 'Escape' && !$('drawer').hidden && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open) closeDrawer();
    if (!typing && !$('drawer').hidden && !$('editDialog').open && !$('connectDialog').open && !$('statusDialog').open && !$('priorityDialog').open && !$('excludeDialog').open && !$('googleDialog').open && !$('callDialog').open && !event.altKey && !event.ctrlKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); navigateCompany(event.key === 'ArrowLeft' ? -1 : 1); }

  });
  window.addEventListener('beforeunload', event => {
    if (busy || actionDirty() || $('editDialog').open || $('callDialog').open || (!storageOK && records.length)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', event => {
    if (event.key !== STORE && event.key !== null) return;
    storageOK = false; storageError = 'Inna karta zmieniła lokalną kopię. Wyeksportuj swoje dane i odśwież stronę przed dalszym zapisem.';
    connectionUI();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollFile(); });
  window.addEventListener('online', () => { if (!github && rememberedGitHub && !restoringGitHub) void restoreGitHub(); else kickSync(); });
  document.addEventListener('crm:google-preview', () => { render(); if (selected) openClient(selected, true); });
  document.addEventListener('crm:language', () => { render(); updateGitHubModeHint(); if (saveProgress && !$('saveProgress').hidden) updateSaveProgress(); if (selected) openClient(selected, true); if ($('callDialog').open) renderCallOptions($('callOutcome').value); I18n.bindUI($('editDialog')); I18n.bindUI($('statusDialog')); if ($('priorityDialog').open && priorityOriginal) renderPriorityOptions(priorityOriginal); });
  render(); restoreGitHub().then(found => { if (!found) restoreHandle(); }); autoLoadCSV(); setInterval(pollFile, 3000);
})();
