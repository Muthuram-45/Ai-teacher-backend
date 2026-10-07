class LanguageRouter {
  constructor() {
    // Mapping from roomName to a map of languages and their reference counts
    // e.g., { 'Room1': { 'ta': 2, 'hi': 1, 'en': 1 } }
    this.rooms = {};
  }

  addStudent(roomName, studentId, language) {
    if (!this.rooms[roomName]) {
      this.rooms[roomName] = {
        languages: {},
        students: {} // studentId -> language
      };
    }

    const room = this.rooms[roomName];
    
    // If student already has a language, remove the old one first
    if (room.students[studentId]) {
      this.removeStudent(roomName, studentId);
    }

    const targetLang = language || 'en';
    room.students[studentId] = targetLang;

    if (!room.languages[targetLang]) {
      room.languages[targetLang] = 0;
    }
    room.languages[targetLang]++;
    
    console.log(`[LanguageRouter] Student ${studentId} added/switched to ${targetLang} in ${roomName}. Active count for ${targetLang}: ${room.languages[targetLang]}`);
  }

  removeStudent(roomName, studentId) {
    if (!this.rooms[roomName]) return;

    const room = this.rooms[roomName];
    const language = room.students[studentId];

    if (language) {
      delete room.students[studentId];
      if (room.languages[language] > 0) {
        room.languages[language]--;
        
        console.log(`[LanguageRouter] Student ${studentId} removed from ${language} in ${roomName}. Active count for ${language}: ${room.languages[language]}`);
        
        if (room.languages[language] === 0) {
          delete room.languages[language];
          console.log(`[LanguageRouter] No more active students for ${language} in ${roomName}. Stream can be stopped.`);
        }
      }
    }
  }

  getActiveLanguages(roomName) {
    if (!this.rooms[roomName]) return ['en'];
    const langs = Object.keys(this.rooms[roomName].languages || {});
    return langs.length > 0 ? langs : ['en'];
  }

  getStudentsInRoom(roomName) {
    if (!this.rooms[roomName] || !this.rooms[roomName].students) return [];
    return Object.entries(this.rooms[roomName].students).map(([studentId, language]) => ({
      studentId,
      language
    }));
  }

  getStudentLanguage(roomName, studentId) {
    if (!this.rooms[roomName] || !this.rooms[roomName].students) return 'en';
    return this.rooms[roomName].students[studentId] || 'en';
  }

  destroyRoom(roomName) {
    if (this.rooms[roomName]) {
      delete this.rooms[roomName];
    }
  }
}

module.exports = new LanguageRouter();
