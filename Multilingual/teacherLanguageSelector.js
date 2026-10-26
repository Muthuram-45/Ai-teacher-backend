/**
 * SkyMeet — Teacher Audio Language Selector & Normalizer
 *
 * Deterministic rules for selecting teacher AI audio language based on
 * actual student preferences in a classroom session:
 * 1. Tamil (ta / ta-IN) is always preferred if any student selected Tamil.
 * 2. Otherwise, use a configurable preferred-language priority list
 *    (e.g., ['ta', 'ml', 'hi', 'te', 'kn', 'en']) containing only
 *    supported languages actually selected by students in the current session.
 * 3. If no configured preference matches, choose one of the selected languages
 *    using a deterministic fallback (most frequent, with stable alphabetical tie-breaker).
 * 4. Never select a language absent from students' language preferences.
 * 5. If no student preferences are available, do not silently generate English audio.
 *    Handle using a documented default or return a clear error state.
 */

// Canonical 2-letter codes for supported languages
const SUPPORTED_LANGUAGE_CODES = ['ta', 'ml', 'hi', 'te', 'kn', 'en'];

// Human-readable and locale alias mapping to canonical codes
const LANGUAGE_ALIASES = {
  // Tamil
  'ta': 'ta',
  'tamil': 'ta',
  'ta-in': 'ta',
  'ta_in': 'ta',
  'tam': 'ta',

  // Malayalam
  'ml': 'ml',
  'malayalam': 'ml',
  'ml-in': 'ml',
  'ml_in': 'ml',
  'mal': 'ml',

  // Hindi
  'hi': 'hi',
  'hindi': 'hi',
  'hi-in': 'hi',
  'hi_in': 'hi',
  'hin': 'hi',

  // Telugu
  'te': 'te',
  'telugu': 'te',
  'te-in': 'te',
  'te_in': 'te',
  'tel': 'te',

  // Kannada
  'kn': 'kn',
  'kannada': 'kn',
  'kn-in': 'kn',
  'kn_in': 'kn',
  'kan': 'kn',

  // English
  'en': 'en',
  'english': 'en',
  'en-us': 'en',
  'en_us': 'en',
  'en-in': 'en',
  'en_in': 'en',
  'en-gb': 'en',
  'en_gb': 'en',
  'eng': 'en'
};

/**
 * Normalizes any language string/code/locale into a canonical code (e.g. 'ta', 'ml', 'hi').
 * 'Tamil', 'ta', 'ta-IN', and 'ta_IN' all normalize to 'ta'.
 *
 * @param {string} lang
 * @returns {string|null}
 */
function normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return null;
  const cleaned = lang.trim().toLowerCase();
  if (!cleaned) return null;

  if (LANGUAGE_ALIASES[cleaned]) {
    return LANGUAGE_ALIASES[cleaned];
  }

  // Handle prefix matches like 'ta-...' or 'ml-...'
  const base = cleaned.split(/[-_]/)[0];
  if (LANGUAGE_ALIASES[base]) {
    return LANGUAGE_ALIASES[base];
  }

  return cleaned;
}

/**
 * Default preferred language priority list.
 * Can be configured via TEACHER_PREFERRED_LANGUAGES env var (comma-separated).
 */
