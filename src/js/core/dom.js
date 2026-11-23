// Cached DOM references and helper utilities

export function $(id) {
  return document.getElementById(id);
}

export function $$(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

export const island = typeof document !== 'undefined' ? $('island') : null;

export function addClass(el, ...classes) {
  if (el) el.classList.add(...classes);
}

export function removeClass(el, ...classes) {
  if (el) el.classList.remove(...classes);
}

export function toggleClass(el, className, force) {
  if (el) return el.classList.toggle(className, force);
  return false;
}
