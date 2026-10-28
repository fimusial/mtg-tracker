// Keeps the course of each match in a file of its own, named after the match, when
// it started (local time) and the opponent:
// courses/<matchId>_<YYYY-MM-DD>_<HH-MM>_<opponent>.json
// Courses are recorded from Player.log while the log still holds the match.

const fs = require('fs');
const path = require('path');
const { COURSE_VERSION, ARENA_MATCH_ID, parseCourse } = require('./courseParser');

class CourseStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'courses');
    this.files = null;
    this.storedVersions = new Map();
    this.searchedLogs = new Map();
    this.empty = new Set();
  }

  index() {
    if (this.files) {
      return this.files;
    }

    this.files = new Map();
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      return this.files;
    }

    for (const name of names) {
      const matchId = name.slice(0, 36);
      if (!name.endsWith('.json') || !ARENA_MATCH_ID.test(matchId)) {
        continue;
      }
      this.files.set(matchId, name);
    }
    return this.files;
  }

  readFile(name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
    } catch (e) {
      return null;
    }
  }

  load(matchId) {
    if (!ARENA_MATCH_ID.test(matchId || '')) {
      return null;
    }
    const name = this.index().get(matchId);
    const course = name ? this.readFile(name) : null;
    this.storedVersions.set(matchId, course ? course.version : null);
    return course;
  }

  isCurrent(matchId) {
    if (!this.storedVersions.has(matchId)) {
      this.load(matchId);
    }
    return this.storedVersions.get(matchId) === COURSE_VERSION;
  }

  save(course) {
    try {
      const files = this.index();
      fs.mkdirSync(this.dir, { recursive: true });

      const name = courseFileName(course);
      const file = path.join(this.dir, name);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(course));
      fs.renameSync(`${file}.tmp`, file);

      const previous = files.get(course.matchId);
      if (previous && previous !== name) {
        fs.rmSync(path.join(this.dir, previous), { force: true });
      }
      files.set(course.matchId, name);
      this.storedVersions.set(course.matchId, course.version);
      console.log(`[Course] Saved ${name}: ${course.games.length} game(s)`);
    } catch (error) {
      console.error('[Course] Error saving course:', error.message);
    }
  }

  record(logText, matchId) {
    const course = parseCourse(logText, matchId);
    if (course) {
      this.save(course);
      this.empty.delete(matchId);
    } else {
      this.empty.add(matchId);
    }
    return course;
  }

  recordFromEvents(logText, events, keptMatchIds) {
    for (const event of events) {
      const matchId = event.type === 'MATCH_END' ? event.data.matchId : null;
      if (ARENA_MATCH_ID.test(matchId || '') && keptMatchIds.has(matchId) &&
          !this.isCurrent(matchId) && !this.empty.has(matchId)) {
        this.record(logText, matchId);
      }
    }
  }

  async recordFromLogs(logPaths, matchIds) {
    const missing = () => matchIds.filter(matchId => ARENA_MATCH_ID.test(matchId || '') && !this.isCurrent(matchId));

    for (const logPath of logPaths) {
      if (missing().length === 0) {
        return;
      }
      const logText = await readLog(logPath);
      for (const matchId of missing()) {
        if (logText && logText.includes(matchId)) {
          this.record(logText, matchId);
        }
      }
    }
  }

  async get(matchId, logPaths) {
    if (!ARENA_MATCH_ID.test(matchId || '')) {
      return null;
    }
    if (this.isCurrent(matchId)) {
      return this.load(matchId);
    }

    const signature = logSignature(logPaths);
    if (this.searchedLogs.get(matchId) !== signature) {
      for (const logPath of logPaths) {
        const logText = await readLog(logPath);
        const course = logText && logText.includes(matchId) ? this.record(logText, matchId) : null;
        if (course) {
          return course;
        }
      }
      this.searchedLogs.set(matchId, signature);
    }

    return this.load(matchId);
  }

  delete(matchId) {
    if (!ARENA_MATCH_ID.test(matchId || '')) {
      return;
    }
    const files = this.index();
    const name = files.get(matchId);
    if (name) {
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
        files.delete(matchId);
      } catch (error) {
        console.error('[Course] Error deleting course:', error.message);
      }
    }
    this.storedVersions.set(matchId, null);
  }

  prune(keptMatchIds) {
    for (const matchId of Array.from(this.index().keys())) {
      if (!keptMatchIds.has(matchId)) {
        this.delete(matchId);
      }
    }
  }

  clear() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch (error) {
      console.error('[Course] Error deleting courses:', error.message);
    }
    this.files = new Map();
    this.storedVersions.clear();
    this.searchedLogs.clear();
  }
}

function courseFileName(course) {
  const opponent = course.localSeat === null || course.localSeat === undefined
    ? null
    : (course.players || []).find(player => player.seat !== course.localSeat)?.name;
  const started = new Date(course.games?.[0]?.startedAt || NaN);
  const pad = value => String(value).padStart(2, '0');
  const stamp = Number.isNaN(started.getTime())
    ? 'unknown-date'
    : `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}_${pad(started.getHours())}-${pad(started.getMinutes())}`;

  return `${course.matchId}_${stamp}_${safeFileText(opponent)}.json`;
}

function safeFileText(text) {
  const safe = String(text || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 40);
  return safe || 'Unknown';
}

async function readLog(logPath) {
  try {
    return await fs.promises.readFile(logPath, 'utf8');
  } catch (e) {
    return null;
  }
}

function logSignature(logPaths) {
  return logPaths.map(logPath => {
    try {
      const stats = fs.statSync(logPath);
      return `${stats.size}@${stats.mtimeMs}`;
    } catch (e) {
      return 'missing';
    }
  }).join('|');
}

function courseCardIds(course) {
  const ids = new Set();
  for (const game of course?.games || []) {
    for (const line of game.lines) {
      for (const part of line.parts || []) {
        if (part && typeof part === 'object' && part.card !== undefined) {
          ids.add(part.card);
        }
      }
    }
  }
  return Array.from(ids);
}

module.exports = { CourseStore, courseCardIds };
