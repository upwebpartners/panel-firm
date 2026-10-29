/* Validated browser snapshots. Never overwrite a broken or newer copy silently. */
(function (root) {
  'use strict';
  const C = root.CRMCore;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const stringFields = value => object(value) && Object.values(value).every(item => typeof item === 'string');
  function validate(snapshot) {
    const rows = value => Array.isArray(value) && value.every(row => stringFields(row) && row.Id && typeof row.Firma === 'string');
    const removals = value => value == null || object(value) && Object.entries(value).every(([id, versions]) => rows(versions) && versions.length > 0 && versions.length <= 3 && versions.every(row => row.Id === id));
    if (!object(snapshot) || !object(snapshot.patches) || !Object.values(snapshot.patches).every(stringFields) ||
        !rows(snapshot.added) || !removals(snapshot.removed) || !(snapshot.imported == null || rows(snapshot.imported)) ||
        !(snapshot.meta == null || stringFields(snapshot.meta)) || !(snapshot.info == null || object(snapshot.info)) ||
        !(snapshot.sync == null || object(snapshot.sync) && object(snapshot.sync.target) && ['owner','repo','branch','path'].every(key => typeof snapshot.sync.target[key] === 'string') && ['T','K'].includes(snapshot.sync.author)) ||
        !(snapshot.headers == null || Array.isArray(snapshot.headers) && snapshot.headers.every(header => typeof header === 'string'))) {
      throw new Error('Zapisana kopia ma nieprawidłowy format. Nie nadpisano jej. Zachowaj kopię przed naprawą.');
    }
    for (const list of [snapshot.added, snapshot.imported || []]) {
      if (new Set(list.map(row => row.Id)).size !== list.length) throw new Error('Zapisana kopia zawiera powtórzone identyfikatory. Nie nadpisano jej.');
      list.forEach(C.callHistory);
    }
    const batch = snapshot.sync?.inflight;
    if (batch != null) {
      if (!object(batch) || !rows(batch.base) || !rows(batch.added) || !removals(batch.removed) || !object(batch.patches) || !Object.values(batch.patches).every(stringFields) || !['T','K'].includes(batch.author)) throw new Error('Nieprawidłowy zapis oczekujących zmian. Nie nadpisano kopii.');
      [...batch.base, ...batch.added, ...Object.values(batch.patches)].forEach(C.callHistory);
      Object.values(batch.removed || {}).flat().forEach(C.callHistory);
    }
    Object.values(snapshot.patches).forEach(C.callHistory);
    Object.values(snapshot.removed || {}).flat().forEach(C.callHistory);
    return snapshot;
  }
  class BrowserStore {
    constructor(storage, key = 'pracownia.crm.v1', locks = root.navigator?.locks) {
      this.storage = storage; this.key = key; this.locks = locks; this.raw = null; this.loaded = false;
    }
    load() {
      this.loaded = false;
      this.raw = this.storage.getItem(this.key);
      let snapshot = null;
      if (this.raw !== null) {
        try { snapshot = JSON.parse(this.raw); }
        catch { throw new Error('Nie można odczytać zapisanej kopii. Nie nadpisano jej. Zachowaj kopię przed naprawą.'); }
        validate(snapshot);
      }
      this.loaded = true;
      return snapshot;
    }
    async save(snapshot) {
      const next = JSON.stringify(validate(snapshot));
      const write = () => {
        if (!this.loaded) throw new Error('Zapisana kopia wymaga sprawdzenia. Nie nadpisano jej.');
        if (this.storage.getItem(this.key) !== this.raw) throw new Error('Inna karta zmieniła lokalną kopię. Wyeksportuj swoje dane i odśwież stronę przed dalszym zapisem.');
        try { this.storage.setItem(this.key, next); }
        catch { throw new Error('Nie udało się zapisać w przeglądarce. Sprawdź wolne miejsce lub połącz CSV. Zmiana nie została zapisana.'); }
        this.raw = next;
      };
      // The lock covers the version check and write, including between tabs.
      if (this.locks?.request) await this.locks.request(this.key, write);
      else write();
    }
  }
  root.BrowserStore = BrowserStore;
})(globalThis);
