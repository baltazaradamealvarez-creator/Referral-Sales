'use strict';

// Let supporting browsers own the picker, selection, labels, and keyboard behavior.
// The optional selected-content button only gives long values a consistent single line.
(() => {
  if (!CSS.supports('appearance', 'base-select') || !('HTMLSelectedContentElement' in window)) return;
  const desktop = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 900px)');
  function decorate(select) {
    if (!desktop.matches || select.multiple || select.firstElementChild?.tagName === 'BUTTON') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'select-value';
    button.append(document.createElement('selectedcontent'));
    select.prepend(button);
  }
  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches('select')) decorate(root);
    root.querySelectorAll('select').forEach(decorate);
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.target instanceof HTMLSelectElement) decorate(record.target);
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  desktop.addEventListener('change', () => { if (desktop.matches) scan(document.body); });
  scan(document.body);
})();
