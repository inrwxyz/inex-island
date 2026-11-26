// Cached DOM references and helper utilities

export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function $$(selector: string, scope: ParentNode = document): Element[] {
  return Array.from(scope.querySelectorAll(selector));
}

export const island: HTMLElement | null = typeof document !== 'undefined' ? $('island') : null;
