class LanguageRouter {
  constructor() {
    // Mapping from roomName to a map of languages and their reference counts
    // e.g., { 'Room1': { 'ta': 2, 'hi': 1 } }
    this.rooms = {};
  }

  addStudent(roomName, studentId, language) {
    if (language === 'en') return; // Default/original audio, no need to track for translation

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

    room.students[studentId] = language;

    if (!room.languages[language]) {
      room.languages[language] = 0;
    }
    room.languages[language]++;
    
    console.log(`[LanguageRouter] Student ${studentId} added/switched to ${language} in ${roomName}. Active count for ${language}: ${room.languages[language]}`);
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
    if (!this.rooms[roomName]) return [];
    return Object.keys(this.rooms[roomName].languages);
  }

  destroyRoom(roomName) {
    if (this.rooms[roomName]) {
      delete this.rooms[roomName];
    }
  }
}

module.exports = new LanguageRouter();
