/* Translate interface labels only. Company names, analyses and editable values stay intact. */
(function (root) {
  'use strict';
  const messages = root.CRM_MESSAGES || {}, reverse = new Map(Object.entries(messages).map(([pl, en]) => [en, pl]));
  // Keep the existing storage key so saved language preferences survive cleanup.
  let language = 'pl'; try { language = localStorage.getItem('atlas.language') === 'en' ? 'en' : 'pl'; } catch {}
  const bindings = new Map();
  function source(value) {
    const numbered = /^(\d+) · (high|medium|lower)$/.exec(value);
    if (numbered) return numbered[1] + ' · ' + ({ high: 'wysoki', medium: 'średni', lower: 'niższy' })[numbered[2]];
    return reverse.get(value) || value;
  }
  function t(value) {
    if (value == null) return '';
    const key = source(String(value)), numbered = /^(\d+) · (wysoki|średni|niższy)$/.exec(key);
    if (numbered) return numbered[1] + ' · ' + (language === 'en' ? messages[numbered[2]] : numbered[2]);
    return language === 'en' ? messages[key] || key : key;
  }
  function message(value) {
    const text = String(value ?? ''); if (language !== 'en') return text;
    if (messages[text]) return messages[text];
    const patterns = [
      [/^Wyniki Google: (\d+)\/20\. To nie jest pełna lista firm w okolicy\.$/, (_, n) => `Google results: ${n}/20. This is not a complete business directory.`],
      [/^Wczytano oznaczenia: (\d+)\. Pozostało: (\d+)\.$/, (_, a, b) => `Loaded markers: ${a}. Remaining: ${b}.`],
      [/^Wyświetlono (\d+) z (\d+) firm$/, (_, a, b) => `Showing ${a} of ${b} companies`],
      [/^Ostatni zapis telefonu: (.*?) \((.*?)\)\. Zapisać kolejny wykonany telefon teraz\?$/, (_, at, by) => `Last recorded call: ${at} (${by}). Record another completed call now?`],
      [/^W repozytorium nie ma jeszcze tego CSV\. Zapisać w nim obecną listę (\d+) firm\?$/, (_, count) => `This CSV does not exist in the repository yet. Save the current ${count} companies there?`],
      [/^Konflikt zmian: (.+)\. Zamknij edycję i odczytaj najnowszą kartę\. Niczego nie nadpisano\.$/, (_, fields) => `Edit conflict: ${fields}. Close the editor and open the latest company card. Nothing was overwritten.`],
      [/^GitHub nie przyjął operacji \(HTTP (\d+)\)\.$/, (_, status) => `GitHub rejected the operation (HTTP ${status}).`]
    ];
    for (const [pattern, replace] of patterns) if (pattern.test(text)) return text.replace(pattern, replace);
    const segments = [
      ['Te same pola zmieniła druga osoba: ', 'The other person changed the same fields: '], ['. Odśwież kartę klienta.', '. Refresh the company card.'],
      ['Brak dostępu lub limit GitHuba. Sprawdź dostęp do repozytorium: fine-grained wymaga Contents: Read and write; token classic zakresu repo.', 'GitHub access denied or rate limit reached. Check repository access: fine-grained tokens need Contents: Read and write; classic tokens need repo scope.'],
      ['Nieprawidłowy CSV: niedomknięty cudzysłów.', 'Invalid CSV: an unclosed quotation mark.'], ['Ten plik nie ma kolumny Firma. Wybierz klienci.csv.', 'The file has no Firma column. Select the company CSV.'],
      ['CSV ma powtórzone nazwy kolumn.', 'The CSV has duplicate column names.'], ['CSV zawiera powtórzone identyfikatory klientów.', 'The CSV contains duplicate company IDs.'],
      ['Niewłaściwa liczba kolumn w wierszu ', 'Wrong number of columns in row '], ['Nieprawidłowa historia telefonów w CSV. Popraw pole Historia_polaczen, zanim zapiszesz zmiany.', 'Invalid call history in the CSV. Correct Historia_polaczen before saving changes.'],
      ['Historia telefonów ma nieprawidłowy format.', 'Call history has an invalid format.'], ['Ktoś właśnie zapisał plik. Ponawiam odczyt najnowszej wersji.', 'Someone just saved the file. Reading the latest version again.']
    ];
    let result = text; for (const [pl, en] of segments) result = result.split(pl).join(en); return result;
  }
  function captureText(node) {
    const raw = node.nodeValue || '', trimmed = raw.trim(), key = source(trimmed);
    if (!Object.hasOwn(messages, key) && !/^\d+ · (wysoki|średni|niższy)$/.test(key)) return;
    bindings.set(node, { kind: 'text', key, start: raw.match(/^\s*/)[0], end: raw.match(/\s*$/)[0] });
  }
  function captureAttributes(element) {
    const values = {};
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      const value = element.getAttribute(attr); if (value && Object.hasOwn(messages, source(value))) values[attr] = source(value);
    }
    if (Object.keys(values).length) bindings.set(element, { kind: 'attributes', values });
    if (element.tagName === 'OPTION' && !element.hasAttribute('value')) element.value = source(element.textContent.trim());
  }
  function capture(rootNode, all = false) {
    if (!rootNode || typeof document === 'undefined') return;
    const elements = all ? [rootNode] : [...rootNode.querySelectorAll('label,.form-divider,.advanced-fields summary,button,input[placeholder],textarea[placeholder],select option,.empty-state p,.form-error,#toast')];
    for (const element of elements) {
      const walker = document.createTreeWalker(element, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('script,style,svg,textarea,[data-content],.firm-name')) continue;
        captureText(node);
      }
      captureAttributes(element);
      if (all) element.querySelectorAll('[placeholder],[title],[aria-label],option').forEach(captureAttributes);
    }
    apply();
  }
  function apply() {
    for (const [node, binding] of bindings) {
      if (node.isConnected === false) { bindings.delete(node); continue; }
      if (binding.kind === 'text') node.nodeValue = binding.start + t(binding.key) + binding.end;
      else for (const [name, value] of Object.entries(binding.values)) node.setAttribute(name, t(value));
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
      document.title = language === 'en' ? 'Companies' : 'Firmy';
    }
  }
  function setLanguage(value) {
    language = value === 'en' ? 'en' : 'pl';
    try { localStorage.setItem('atlas.language', language); } catch {}
    apply();
    if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('crm:language', { detail: { language } }));
  }
  root.I18n = { t, message, setLanguage, language: () => language, locale: () => language === 'en' ? 'en-GB' : 'pl-PL', bindUI: rootNode => capture(rootNode), captureStatic: rootNode => capture(rootNode, true) };
  if (typeof document !== 'undefined') root.I18n.captureStatic(document.body);
})(globalThis);
