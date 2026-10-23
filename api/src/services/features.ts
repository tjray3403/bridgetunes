export type MusicFeatureFlags = {
  spotify: boolean;
  appleMusic: boolean;
};

function enabledUnlessFalse(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return true;
  return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
}

// These are operator controls set in the API environment (for example, Render).
// Both integrations stay enabled by default to preserve current behavior.
export function getMusicFeatureFlags(): MusicFeatureFlags {
  return {
    spotify: enabledUnlessFalse(process.env.ENABLE_SPOTIFY),
    appleMusic: enabledUnlessFalse(process.env.ENABLE_APPLE_MUSIC),
  };
}
