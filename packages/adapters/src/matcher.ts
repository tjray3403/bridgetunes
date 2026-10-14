import type { Track } from './types.js';

export function cleanTrackTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\([^)]*remaster[^)]*\)/g, '')
    .replace(/\[[^\]]*remaster[^\]]*\]/g, '')
    .replace(/feat\..*$/i, '')
    .replace(/ft\..*$/i, '')
    .trim();
}

export function validateFuzzyMatch(source: Track, candidateDurationMs?: number): boolean {
  if (!source.durationMs || !candidateDurationMs) return true;
  // Allow a 3-second tolerance window on song duration
  const diff = Math.abs(source.durationMs - candidateDurationMs);
  return diff <= 3000;
}
