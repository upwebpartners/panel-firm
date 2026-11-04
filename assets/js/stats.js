/* Team totals derived from recorded additions and immutable phone events. */
(function (root) {
  'use strict';
  const C = root.CRMCore;
  const outcomeKeys = ['interested', 'callback', 'offers', 'noAnswer', 'declined', 'other'];
  const outcomeNames = ['Zainteresowany', 'Do ponownego kontaktu', 'Prosi o ofertę', 'Nie odebrał', 'Nie zainteresowany', 'Inny wynik', 'Brak zapisanego wyniku'];
  const metrics = ['activity', 'added', 'calls', 'reviewed', 'excluded', 'positive'];
  function summarize(records, { period = 'all', now = new Date(), profiles = [], includeAI = false } = {}) {
    const end = Number(new Date(now)), start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === '7' || period === '30') start.setDate(start.getDate() - Number(period) + 1);
    const beginning = period === 'all' ? -Infinity : +start, people = new Map();
    const empty = (name, kind) => ({ name, kind, ...Object.fromEntries(metrics.map(key => [key, 0])), restored: 0, edited: 0,
      companies: new Set(), outcomes: Object.fromEntries([...outcomeKeys, 'unknown'].map(key => [key, 0])) });
    function person(author) {
      const name = C.profileName(author), key = C.profileKey(name);
      const kind = key === 'ai' ? 'ai' : C.isHumanAuthor(name) ? 'human' : 'unknown', identity = kind === 'unknown' ? '' : key;
      if (!people.has(identity)) people.set(identity, empty(kind === 'unknown' ? 'Nieznany autor' : name, kind));
      return people.get(identity);
    }
    C.teamProfiles(records, profiles).forEach(person);
    let missingDates = 0, legacyCalls = 0, legacyMap = 0;
    const events = [], categories = new Map(), mapWork = new Map(), excludedPlaces = new Set(), seen = new Set();
    function inPeriod(value, count = 1, disclose = true) {
      const timestamp = typeof value === 'string' && value ? Date.parse(value) : NaN;
      if (!Number.isFinite(timestamp)) { if (disclose) missingDates += count; return period === 'all'; }
      return timestamp >= beginning && timestamp <= end;
    }
    const timestamp = event => Number.isFinite(Date.parse(event.at)) ? Date.parse(event.at) : -Infinity;
    function first(bucket, key, event) {
      const previous = bucket.get(key);
      if (!previous || timestamp(event) < timestamp(previous) || timestamp(event) === timestamp(previous) && event.id.localeCompare(previous.id) < 0) bucket.set(key, event);
    }
    function count(event, count = 1) {
      if (!inPeriod(event.at, count)) return;
      const row = person(event.by); row[event.type] += count;
      events.push({ ...event, count, by: row.name, kind: row.kind });
      if (event.type === 'calls') {
        row.companies.add(event.companyId);
        const key = outcomeKeys[C.callOutcomes.indexOf(event.outcome)] || 'unknown';
        row.outcomes[key] += count;
        if (key === 'interested' || key === 'offers') row.positive += count;
        if (event.id.startsWith('legacy-') || count > 1) legacyCalls += count;
      }
    }
    for (const record of records) {
      if (seen.has(record.Id)) continue;
      seen.add(record.Id);
      const placeKey = record.Google_place_id || record.Id;
      if (record.Mapa_status === 'wykreslona') excludedPlaces.add(placeKey);
      const journal = C.activityHistory(record), company = C.companyName(record);
      function candidate(event) {
        if (!['added', 'reviewed', 'excluded'].includes(event.type)) return;
        const value = { ...event, company, companyId: record.Id };
        // Dedupe across the full history BEFORE period filtering: moving the
        // same place between states cannot earn fresh credit next week.
        first(categories, event.type + ':' + placeKey, value);
        if (record.Google_place_id && event.map !== false) first(mapWork, placeKey, value);
      }
      journal.forEach(candidate);
      const legacy = C.legacyMapActivity(record);
      if (legacy) { legacyMap++; candidate(legacy); }
      if (C.isMapDecisionOnly(record)) continue;
      if (!journal.some(event => ['added', 'reviewed', 'excluded', 'restored'].includes(event.type)) && (!record.Mapa_status || record.Mapa_status === 'dodana')) {
        candidate({ id: 'legacy-added-' + record.Id, at: record.Dodano || '', by: record.Dodal || '', type: 'added' });
      }
      for (const call of C.callHistory(record)) count({ ...call, type: 'calls', company, companyId: record.Id }, call.count || 1);
    }
    for (const event of categories.values()) count(event);
    for (const event of mapWork.values()) if (inPeriod(event.at, 1, false)) person(event.by).activity++;
    const rows = [...people.values()].filter(row => includeAI || row.kind !== 'ai').map(row => ({ ...row, companies: row.companies.size }));
    const totals = { ...Object.fromEntries(metrics.map(key => [key, 0])), restored: 0, edited: 0 };
    for (const row of rows) for (const key of metrics) totals[key] += row[key];
    const recent = events.filter(event => includeAI || event.kind !== 'ai').sort((a,b) => timestamp(b) - timestamp(a) || a.id.localeCompare(b.id));
    return { rows, totals, missingDates, legacyCalls, legacyMap, excludedCompanies: excludedPlaces.size, recent };
  }
  function ranked(rows, metric = 'activity') {
    if (!metrics.includes(metric)) metric = 'activity';
    const kindOrder = { human: 0, ai: 1, unknown: 2 };
    return [...rows].sort((a,b) => kindOrder[a.kind] - kindOrder[b.kind] || b[metric] - a[metric] || a.name.localeCompare(b.name, 'pl'));
  }
  root.TeamStats = { summarize, ranked };
  if (typeof document === 'undefined' || !document.getElementById('statsPanel') || !root.CRM) return;
  const $ = id => document.getElementById(id), t = value => root.I18n.t(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const number = value => value.toLocaleString(root.I18n.locale());
  let markup = '';
  function render() {
    if ($('statsPanel').hidden) return;
    try {
      const summary = summarize(root.CRM.records(), { period: $('statsPeriod').value || 'all', profiles: root.CRM.profiles(), includeAI: $('statsAI').checked });
      const metric = metrics.includes($('statsMetric').value) ? $('statsMetric').value : 'activity';
      const rows = ranked(summary.rows, metric), maximum = Math.max(1, ...rows.filter(row => row.kind === 'human').map(row => row[metric]));
      const label = { activity: 'Praca na mapie', added: 'Dodane firmy', calls: 'Telefony', positive: 'Pozytywne rozmowy',
        reviewed: 'Przejrzenia', excluded: 'Wykreślenia', restored: 'Przywrócenia', edited: 'Zmiany danych' };
      const header = labels => '<thead><tr>' + labels.map(value => '<th scope="col">' + esc(t(value)) + '</th>').join('') + '</tr></thead>';
      const body = rows.map((row,index) => '<tr class="stats-person ' + row.kind + '"><th scope="row"><span class="stats-rank">' + (row.kind === 'human' && row[metric] ? rows.findIndex(other => other.kind === 'human' && other[metric] === row[metric]) + 1 : '—') + '</span><span data-content>' + esc(row.kind === 'unknown' ? t(row.name) : row.name) + '</span></th>' +
        [row.activity, row.added, row.calls, row.reviewed, row.excluded, row.companies].map(value => '<td>' + number(value) + '</td>').join('') + '</tr>').join('');
      const eventLabel = { added: 'Dodanie firmy', calls: 'Telefon', reviewed: 'Przejrzenie miejsca', excluded: 'Wykreślenie firmy', restored: 'Przywrócenie firmy', edited: 'Zmiana danych' };
      const timeline = summary.recent.slice(0, 50).map(event => {
        const date = Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toLocaleString(root.I18n.locale(), { dateStyle: 'short', timeStyle: 'short' }) : t('Brak daty');
        return '<li><span class="stats-event-date">' + esc(date) + '</span><div><strong data-content>' + esc(event.kind === 'unknown' ? t(event.by) : event.by) + '</strong><span> · ' + esc(t(eventLabel[event.type])) + (event.count > 1 ? ' × ' + number(event.count) : '') + '</span><p data-content>' + esc(event.company) + '</p></div></li>';
      }).join('');
      const html = '<div class="stats-current"><span>' + esc(t('Obecnie wykreślone firmy')) + '</span><strong>' + number(summary.excludedCompanies) + '</strong><small>' + esc(t('Stan całej bazy, niezależnie od okresu. Bez zapytań do Google.')) + '</small></div>' +
        '<div class="stats-summary">' + ['activity', 'added', 'calls', 'excluded'].map(key => '<div class="stats-total"><span>' + esc(t(label[key])) + '</span><strong>' + number(summary.totals[key]) + '</strong></div>').join('') + '</div>' +
        (!summary.totals.activity && !summary.totals.calls && !summary.totals.added ? '<p class="stats-empty">' + esc(t('Brak zapisanych działań w tym okresie.')) + '</p>' : '') +
        '<section class="stats-section"><h2>' + esc(t('Porównanie osób')) + '</h2><div class="stats-table-wrap" role="region" aria-label="' + esc(t('Porównanie osób')) + '" tabindex="0"><table class="stats-table">' +
        header(['Osoba', 'Praca na mapie', 'Dodane firmy', 'Telefony', 'Przejrzenia', 'Wykreślenia', 'Firmy z telefonem']) + '<tbody>' + body + '</tbody></table></div></section>' +
        '<section class="stats-section"><h2>' + esc(t(label[metric])) + '</h2><div class="stats-bars">' + rows.filter(row => row.kind === 'human').map(row => '<div class="stats-bar-row"><span data-content>' + esc(row.name) + '</span><span class="stats-bar-track" aria-hidden="true"><span style="width:' + (row[metric] / maximum * 100).toFixed(2) + '%"></span></span><strong>' + number(row[metric]) + '</strong></div>').join('') + '</div></section>' +
        '<section class="stats-section"><h2>' + esc(t('Wyniki rozmów według osób')) + '</h2><div class="stats-table-wrap" role="region" aria-label="' + esc(t('Wyniki rozmów według osób')) + '" tabindex="0"><table class="stats-table stats-outcomes">' +
        header(['Osoba', ...outcomeNames]) + '<tbody>' + rows.map(row => '<tr><th scope="row" data-content>' + esc(row.kind === 'unknown' ? t(row.name) : row.name) + '</th>' + [...outcomeKeys, 'unknown'].map(key => '<td>' + number(row.outcomes[key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>' +
        '<section class="stats-section"><h2>' + esc(t('Ostatnie wpisy aktywności')) + '</h2>' + (timeline ? '<ol class="stats-timeline">' + timeline + '</ol>' : '<p class="small-copy">' + esc(t('Brak zapisanych działań w tym okresie.')) + '</p>') +
        (summary.recent.length > 50 ? '<p class="small-copy">' + esc(t('Pokazano ostatnie 50 wpisów.')) + '</p>' : '') + '</section>';
      if (markup !== html) { $('statsContent').innerHTML = html; markup = html; }
      $('statsPending').hidden = !root.CRM.pending();
      $('statsIncomplete').hidden = !summary.missingDates && !summary.legacyCalls;
      $('statsIncomplete').textContent = t('Starsze dane mogą być niepełne. Wpisy bez daty liczymy tylko dla całego okresu; dawne zbiorcze telefony według zapisanej daty.');
      $('statsError').hidden = true;
    } catch (error) {
      $('statsError').hidden = false; $('statsError').textContent = root.I18n.message(error.message);
      $('statsContent').innerHTML = ''; markup = '';
    }
  }
  for (const id of ['statsPeriod', 'statsMetric', 'statsAI']) $(id).addEventListener('change', render);
  for (const name of ['crm:tab', 'crm:data', 'crm:connection', 'crm:profile', 'crm:language']) document.addEventListener(name, render);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  render();
})(globalThis);
