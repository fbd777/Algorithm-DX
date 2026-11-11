/**
 * AtCoder Problems difficulty -> Codeforces problem-rating scale.
 *
 * `problem-models.json` stores the estimator's internal difficulty.  The
 * AtCoder Problems frontend applies a non-linear display correction below 400;
 * keep that correction here before converting scales.
 *
 * The cross-platform conversion is deliberately versioned.  It uses the
 * open-source SilverFoxxxy Rating Converter fit, based on 4,517 linked
 * AtCoder/Codeforces accounts with at least seven contests on both platforms:
 * https://github.com/SilverFoxxxy/SilverFoxxxy.github.io/blob/main/converter.js
 * Future calibrations must add a new version instead of silently changing
 * historical meaning in unrelated code.
 */
export const ATCODER_CF_MAPPING_VERSION = 'silverfoxxxy-2021-v1';

const SOURCE_ATCODER_MIN = -940;
const SOURCE_ATCODER_MAX = 4215;
const SOURCE_CODEFORCES_MIN = 0;
const SOURCE_CODEFORCES_MAX = 3900;

export function displayedAtCoderDifficulty(rawDifficulty: number): number {
  if (!Number.isFinite(rawDifficulty)) throw new Error('AtCoder difficulty must be finite');
  return Math.round(rawDifficulty >= 400
    ? rawDifficulty
    : 400 / Math.exp(1 - rawDifficulty / 400));
}

export function atCoderDifficultyToCodeforces(rawDifficulty: number): number {
  const displayed = displayedAtCoderDifficulty(rawDifficulty);
  const converted = SOURCE_CODEFORCES_MIN
    + (displayed - SOURCE_ATCODER_MIN)
      * (SOURCE_CODEFORCES_MAX - SOURCE_CODEFORCES_MIN)
      / (SOURCE_ATCODER_MAX - SOURCE_ATCODER_MIN);
  // Match the source converter's integer truncation. The DX T97 curve accepts
  // arbitrary integer difficulty and interpolates continuously, so rounding to
  // Codeforces' usual 100-point problem buckets would only discard information.
  return Math.max(800, Math.min(3500, Math.trunc(converted)));
}
