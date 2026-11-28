// Breeding mode: a company setting. When it is on, it overrides the personal
// field settings of all members for the breeding ratings.

export const BREEDING_SYSTEMS = ['beebreed'] as const;
export type BreedingSystem = (typeof BREEDING_SYSTEMS)[number];

// Ratings that the breeding mode shows, and the scale of the breeding
// systems (1 worst to 4 best).
export const BREEDING_RATINGS = [
  'temper',
  'calm_comb',
  'swarm',
  'colony_strength',
  'spring_development'
] as const;
export const BREEDING_RATING_MAX = 4;

// Harvest sections of the breeding export (BeeBreed TEIL1, TEIL2, TEIL3 and
// VORRAT). The admin maps each harvest type to one section, or to none.
export const BREEDING_SECTIONS = ['early', 'summer', 'late', 'stock'] as const;
export type BreedingSection = (typeof BREEDING_SECTIONS)[number];

// BeeBreed queen code: country, association, breeder, number, birth year,
// separated by hyphens. Example: DE-44-101-1-2025.
const BEEBREED_CODE = /^([A-Z]{2})-(\d{1,2})-(\d{1,3})-(\d{1,5})-(\d{4})$/;

/**
 * Checks a queen name against the code format of the breeding system.
 * Returns the reason of the first problem, or null if the name is valid.
 * The year part must be the birth year, when the birth date is known.
 */
export function checkBreedingCode(
  system: BreedingSystem,
  name: string,
  birthDate?: string | null
): 'format' | 'year' | null {
  if (system !== 'beebreed') {
    return null;
  }
  const match = BEEBREED_CODE.exec(name.trim());
  if (!match) {
    return 'format';
  }
  // BeeBreed numbers start at 1.
  if (match.slice(2, 5).some(part => Number(part) === 0)) {
    return 'format';
  }
  if (birthDate && match[5] !== birthDate.slice(0, 4)) {
    return 'year';
  }
  return null;
}
