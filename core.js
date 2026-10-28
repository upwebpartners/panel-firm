/* Wspólne funkcje danych. Bez zależności i bez połączeń z internetem. */
(function (root) {
  'use strict';
  const fields = {
    name: 'Firma', industry: 'Branza', city: 'Miejscowosc', url: 'Strona',
    issue: 'Sprawdzony problem', offer: 'Proponowana poprawa', priority: 'Priorytet roboczy',
    phone: 'Telefon', email: 'Email', next: 'Nastepny krok', due: 'Termin', price: 'Wycena',
    notes: 'Notatki', stage: 'Etap', assessment: 'Ocena potrzeby zmiany',
    argument: 'Argument do rozmowy', sources: 'Zrodla', checked: 'Data sprawdzenia zrodel',
    scope: 'Zakres weryfikacji', consent: 'Zgoda data i zakres', modified: 'Modyfikacja', id: 'Id',
    editor: 'Edytowal', called: 'Dzwoniono', caller: 'Dzwonil', calls: 'Historia_polaczen'
  };
  const stages = ['Nowy', 'Do sprawdzenia', 'Rozmowa', 'Oferta', 'W realizacji', 'Pozyskany', 'Odrzucony', 'Archiwum'];
  function parseCSV(text) {
    text = String(text).replace(/^\uFEFF/, '');
    let headerQuoted = false, commas = 0, semicolons = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') { if (headerQuoted && text[i + 1] === '"') i++; else headerQuoted = !headerQuoted; }
      if (!headerQuoted) {
        if (/\r|\n/.test(text[i])) break;
        if (text[i] === ',') commas++;
        if (text[i] === ';') semicolons++;
      }
    }
    const sep = semicolons > commas ? ';' : ',';
    const lines = []; let row = [], cell = '', quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted) { quoted = false; closed = true; }
        else if (cell === '' && !closed) quoted = true;
        else throw new Error('Nieprawidłowy CSV: cudzysłów wewnątrz niecytowanego pola.');
      } else if (c === sep && !quoted) { row.push(cell); cell = ''; closed = false; }
      else if ((c === '\n' || c === '\r') && !quoted) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); if (row.some(x => x !== '')) lines.push(row); row = []; cell = ''; closed = false;
      } else {
        if (closed) throw new Error('Nieprawidłowy CSV: tekst po zamkniętym cudzysłowie.');
        cell += c;
      }
    }
    if (quoted) throw new Error('Nieprawidłowy CSV: niedomknięty cudzysłów.');
    if (cell || row.length) { row.push(cell); if (row.some(x => x !== '')) lines.push(row); }
    if (!lines.length || !lines[0].includes('Firma')) throw new Error('Ten plik nie ma kolumny Firma. Wybierz klienci.csv.');
    const headers = lines.shift();
    if (new Set(headers).size !== headers.length) throw new Error('CSV ma powtórzone nazwy kolumn.');
    if (headers.some(header => !header.trim())) throw new Error('CSV zawiera pustą nazwę kolumny.');
    const records = lines.map((values, i) => {
      if (values.length !== headers.length) throw new Error('Niewłaściwa liczba kolumn w wierszu ' + (i + 2) + '.');
      const record = Object.fromEntries(headers.map((key, j) => [key, values[j]]));
      if (record.Firma.trim() === '[Nazwa firmy]' || record.Notatki?.trim() === '[Twoje notatki i ustalenia]') throw new Error('Wypełnij lub usuń pola przykładowe szablonu przed importem.');
      record.Id ||= stableId(record);
      record.Etap ||= 'Nowy';
      return record;
    });
    if (new Set(records.map(r => r.Id)).size !== records.length) throw new Error('CSV zawiera powtórzone identyfikatory klientów.');
    return { headers, records };
  }
  function stableId(record) {
    const str = (record.Firma || '') + '|' + (record.Strona || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return 'firma-' + (hash >>> 0).toString(16);
  }
  function csvText(records, headers = []) {
    const columns = [...new Set([...headers, ...records.flatMap(Object.keys), ...extraColumns])];
    const quote = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    return '\uFEFF' + [columns.map(quote).join(','), ...records.map(r => columns.map(k => quote(r[k])).join(','))].join('\r\n') + '\r\n';
  }
  function overlay(base, patches, added) {
    const patchFor = id => Object.hasOwn(patches, id) ? patches[id] : {};
    const result = base.map(r => ({ ...r, ...patchFor(r.Id) }));
    const ids = new Set(result.map(r => r.Id));
    for (const r of added) if (!ids.has(r.Id)) { result.push({ ...r, ...patchFor(r.Id) }); ids.add(r.Id); }
    return result;
  }
  function merge(base, latest, patches, added) {
    const original = new Map(base.map(r => [r.Id, r]));
    const current = new Map(latest.map(r => [r.Id, { ...r }]));
    const conflicts = [];
    for (const [id, patch] of Object.entries(patches)) {
      const before = original.get(id); const after = current.get(id);
      if (!after) { if (before) conflicts.push({ id, name: before.Firma, field: 'Usunięty w pliku', value: '' }); continue; }
      for (const [key, value] of Object.entries(patch)) {
        if (callColumns.includes(key) && patch.Historia_polaczen) continue;
        if (!['Modyfikacja', 'Edytowal', 'Plik_edytowano', 'Plik_edytowal'].includes(key) && before && String(after[key] ?? '') !== String(before[key] ?? '') && String(after[key] ?? '') !== String(value ?? '')) {
          conflicts.push({ id, name: after.Firma, field: key, value: after[key] });
        }
        after[key] = value;
      }
      if (patch.Historia_polaczen) Object.assign(after, callSummary(unionCalls(callHistory(after), callHistory(patch))));
    }
    for (const record of added) {
      if (!current.has(record.Id)) {
        const duplicate = [...current.values()].find(r => (record.Google_place_id && r.Google_place_id === record.Google_place_id) || norm(r.Firma.trim()) === norm(record.Firma.trim()));
        if (duplicate) conflicts.push({ id: record.Id, name: record.Firma, field: 'Ta firma została już dodana pod innym Id. Odśwież listę.', value: '' });
        else current.set(record.Id, { ...record, ...(Object.hasOwn(patches, record.Id) ? patches[record.Id] : {}) });
      } else if (!original.has(record.Id)) {
        const existing = current.get(record.Id), ignored = ['Modyfikacja', 'Edytowal', 'Plik_edytowano', 'Plik_edytowal'];
        const different = [...new Set([...Object.keys(existing), ...Object.keys(record)])].some(key => !ignored.includes(key) && String(existing[key] || '') !== String(record[key] || ''));
        if (different) conflicts.push({ id: record.Id, name: record.Firma, field: 'Nowy klient o tym samym Id', value: '' });
      }
    }
    return { records: [...current.values()], conflicts };
  }
  function norm(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').toLowerCase(); }
  function safeURL(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function priority(r) { const n = parseInt(r[fields.priority], 10); return Number.isFinite(n) && n > 0 ? n : 99; }
  function industry(r) {
    const n = norm(r.Branza);
    return n.includes('detail') ? 'Detailing' : n.includes('remont') || n.includes('wnetrz') ? 'Remonty' : n.includes('klim') || n.includes('instalac') || n.includes('wentyl') ? 'Instalacje' : r.Branza || 'Inna branża';
  }
  const sortFields = { updated: 'Modyfikacja', added: 'Dodano', status: 'Etap', name: 'Firma', industry: 'Branza', city: 'Miejscowosc', priority: 'Priorytet roboczy', due: 'Termin', called: 'Dzwoniono' };
  function sortRecords(records, { field = 'updated', direction = 'desc', locale = 'pl' } = {}) {
    if (!Object.hasOwn(sortFields, field)) field = 'updated';
    const sign = direction === 'asc' ? 1 : -1;
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    const value = record => {
      const raw = String(record[sortFields[field]] ?? '').trim();
      if (!raw) return null;
      if (['updated', 'added', 'due', 'called'].includes(field)) { const at = Date.parse(raw); return Number.isFinite(at) ? at : null; }
      if (field === 'status') { const index = stages.indexOf(raw); return index >= 0 ? index : null; }
      if (field === 'priority') { const rank = priority(record); return rank === 99 ? null : rank; }
      return field === 'industry' ? industry(record) : raw;
    };
    return records.map(record => ({ record, value: value(record) })).sort((a, b) => {
      // Unknown dates and other missing values stay last in either direction.
      if (a.value === null && b.value !== null) return 1;
      if (b.value === null && a.value !== null) return -1;
      const compared = a.value === null ? 0 : typeof a.value === 'number' ? a.value - b.value : collator.compare(a.value, b.value);
      return sign * compared || collator.compare(a.record.Firma || '', b.record.Firma || '') || collator.compare(a.record.Id || '', b.record.Id || '');
    }).map(item => item.record);
  }
  const callColumns = ['Dzwoniono', 'Dzwonil', 'Liczba_polaczen', 'Historia_polaczen'];
  const selectionColumns = ['Mapa_status', 'Mapa_edytowal', 'Mapa_edytowano', 'Powod_wykreslenia'];
  const extraColumns = [...selectionColumns, 'Google_place_id', 'Adres', 'Dodal', 'Dodano', 'Id', 'Etap', 'Notatki', 'Modyfikacja', 'Edytowal', ...callColumns, 'Plik_edytowano', 'Plik_edytowal'];
  const workflowColumns = [...selectionColumns, 'Google_place_id', 'Dodal', 'Dodano', 'Id', 'Etap', 'Status', 'Notatki', 'Nastepny krok', 'Termin', 'Wycena', 'Godziny', 'Zgoda data i zakres', 'Modyfikacja', 'Edytowal', ...callColumns, 'Plik_edytowano', 'Plik_edytowal'];
  function uid() { return root.crypto?.randomUUID ? root.crypto.randomUUID() : 'wpis-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
  function callHistory(record) {
    if (!record.Historia_polaczen) {
      if (!record.Dzwoniono) return [];
      return [{ id: 'legacy-' + stableId({ Firma: record.Dzwoniono, Strona: record.Dzwonil }), at: record.Dzwoniono, by: record.Dzwonil || 'Nie podano autora', count: Math.max(1, parseInt(record.Liczba_polaczen, 10) || 1) }];
    }
    let items;
    try { items = JSON.parse(record.Historia_polaczen); } catch { throw new Error('Nieprawidłowa historia telefonów w CSV. Popraw pole Historia_polaczen, zanim zapiszesz zmiany.'); }
    if (!Array.isArray(items) || items.some(e => !e || typeof e.id !== 'string' || !e.id || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || typeof e.by !== 'string' || (e.count !== undefined && (!Number.isInteger(e.count) || e.count <= 0)))) throw new Error('Historia telefonów ma nieprawidłowy format.');
    return unionCalls([], items);
  }
  function unionCalls(a, b) {
    const calls = new Map();
    for (const item of [...a, ...b]) {
      const existing = calls.get(item.id);
      if (existing && (existing.at !== item.at || existing.by !== item.by || (existing.count ?? 1) !== (item.count ?? 1))) throw new Error('Historia telefonów zawiera sprzeczne zdarzenia z tym samym identyfikatorem.');
      if (!existing) calls.set(item.id, item);
    }
    return [...calls.values()].sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || x.id.localeCompare(y.id));
  }
  function callSummary(history) {
    const ordered = unionCalls([], history), last = ordered.at(-1);
    return { Historia_polaczen: JSON.stringify(ordered), Dzwoniono: last?.at || '', Dzwonil: last?.by || '', Liczba_polaczen: String(ordered.reduce((n, e) => n + (Number.isInteger(e.count) && e.count > 0 ? e.count : 1), 0)) };
  }
  function callPatch(record, by, at = new Date().toISOString(), id = uid()) {
    return callSummary(unionCalls(callHistory(record), [{ id, at, by }]));
  }
  function fileMeta(records) {
    let at = '', by = '';
    for (const r of records) if (Number.isFinite(Date.parse(r.Plik_edytowano)) && (!at || Date.parse(r.Plik_edytowano) > Date.parse(at))) { at = r.Plik_edytowano; by = r.Plik_edytowal || ''; }
    return { at, by };
  }
  function stampFile(records, at, by) { return records.map(r => ({ ...r, Plik_edytowano: at, Plik_edytowal: by })); }
  function importPlan(current, incoming) {
    const patches = Object.create(null), added = [], seen = [...current];
    for (const row of incoming) {
      let match = seen.find(r => r.Id === row.Id);
      if (!match && row.Google_place_id) match = seen.find(r => r.Google_place_id === row.Google_place_id);
      if (!match) {
        const same = seen.filter(r => norm(r.Firma.trim()) === norm(row.Firma.trim()));
        if (same.length === 1) match = same[0];
      }
      if (!match && (row.Mapa_status === 'wykreslona' || ['Odrzucony', 'Archiwum'].includes(row.Etap)) && !['T', 'K'].includes(row.Mapa_edytowal || row.Edytowal)) throw new Error('Import nie może wykreślać firm bez decyzji T lub K.');
      if (!match) { const newRow = { ...row, Id: row.Id || uid(), Etap: row.Etap || 'Nowy' }; added.push(newRow); seen.push(newRow); continue; }
      const patch = {};
      for (const [key, value] of Object.entries(row)) if (!workflowColumns.includes(key) && value !== '' && String(match[key] || '') !== value) patch[key] = value;
      for (const key of ['Dodal', 'Dodano', 'Google_place_id']) if (!match[key] && row[key]) patch[key] = row[key];
      if (!String(match.Notatki || '').trim() && typeof row.Notatki === 'string' && row.Notatki.trim()) patch.Notatki = row.Notatki;
      const mergedHistory = unionCalls(callHistory(match), callHistory(row));
      if (JSON.stringify(mergedHistory) !== JSON.stringify(callHistory(match))) Object.assign(patch, callSummary(mergedHistory));
      if (Object.keys(patch).length) { patches[match.Id] = { ...(patches[match.Id] || {}), ...patch }; const index = seen.findIndex(r => r.Id === match.Id); seen[index] = { ...match, ...patch }; }
    }
    return { patches, added };
  }
  root.CRMCore = { fields, stages, parseCSV, csvText, overlay, merge, norm, safeURL, priority, industry, sortFields, sortRecords, stableId, uid, callHistory, callPatch, fileMeta, stampFile, importPlan, extraColumns };
})(globalThis);
