// Light/dark theme: follows the OS unless the person picked one with a [data-theme-toggle] button.
// Loaded in <head> without defer so the saved theme applies before the first paint.
(function () {
  var KEY = 'fs-theme';
  var root = document.documentElement;

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  function current() {
    return root.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function label(btn) {
    var dark = current() === 'dark';
    var text = dark ? 'Usar tema claro' : 'Usar tema escuro';
    btn.setAttribute('aria-label', text);
    btn.title = text;
  }

  try { apply(localStorage.getItem(KEY)); } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    buttons.forEach(function (btn) {
      label(btn);
      btn.addEventListener('click', function () {
        var next = current() === 'dark' ? 'light' : 'dark';
        apply(next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
        buttons.forEach(label);
      });
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      buttons.forEach(label);
    });
  });
})();
