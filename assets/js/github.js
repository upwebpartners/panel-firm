/* GitHub Contents API. Token istnieje wyłącznie w pamięci otwartej karty. */
(function (root) {
  'use strict';
  const C = root.CRMCore;
  function encode(text) {
    const bytes = new TextEncoder().encode(text); let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(binary);
  }
  function decode(text) { return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, '')), ch => ch.charCodeAt(0))); }
  class GitHubCSV {
    constructor(config, token, request = root.fetch.bind(root)) {
      if (!/^[a-z\d][a-z\d-]{0,38}$/i.test(config.owner) || !/^[\w.-]+$/.test(config.repo)) throw new Error('Podaj poprawną nazwę właściciela i repozytorium GitHub.');
      const path = config.path.trim().replace(/^\/+/, '');
      if (!path.endsWith('.csv') || path.split('/').some(x => !x || x === '.' || x === '..') || /[\u0000-\u001f]/.test(path)) throw new Error('Ścieżka musi wskazywać plik .csv bez segmentów ..');
      if (!config.branch.trim() || /[\u0000-\u0020]/.test(config.branch)) throw new Error('Podaj nazwę gałęzi, np. main.');
      if (!token.trim()) throw new Error('Wpisz swój token GitHub w tym formularzu.');
      this.config = { owner: config.owner, repo: config.repo, branch: config.branch.trim(), path };
      this.token = token.trim(); this.fetch = request; this.cached = null; this.login = ''; this.controllers = new Set();
      this.prefix = '/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo);
      this.fileEndpoint = this.prefix + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
    }
    async request(path, options = {}) {
      if (!this.token) throw new Error('Wspólna baza jest rozłączona. Połącz GitHub ponownie przed zapisem.');
      const controller = root.AbortController ? new root.AbortController() : null;
      if (controller) this.controllers.add(controller);
      try {
        return await root.Network.withTimeout(async signal => {
          const response = await this.fetch('https://api.github.com' + path, { ...options, signal, cache: 'no-store', redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + this.token, ...(options.headers || {}) } });
          if (!response.ok) {
            let body = {}; try { body = await response.json(); } catch {}
            const message = response.status === 401 ? 'GitHub odrzucił token. Sprawdź, czy nie wygasł.' : response.status === 403 ? 'Brak dostępu lub limit GitHuba. Sprawdź dostęp do repozytorium: fine-grained wymaga Contents: Read and write; token classic zakresu repo.' : response.status === 404 ? 'Nie znaleziono repozytorium, gałęzi lub pliku. Sprawdź dostęp tokenu i konfigurację.' : response.status === 409 ? 'Ktoś właśnie zapisał plik. Ponawiam odczyt najnowszej wersji.' : 'GitHub nie przyjął operacji (HTTP ' + response.status + ').';
            const error = new Error(message); error.status = response.status; error.detail = String(body.message || ''); throw error;
          }
          const raw = options.headers?.Accept === 'application/vnd.github.raw+json';
          const body = await (raw ? response.text() : response.json());
          return raw ? { text: async () => body } : { json: async () => body };
        }, { controller });
      } finally { if (controller) this.controllers.delete(controller); }
    }
    async connect() {
      const user = await (await this.request('/user')).json(); this.login = user.login;
      await this.request(this.prefix);
      return this.read(true);
    }
    async read(allowMissing = false) {
      let file;
      try { file = await (await this.request(this.fileEndpoint + '?ref=' + encodeURIComponent(this.config.branch))).json(); }
      catch (error) {
        if (allowMissing && error.status === 404) {
          await this.request(this.prefix + '/branches/' + encodeURIComponent(this.config.branch));
          return { records: [], headers: ['Firma', ...C.extraColumns], sha: null, missing: true, at: '', by: '' };
        }
        throw error;
      }
      if (file.type !== 'file' || !file.sha) throw new Error('Podana ścieżka nie jest plikiem CSV.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Limit bazy CSV w panelu wynosi 10 MB.');
      if (this.cached?.sha === file.sha) return this.cached;
      let text;
      if (file.encoding === 'base64' && typeof file.content === 'string' && file.content) text = decode(file.content);
      else text = await (await this.request(this.prefix + '/git/blobs/' + encodeURIComponent(file.sha), { headers: { Accept: 'application/vnd.github.raw+json' } })).text();
      const parsed = C.parseCSV(text); parsed.records.forEach(C.callHistory);
      const info = C.fileMeta(parsed.records);
      try {
        const commits = await (await this.request(this.prefix + '/commits?path=' + encodeURIComponent(this.config.path) + '&sha=' + encodeURIComponent(this.config.branch) + '&per_page=1')).json();
        if (commits[0]?.commit?.committer?.date) info.at = commits[0].commit.committer.date;
        if (!info.by) info.by = commits[0]?.author?.login || commits[0]?.commit?.author?.name || '';
      } catch { /* Metadane w CSV pozostają dostępne bez historii commitów. */ }
      this.cached = { ...parsed, sha: file.sha, at: info.at, by: info.by, missing: false };
      return this.cached;
    }
    async save(base, patches, added, author) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const latest = await this.read(true);
        if (latest.missing && base.length) throw new Error('Wspólny CSV został usunięty. Zapis wstrzymany, aby nie odtworzyć niepełnej bazy.');
        const result = C.merge(base, latest.records, patches, added);
        if (result.conflicts.length) {
          const error = new Error('Konflikt zmian: ' + result.conflicts.slice(0, 4).map(c => c.name + ' / ' + c.field).join('; ') + '. Zamknij edycję i odczytaj najnowszą kartę. Niczego nie nadpisano.');
          error.code = 'CONFLICT'; error.conflicts = result.conflicts; throw error;
        }
        const at = new Date().toISOString(), next = C.stampFile(result.records, at, author), text = C.csvText(next, latest.headers);
        if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error('Baza przekracza limit 10 MB.');
        const body = { message: 'CRM: aktualizacja klientów — ' + author, branch: this.config.branch, content: encode(text), ...(latest.sha ? { sha: latest.sha } : {}) };
        try {
          const response = await (await this.request(this.fileEndpoint, { method: 'PUT', body: JSON.stringify(body) })).json();
          this.cached = { ...C.parseCSV(text), sha: response.content.sha, missing: false, at: response.commit?.committer?.date || at, by: author };
          return this.cached;
        } catch (error) {
          if ((error.status === 409 || error.status === 422 && /sha|does not match|is at/i.test(error.detail)) && attempt < 2) { this.cached = null; continue; }
          throw error;
        }
      }
    }
    async replace(records, headers, expectedSHA, author) {
      if (!['T', 'K'].includes(author)) throw new Error('Wybierz T lub K w nagłówku, aby zapisać zmianę.');
      const at = new Date().toISOString(), text = C.csvText(C.stampFile(records, at, author), headers.includes('Firma') ? headers : ['Firma', ...headers]);
      if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) throw new Error('Baza przekracza limit 10 MB.');
      const parsed = C.parseCSV(text); parsed.records.forEach(C.callHistory);
      const changed = () => {
        const error = new Error('Baza na GitHubie zmieniła się podczas łączenia. Połącz się ponownie i potwierdź zastąpienie aktualnej wersji.');
        error.code = 'STALE_REPLACEMENT'; return error;
      };
      const latest = await this.read(true);
      if (latest.sha !== expectedSHA) throw changed();
      const body = { message: 'CRM: zastąpienie bazy klientów — ' + author, branch: this.config.branch, content: encode(text), ...(expectedSHA ? { sha: expectedSHA } : {}) };
      try {
        const response = await (await this.request(this.fileEndpoint, { method: 'PUT', body: JSON.stringify(body) })).json();
        this.cached = { ...parsed, sha: response.content.sha, missing: false, at: response.commit?.committer?.date || at, by: author };
        return this.cached;
      } catch (error) {
        if (error.status === 409 || error.status === 422 && /sha|does not match|is at/i.test(error.detail)) { this.cached = null; throw changed(); }
        throw error;
      }
    }
    close() { this.token = ''; this.cached = null; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
  }
  root.GitHubCSV = GitHubCSV;
})(globalThis);
