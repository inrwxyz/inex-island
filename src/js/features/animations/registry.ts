// Extensible Animation Registry for Inex Island
export type AnimationCategoryKey = 'tray' | 'receive' | 'send';

export interface AnimationModule {
  id: string;
  category: AnimationCategoryKey;
  label: string;
  desc: string;
  play?: (payload?: Record<string, unknown>) => void;
  isStreaming?: () => boolean;
  onIncoming?: (meta?: Record<string, unknown>) => void;
  onOfferClosed?: () => void;
  onAccepted?: (meta?: Record<string, unknown>) => void;
  onStart?: (meta?: Record<string, unknown>) => void;
  onProgress?: (pct?: number, dir?: string) => void;
  onFinish?: (ok?: boolean) => void;
}

const _anims = new Map<string, AnimationModule>();

export function registerAnimation(anim: AnimationModule | null | undefined): void {
  if (!anim || !anim.category || !anim.id) return;
  _anims.set(`${anim.category}:${anim.id}`, anim);
}

export function getAnimation(category: string, id: string): AnimationModule | null {
  return _anims.get(`${category}:${id}`) || null;
}