function getPreferredPriorityList() {
  const envList = process.env.TEACHER_PREFERRED_LANGUAGES;
  if (envList && typeof envList === 'string') {
    const parsed = envList
      .split(',')
      .map(s => normalizeLanguage(s))
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  // Default configured order: Tamil > Malayalam > Hindi > Telugu > Kannada > English
  return ['ta', 'ml', 'hi', 'te', 'kn', 'en'];
}

/**
 * Selects the optimal teacher audio language from an array of student language preferences.
 *
 * @param {string[]|object} studentLanguages - Array of language strings OR { studentId: lang } object
 * @param {object} options
 * @param {string[]} [options.preferredPriority] - Override priority order
 * @param {string|null} [options.documentedDefault] - Fallback when NO students are in session (default: null)
 * @param {boolean} [options.allowDocumentedDefault] - Whether documented default is permitted (default: false)
 * @returns {{
 *   language: string|null,
 *   uniqueSelected: string[],
 *   counts: object,
 *   ruleMatched: string,
 *   error?: string,
 *   message?: string
 * }}
 */
function selectTeacherLanguage(studentLanguages, options = {}) {
  const {
    preferredPriority = getPreferredPriorityList(),
    documentedDefault = process.env.DEFAULT_SESSION_LANGUAGE || null,
    allowDocumentedDefault = false
  } = options;

  // Extract raw list
  let rawList = [];
  if (Array.isArray(studentLanguages)) {
    rawList = studentLanguages;
  } else if (studentLanguages && typeof studentLanguages === 'object') {
    rawList = Object.values(studentLanguages);
  }

  // 1. Normalize and count student languages
  const counts = {};
  const normalizedLangs = [];

  for (const raw of rawList) {
    const norm = normalizeLanguage(raw);
    if (norm) {
      normalizedLangs.push(norm);
      counts[norm] = (counts[norm] || 0) + 1;
    }
  }

  const uniqueSelected = Array.from(new Set(normalizedLangs));

  // 2. Handle empty student languages case
  if (uniqueSelected.length === 0) {
    if (allowDocumentedDefault && documentedDefault) {
      const normDefault = normalizeLanguage(documentedDefault);
      return {
        language: normDefault,
        uniqueSelected: [],
        counts: {},
        ruleMatched: 'DOCUMENTED_DEFAULT',
        message: `No active student languages. Using documented default '${normDefault}'.`
      };
    }

    return {
      language: null,
      uniqueSelected: [],
      counts: {},
      ruleMatched: 'NONE',
      error: 'NO_STUDENT_LANGUAGES_AVAILABLE',
      message: 'No student language preferences available in session. Cannot silently generate English audio.'
    };
  }

  const selectedSet = new Set(uniqueSelected);

  // 3. Rule 1: Tamil (ta) is ALWAYS preferred if any student selected Tamil
  if (selectedSet.has('ta')) {
    return {
      language: 'ta',
      uniqueSelected,
      counts,
      ruleMatched: 'RULE_1_TAMIL_PRIORITY'
    };
  }

  // 4. Rule 2: Configurable preferred-language priority list
  // Only considers languages actually selected by students in current session
  for (const pref of preferredPriority) {
    const normPref = normalizeLanguage(pref);
    if (normPref && selectedSet.has(normPref)) {
      return {
        language: normPref,
        uniqueSelected,
        counts,
        ruleMatched: `RULE_2_PREFERRED_PRIORITY (${normPref})`
      };
    }
  }

  // 5. Rule 3: Deterministic fallback among selected languages
  // Sort by count DESC, tie-breaker: alphabetical ASC
  const sorted = [...uniqueSelected].sort((a, b) => {
    const countA = counts[a] || 0;
    const countB = counts[b] || 0;
    if (countB !== countA) {
      return countB - countA;
    }
    return a.localeCompare(b);
  });

  const chosen = sorted[0];

  // 6. Rule 4: Verification — ensure chosen language is strictly from selectedSet
  if (!selectedSet.has(chosen)) {
    return {
      language: null,
      uniqueSelected,
      counts,
      ruleMatched: 'ERROR',
      error: 'INVALID_SELECTION',
      message: `Selected language '${chosen}' is absent from students' language preferences.`
    };
  }

  return {
    language: chosen,
    uniqueSelected,
    counts,
    ruleMatched: 'RULE_3_FREQUENCY_FALLBACK'
  };
}

module.exports = {
  SUPPORTED_LANGUAGE_CODES,
  LANGUAGE_ALIASES,
  normalizeLanguage,
  getPreferredPriorityList,
  selectTeacherLanguage
};
