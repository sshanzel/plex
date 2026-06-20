import { slugify, hashId } from '@plex/core';
import type { RawComment } from './types';

export interface ClusterInput {
  comments: RawComment[];
  centroid: number[];
  /** Origin repo — stamped on the resulting pitfall for scope filtering. */
  repo?: string;
}

/** Collision-free pitfall id: optional repo + readable title slug + title hash. */
export function distilledPitfallId(title: string, repo?: string): string {
  return `pf:analyzed:${repo ? slugify(repo) + ':' : ''}${slugify(title, 56) || 'p'}-${hashId(title)}`;
}
