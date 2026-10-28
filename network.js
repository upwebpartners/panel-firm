/* A timeout includes response bodies, not only receipt of HTTP headers. */
(function (root) {
  'use strict';
  async function withTimeout(operation, options = {}) {
    const milliseconds = options.milliseconds ?? 20000;
    const controller = options.controller || (root.AbortController ? new root.AbortController() : null);
    const schedule = options.schedule || root.setTimeout, cancel = options.cancel || root.clearTimeout;
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = schedule(() => {
        const error = new Error('Serwer nie odpowiedział na czas. Sprawdź połączenie i spróbuj ponownie.');
        error.code = 'TIMEOUT'; reject(error); controller?.abort();
      }, milliseconds);
    });
    try { return await Promise.race([timeout, Promise.resolve().then(() => operation(controller?.signal))]); }
    finally { cancel(timer); }
  }
  root.Network = { withTimeout };
})(globalThis);
