const {
  normalizeLanguage,
  selectTeacherLanguage,
  SUPPORTED_LANGUAGE_CODES
} = require('./teacherLanguageSelector');

class LanguageRouter {
  constructor() {
    // Mapping from roomName to a map of languages and their reference counts
    // e.g., { 'Room1': { languages: { 'ta': 2, 'ml': 1 }, students: { 's1': 'ta', 's2': 'ta', 's3': 'ml' } } }
    this.rooms = {};
  }

  /**
   * Registers or updates a student's preferred language in a room.
   * Normalizes the language code (e.g. 'ta-IN', 'Tamil' -> 'ta').
   * Does NOT silently default to English.
   */
  addStudent(roomName, studentId, language) {
    if (!roomName || !studentId) return;

    if (!this.rooms[roomName]) {
      this.rooms[roomName] = {
        languages: {},
        students: {} // studentId -> normalized language
      };
    }

    const room = this.rooms[roomName];

    // If student already has a language, remove the old one first
    if (room.students[studentId]) {
      this.removeStudent(roomName, studentId);
    }

    const targetLang = normalizeLanguage(language);
    if (!targetLang) {
      console.warn(`[LanguageRouter] Ignored invalid language registration for student ${studentId} in ${roomName}: "${language}"`);
      return;
    }

    room.students[studentId] = targetLang;

    if (!room.languages[targetLang]) {
      room.languages[targetLang] = 0;
    }
    room.languages[targetLang]++;

    console.log(
      `[LanguageRouter] Student ${studentId} added/switched to ${targetLang} in ${roomName}. ` +
      `Active count for ${targetLang}: ${room.languages[targetLang]}`
    );
  }

  /**
   * Unregisters a student from a room.
   */
  removeStudent(roomName, studentId) {
    if (!this.rooms[roomName]) return;

    const room = this.rooms[roomName];
    const language = room.students[studentId];

    if (language) {
      delete room.students[studentId];
      if (room.languages[language] > 0) {
        room.languages[language]--;

        console.log(
          `[LanguageRouter] Student ${studentId} removed from ${language} in ${roomName}. ` +
          `Active count for ${language}: ${room.languages[language]}`
        );

        if (room.languages[language] === 0) {
          delete room.languages[language];
          console.log(`[LanguageRouter] No more active students for ${language} in ${roomName}. Stream can be stopped.`);
        }
      }
    }
  }

  /**
   * Returns ONLY the unique languages actually selected by students currently in the room.
   * Never injects 'en' unless a student in the room actually selected English.
   */
  getActiveLanguages(roomName) {
    if (!this.rooms[roomName] || !this.rooms[roomName].languages) return [];
    return Object.keys(this.rooms[roomName].languages);
  }

  /**
   * Selects the teacher audio language for the room session based on the deterministic
   * priority rules (Tamil priority > preferred list > deterministic fallback).
   *
   * @param {string} roomName
   * @param {object} [options]
   * @returns {{
   *   language: string|null,
   *   uniqueSelected: string[],
   *   counts: object,
   *   ruleMatched: string,
   *   error?: string
   * }}
   */
  getTeacherAudioLanguage(roomName, options = {}) {
    const studentLanguages = this.rooms[roomName]?.students
      ? Object.values(this.rooms[roomName].students)
      : [];

    return selectTeacherLanguage(studentLanguages, options);
  }

  /**
   * Returns a complete diagnostics summary for a room.
   */
  getRoomSummary(roomName) {
    const activeLanguages = this.getActiveLanguages(roomName);
    const teacherSelection = this.getTeacherAudioLanguage(roomName);
    const students = this.getStudentsInRoom(roomName);

    return {
      roomName,
      studentCount: students.length,
      activeLanguages,
      languageCounts: this.rooms[roomName]?.languages ? { ...this.rooms[roomName].languages } : {},
      teacherAudioLanguage: teacherSelection.language,
      teacherLanguageDetails: teacherSelection,
      students
    };
  }

  getStudentsInRoom(roomName) {
    if (!this.rooms[roomName] || !this.rooms[roomName].students) return [];
    return Object.entries(this.rooms[roomName].students).map(([studentId, language]) => ({
      studentId,
      language
    }));
  }

  getStudentLanguage(roomName, studentId) {
    if (!this.rooms[roomName] || !this.rooms[roomName].students) return null;
    return this.rooms[roomName].students[studentId] || null;
  }

  destroyRoom(roomName) {
    if (this.rooms[roomName]) {
      delete this.rooms[roomName];
    }
  }
}

module.exports = new LanguageRouter();
