// Extensible Animation Registry for Inex Island
// Categories & options are discovered dynamically by both runtime playback and Settings UI.

export const ANIMATION_CATEGORIES = [
  {
    key: 'tray',
    label: 'Tray Drop',
    desc: 'Plays when files are dropped onto the tray',
    defaultId: 'bounce'
  },
  {
    key: 'receive',
    label: 'File Receive',
    desc: 'Plays on incoming offers, accept, and download save',
    defaultId: 'radar'
  },
  {
    key: 'send',
    label: 'File Send / Share',
    desc: 'Plays across active file send and receive progress',
    defaultId: 'beam'
  }
];

const _anims = new Map(); // `${category}:${id}` -> anim definition

export function registerAnimation(anim) {
  if (!anim || !anim.category || !anim.id) return;
  _anims.set(`${anim.category}:${anim.id}`, anim);
}

export function getAnimation(category, id) {
  return _anims.get(`${category}:${id}`) || null;
}

export function listAnimations(category) {
  const out = [];
  for (const a of _anims.values()) {
    if (!category || a.category === category) out.push(a);
  }
  return out;
}
