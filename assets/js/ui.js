/* Theme and top-level navigation. Business map is initialized on demand. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !document.getElementById('companiesPanel')) return;
  const $ = id => document.getElementById(id), t = I18n.t;
  let theme = 'light', mainTab = 'companies', navigationVersion = 0;
  const dropdowns = () => [...document.querySelectorAll('details[data-dropdown]')];
  function closeMenus(except = null) {
    for (const menu of dropdowns()) if (menu !== except) menu.open = false;
  }
  function dismissOutside(event) {
    for (const menu of dropdowns()) if (menu.open && !menu.contains(event.target)) menu.open = false;
  }
  // Preserve existing theme preferences stored by earlier versions.
  try { theme = localStorage.getItem('atlas.theme') === 'dark' ? 'dark' : 'light'; } catch {}
  function appearance() {
    document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
    const label = t(theme === 'dark' ? 'Włącz tryb jasny' : 'Włącz tryb ciemny');
    $('themeToggle').setAttribute('aria-label', label); $('themeToggle').title = label;
    $('themeToggle').innerHTML = '<svg aria-hidden="true"><use href="#i-' + (theme === 'dark' ? 'sun' : 'moon') + '"/></svg>';
    const languageAction = t(I18n.language() === 'pl' ? 'Przełącz na angielski' : 'Przełącz na polski');
    $('languageToggle').textContent = I18n.language().toUpperCase();
    $('languageToggle').setAttribute('aria-label', languageAction); $('languageToggle').title = languageAction;
  }
  async function showTab(value, focus = false) {
    const version = ++navigationVersion, guards = [], commits = [];
    const cancelled = () => { if (version === navigationVersion) { try { history.replaceState(null, '', '#' + mainTab); } catch {} } return false; };
    const next = value === 'map' ? 'map' : 'companies';
    const event = new CustomEvent('crm:beforetab', { detail: { tab: next, guard: callback => guards.push(callback), commit: callback => commits.push(callback) }, cancelable: true });
    if (!document.dispatchEvent(event)) return cancelled();
    for (const guard of guards) if (!await guard() || version !== navigationVersion) return cancelled();
    if (version !== navigationVersion) return cancelled();
    closeMenus();
    for (const commit of commits) commit();
    mainTab = next;
    $('companiesPanel').hidden = mainTab !== 'companies'; $('mapPanel').hidden = mainTab !== 'map';
    document.querySelectorAll('[data-main-tab]').forEach(button => {
      const active = button.dataset.mainTab === mainTab;
      button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    try { history.replaceState(null, '', '#' + mainTab); } catch {}
    document.dispatchEvent(new CustomEvent('crm:tab', { detail: { tab: mainTab } }));
    return true;
  }
  $('themeToggle').addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('atlas.theme', theme); } catch {} appearance(); });
  $('languageToggle').addEventListener('click', () => I18n.setLanguage(I18n.language() === 'pl' ? 'en' : 'pl'));
  // Capture pointer events before the map or its controls can stop propagation.
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('focusin', dismissOutside, true);
  document.addEventListener('click', event => {
    dismissOutside(event);
    const action = event.target.closest?.('[data-close-dropdown]');
    if (action && dropdowns().some(menu => menu.contains(action))) closeMenus();
  }, true);
  document.addEventListener('toggle', event => {
    const menu = event.target;
    if (!menu.open || !dropdowns().includes(menu)) return;
    closeMenus(menu);
    document.dispatchEvent(new CustomEvent('crm:menu-open'));
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || root.PanelDialogs?.isOpen() || document.querySelector?.('dialog[open]')) return;
    const menu = dropdowns().find(item => item.open);
    if (!menu) return;
    event.preventDefault(); event.stopImmediatePropagation();
    closeMenus(); menu.querySelector('summary')?.focus();
  }, true);
  document.querySelectorAll('[data-main-tab]').forEach(button => {
    button.addEventListener('click', () => showTab(button.dataset.mainTab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); return showTab(event.key === 'Home' ? 'map' : event.key === 'End' ? 'companies' : mainTab === 'companies' ? 'map' : 'companies', true);
    });
  });
  document.addEventListener('crm:language', appearance);
  root.addEventListener('hashchange', () => showTab(root.location.hash === '#map' ? 'map' : 'companies'));
  root.PanelUI = { showTab, closeMenus };
  appearance(); showTab(root.location.hash === '#map' ? 'map' : 'companies');
})(globalThis);
