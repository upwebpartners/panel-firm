/* Team totals derived from recorded additions and immutable phone events. */
(function (root) {
  'use strict';
  const C = root.CRMCore;
  const outcomeKeys = ['interested', 'callback', 'offers', 'noAnswer', 'declined', 'other'];
  const outcomeNames = ['Zainteresowany', 'Do ponownego kontaktu', 'Prosi o ofertę', 'Nie odebrał', 'Nie zainteresowany', 'Inny wynik', 'Brak zapisanego wyniku'];
  const metrics = ['added', 'calls', 'positive'];
  function summarize(records, { period = 'all', now = new Date(), profiles = [], includeAI = false } = {}) {
    const end = Number(new Date(now)), start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (period === '7' || period === '30') start.setDate(start.getDate() - Number(period) + 1);
    const beginning = period === 'all' ? -Infinity : +start;
    const people = new Map();
    const empty = (name, kind) => ({ name, kind, added: 0, calls: 0, companies: new Set(), positive: 0,
      outcomes: Object.fromEntries([...outcomeKeys, 'unknown'].map(key => [key, 0])) });
    function person(author) {
      const name = C.profileName(author), key = C.profileKey(name);
      const kind = key === 'ai' ? 'ai' : C.isHumanAuthor(name) ? 'human' : 'unknown';
      const identity = kind === 'unknown' ? '' : key;
      if (!people.has(identity)) people.set(identity, empty(kind === 'unknown' ? 'Nieznany autor' : name, kind));
      return people.get(identity);
    }
    C.teamProfiles(records, profiles).forEach(person);
    let missingDates = 0, legacyCalls = 0;
    function inPeriod(value, count = 1) {
      const timestamp = typeof value === 'string' && value ? Date.parse(value) : NaN;
      if (!Number.isFinite(timestamp)) { missingDates += count; return period === 'all'; }
      return timestamp >= beginning && timestamp <= end;
    }
    const seen = new Set();
    for (const record of records) {
      if (seen.has(record.Id)) continue;
      seen.add(record.Id);
      if (C.isMapDecisionOnly(record)) continue;
      // Reviewed/excluded map references are outside the current company list.
      if ((!record.Mapa_status || record.Mapa_status === 'dodana') && inPeriod(record.Dodano)) person(record.Dodal).added++;
      for (const call of C.callHistory(record)) {
        const count = call.count || 1;
        if (!inPeriod(call.at, count)) continue;
        const row = person(call.by), key = outcomeKeys[C.callOutcomes.indexOf(call.outcome)] || 'unknown';
        row.calls += count; row.companies.add(record.Id); row.outcomes[key] += count;
        if (key === 'interested' || key === 'offers') row.positive += count;
        if (call.id.startsWith('legacy-') || count > 1) legacyCalls += count;
      }
    }
    const rows = [...people.values()].filter(row => includeAI || row.kind !== 'ai').map(row => ({ ...row, companies: row.companies.size }));
    const totals = { added: 0, calls: 0, positive: 0 };
    for (const row of rows) for (const key of metrics) totals[key] += row[key];
    return { rows, totals, missingDates, legacyCalls };
  }
  function ranked(rows, metric = 'calls') {
    if (!metrics.includes(metric)) metric = 'calls';
    const kindOrder = { human: 0, ai: 1, unknown: 2 };
    return [...rows].sort((a,b) => kindOrder[a.kind] - kindOrder[b.kind] || b[metric] - a[metric] || b.calls - a.calls || b.added - a.added || a.name.localeCompare(b.name, 'pl'));
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
      const metric = metrics.includes($('statsMetric').value) ? $('statsMetric').value : 'calls';
      const rows = ranked(summary.rows, metric), maximum = Math.max(1, ...rows.filter(row => row.kind === 'human').map(row => row[metric]));
      const label = { added: 'Dodane firmy', calls: 'Telefony', positive: 'Pozytywne rozmowy' };
      const header = labels => '<thead><tr>' + labels.map(value => '<th scope="col">' + esc(t(value)) + '</th>').join('') + '</tr></thead>';
      const body = rows.map((row,index) => '<tr class="stats-person ' + row.kind + '"><th scope="row"><span class="stats-rank">' + (row.kind === 'human' ? index + 1 : '—') + '</span><span data-content>' + esc(row.kind === 'unknown' ? t(row.name) : row.name) + '</span></th>' +
        [row.added, row.calls, row.companies, row.outcomes.interested, row.outcomes.offers].map(value => '<td>' + number(value) + '</td>').join('') + '</tr>').join('');
      const activity = summary.totals.added + summary.totals.calls;
      const html = '<div class="stats-summary">' + metrics.map(key => '<div class="stats-total"><span>' + esc(t(label[key])) + '</span><strong>' + number(summary.totals[key]) + '</strong></div>').join('') + '</div>' +
        (!activity ? '<p class="stats-empty">' + esc(t('Brak zapisanych działań w tym okresie.')) + '</p>' : '') +
        '<section class="stats-section"><h2>' + esc(t('Porównanie osób')) + '</h2><div class="stats-table-wrap" role="region" aria-label="' + esc(t('Porównanie osób')) + '" tabindex="0"><table class="stats-table">' +
        header(['Osoba', 'Dodane firmy', 'Telefony', 'Firmy z telefonem', 'Zainteresowany', 'Prosi o ofertę']) + '<tbody>' + body + '</tbody></table></div></section>' +
        '<section class="stats-section"><h2>' + esc(t(label[metric])) + '</h2><div class="stats-bars">' + rows.filter(row => row.kind === 'human').map(row => '<div class="stats-bar-row"><span data-content>' + esc(row.name) + '</span><span class="stats-bar-track" aria-hidden="true"><span style="width:' + (row[metric] / maximum * 100).toFixed(2) + '%"></span></span><strong>' + number(row[metric]) + '</strong></div>').join('') + '</div></section>' +
        '<section class="stats-section"><h2>' + esc(t('Wyniki rozmów według osób')) + '</h2><div class="stats-table-wrap" role="region" aria-label="' + esc(t('Wyniki rozmów według osób')) + '" tabindex="0"><table class="stats-table stats-outcomes">' +
        header(['Osoba', ...outcomeNames]) + '<tbody>' + rows.map(row => '<tr><th scope="row" data-content>' + esc(row.kind === 'unknown' ? t(row.name) : row.name) + '</th>' + [...outcomeKeys, 'unknown'].map(key => '<td>' + number(row.outcomes[key]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div></section>';
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
