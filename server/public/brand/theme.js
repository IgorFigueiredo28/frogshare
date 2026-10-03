// Light/dark theme: follows the OS by default; the [data-theme-toggle] button overrides it.
// The override is dropped when it matches the OS or when the OS theme changes, so the app
// goes back to following the system instead of being stuck on an old choice.
// Loaded in <head> without defer so the right theme applies before the first paint.
(function () {
  var KEY = 'fs-theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function systemTheme() { return media.matches ? 'dark' : 'light'; }

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  function current() { return root.getAttribute('data-theme') || systemTheme(); }

  function save(theme) {
    try {
      if (theme) localStorage.setItem(KEY, theme);
      else localStorage.removeItem(KEY);
    } catch (e) {}
  }

  function label(btn) {
    var next = current() === 'dark' ? 'claro' : 'escuro';
    var following = !root.getAttribute('data-theme');
    var text = 'Usar tema ' + next + (following ? ' (agora seguindo o sistema)' : '');
    btn.setAttribute('aria-label', text);
    btn.title = text;
  }

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === systemTheme()) { saved = null; save(null); }
  apply(saved);

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    function relabel() { buttons.forEach(label); }

    buttons.forEach(function (btn) {
      label(btn);
      btn.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        // Picking the system's own theme means "follow the system" again
        var override = next === systemTheme() ? null : next;
        apply(override);
        save(override);
        relabel();
      });
    });

    media.addEventListener('change', function () {
      apply(null);
      save(null);
      relabel();
    });
  });
})();
