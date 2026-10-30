const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

const GRE_CARD_COLORS = {
  CardColor_White: 'W',
  CardColor_Blue: 'U',
  CardColor_Black: 'B',
  CardColor_Red: 'R',
  CardColor_Green: 'G'
};

class LogParser {
  constructor() {
    this.currentMatch = null;
    this.matchStartTime = null;
    this.processedEvents = new Set();
    this.pendingResult = null;
    this.deckNames = new Map();
    this.deckNamesById = new Map();
    this.courses = [];
    this.deckMessages = [];
    this.decksByCardList = new Map();
    this.revealedCards = [];
    this.objectIdChanges = [];
    this.deckCards = null;
    this.playerSeatId = 1;
    this.playerTeamId = 1;
    this.localUserId = null;
    this.localScreenName = null;
  }

  parse(data) {
    const events = [];
    const lines = data.split('\n');

    this.currentMatch = null;
    this.matchStartTime = null;
    this.pendingResult = null;
    this.playerSeatId = 1;
    this.playerTeamId = 1;
    this.revealedCards = [];
    this.objectIdChanges = [];
    this.processedEvents.clear();

    this.extractLocalPlayer(lines);
    this.extractDeckNames(lines);
    this.extractDeckNamesById(lines);
    this.extractCourses(lines);
    this.extractDeckLists(lines);
    this.extractDeckCards(lines);
    this.extractRevealedCards(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const event = this.parseLine(line, lines, i);
      if (event) {
        const matchId = event.data.matchId || 'unknown';
        const result = event.data.result || 'none';

        let eventKey;
        if (event.type === 'MATCH_END') {
          eventKey = `${event.type}_${matchId}_${result}_${event.data.timestamp?.split('T')[0] || 'unknown'}`;
        } else if (event.type === 'INVENTORY_UPDATE') {
          eventKey = `${event.type}_${event.data.timestamp}`;
        } else {
          eventKey = `${event.type}_${matchId}`;
        }

        if (!this.processedEvents.has(eventKey)) {
          this.processedEvents.add(eventKey);
          events.push(event);
        } else {
          console.log(`[Parser] Skipping duplicate event: ${eventKey}`);
        }
      }
    }

    if (this.processedEvents.size > 1000) {
      const entries = Array.from(this.processedEvents).slice(-500);
      this.processedEvents = new Set(entries);
    }

    return events;
  }

  parseLine(line, allLines, index) {
    if (line.includes('STATE CHANGED') && line.includes('"new":"Playing"')) {
      return this.handleMatchStartFromState(line, index);
    }

    if (line.includes('MatchGameRoomStateType') || line.includes('MatchGameRoomState')) {
      if (!this.currentMatch) {
        return this.handleMatchStartFromGameRoom(line, allLines, index);
      }
    }

    if (line.includes('STATE CHANGED') && line.includes('"new":"MatchCompleted"')) {
      return this.handleMatchCompleted(line, allLines, index);
    }

    if (line.includes('OnSceneLoaded for MatchEndScene')) {
      return this.handleMatchEndScene(line, allLines, index);
    }

    if (line.includes('OnExitMatchScene')) {
      return this.handleMatchExit(line);
    }

    if (line.includes('"resultType"') || line.includes('"ResultType"')) {
      return this.handleResultFromJSON(line);
    }

    if (line.includes('"InventoryInfo"')) {
      return this.handleInventoryInfo(line);
    }

    if (line.includes('"gameEndReason"') || line.includes('"winningTeamId"')) {
      return this.handleGameEnd(line);
    }

    return null;
  }

  handleMatchStartFromState(line, index) {
    if (this.currentMatch) {
      return null;
    }

    const match = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = match ? match[1].trim() : new Date().toISOString();

    this.currentMatch = {
      matchId: `match_${Date.now()}`,
      startTime: timestamp,
      startIndex: index,
      format: 'Unknown',
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchStartFromGameRoom(line, allLines, index) {
    const match = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = match ? match[1].trim() : new Date().toISOString();

    const idMatch = line.match(/Match to ([^:]+):/);
    const matchId = idMatch ? idMatch[1].trim() : `match_${Date.now()}`;

    let format = 'Unknown';
    let deckName = 'Unknown Deck';
    let deckId = null;

    for (let i = index; i >= Math.max(0, index - 200); i--) {
      const checkLine = allLines[i];

      if (checkLine.includes('"CourseDeckSummary"')) {
        const summary = this.extractCourseDeckSummary(checkLine);
        if (summary) {
          deckName = summary.name;
          deckId = summary.deckId || deckId;
          console.log(`[Parser] Found deck name from earlier CourseDeckSummary: ${deckName}`);
          break;
        }
      }

      if (checkLine.includes('"Courses"')) {
        const coursesMatch = checkLine.match(/"Courses".*?"Name"\s*:\s*"([^"]+)"/s);
        if (coursesMatch && coursesMatch[1].trim()) {
          deckName = coursesMatch[1].trim();
          console.log(`[Parser] Found deck name from earlier Courses: ${deckName}`);
          break;
        }
      }
    }

    let opponentName = null;
    let playerDeck = null;
    let actualMatchId = matchId;

    for (let i = index; i < Math.min(index + 200, allLines.length); i++) {
      const checkLine = allLines[i];
      if (checkLine.includes('"systemSeatIds"')) {
        const seatMatch = checkLine.match(/"systemSeatIds"\s*:\s*\[\s*(\d+)\s*\]/);
        if (seatMatch) {
          this.playerSeatId = parseInt(seatMatch[1]);
          console.log(`[Parser] Detected player seat ID: ${this.playerSeatId}`);
          break;
        }
      }
    }

    let reservedPlayersData = null;
    let matchEventId = null;
    for (let i = index; i < Math.min(index + 100, allLines.length); i++) {
      const checkLine = allLines[i];

      if (checkLine.includes('"matchId"')) {
        const matchIdMatch = checkLine.match(/"matchId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
        if (matchIdMatch) {
          actualMatchId = matchIdMatch[1];
          console.log(`[Parser] Found actual matchId from JSON: ${actualMatchId}`);
        }
      }

      if (checkLine.includes('"InternalEventName"')) {
        const formatMatch = checkLine.match(/"InternalEventName"\s*:\s*"([^"]+)"/);
        if (formatMatch) {
          format = this.detectFormatFromEventName(formatMatch[1]);

          if (this.deckNames.has(formatMatch[1])) {
            deckName = this.deckNames.get(formatMatch[1]);
            console.log(`[Parser] Using cached deck name: ${deckName}`);
          }
        }
      }
      if (format === 'Unknown' && checkLine.includes('"eventId"')) {
        const eventMatch = checkLine.match(/"eventId"\s*:\s*"([^"]+)"/);
        if (eventMatch) {
          format = this.detectFormatFromEventName(eventMatch[1]);
        }
      }

      if (!matchEventId && checkLine.includes('"gameRoomConfig"')) {
        const roomEventMatch = checkLine.match(/"eventId"\s*:\s*"([^"]+)"/);
        if (roomEventMatch) {
          matchEventId = roomEventMatch[1];
        }
      }

      if (!reservedPlayersData && checkLine.includes('"reservedPlayers"')) {
        const playersMatch = checkLine.match(/"reservedPlayers"\s*:\s*(\[.*?\])/);
        if (playersMatch) {
          reservedPlayersData = playersMatch[1];
        }
      }

      if (checkLine.includes('"CourseName"') || checkLine.includes('"courseName"')) {
        const deckMatch = checkLine.match(/"[Cc]ourseName"\s*:\s*"([^"]+)"/);
        if (deckMatch && deckMatch[1].trim()) {
          deckName = deckMatch[1].trim();
          console.log(`[Parser] Found deck name: ${deckName}`);
        }
      }

      if (checkLine.includes('"DeckName"') || checkLine.includes('"deckName"')) {
        const deckMatch = checkLine.match(/"[Dd]eckName"\s*:\s*"([^"]+)"/);
        if (deckMatch && deckMatch[1].trim()) {
          deckName = deckMatch[1].trim();
          console.log(`[Parser] Found deck name: ${deckName}`);
        }
      }

      if (checkLine.includes('"SubmitDeck"') || checkLine.includes('"submitDeck"')) {
        const submitMatch = checkLine.match(/"[Dd]eck[Nn]ame"\s*:\s*"([^"]+)"/);
        if (submitMatch && submitMatch[1].trim()) {
          deckName = submitMatch[1].trim();
          console.log(`[Parser] Found deck from submission: ${deckName}`);
        }
      }

      if (checkLine.includes('"CourseDeckSummary"')) {
        const summary = this.extractCourseDeckSummary(checkLine);
        if (summary) {
          deckName = summary.name;
          deckId = summary.deckId || deckId;
          console.log(`[Parser] Found deck name from CourseDeckSummary: ${deckName}`);
        }
      }

      if (checkLine.includes('"Courses"') || checkLine.includes('"CourseDeckSummary"')) {
        const deckSummaryMatch = checkLine.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (deckSummaryMatch && deckSummaryMatch[1].trim()) {
          deckName = deckSummaryMatch[1].trim();
          console.log(`[Parser] Found deck name from Courses: ${deckName}`);
        }
      }
    }

    if (reservedPlayersData) {
      try {
        const players = JSON.parse(reservedPlayersData);
        const me = players.find(p => this.isLocalPlayer(p));

        if (me) {
          if (typeof me.systemSeatId === 'number') {
            this.playerSeatId = me.systemSeatId;
          }
          this.playerTeamId = typeof me.teamId === 'number' ? me.teamId : this.playerSeatId;
          console.log(`[Parser] Player is seat ${this.playerSeatId}, team ${this.playerTeamId}`);
        }

        const opponent = me
          ? players.find(p => p !== me)
          : players.find(p => p.systemSeatId !== this.playerSeatId);

        // Better no name than our own: that only ever means we picked wrong.
        if (opponent && !this.isLocalPlayer(opponent)) {
          opponentName = opponent.playerName;
          console.log(`[Parser] Found opponent: ${opponentName} (player is seat ${this.playerSeatId})`);
        } else if (opponent) {
          console.log('[Parser] Only the local player is named - leaving opponent unknown');
        }
      } catch (e) {
        const targetSeat = this.playerSeatId === 1 ? 2 : 1;
        const oppMatch = reservedPlayersData.match(new RegExp(`"playerName"\\s*:\\s*"([^"]+)".*?"systemSeatId"\\s*:\\s*${targetSeat}`));
        if (oppMatch && oppMatch[1] !== this.localScreenName) {
          opponentName = oppMatch[1];
          console.log(`[Parser] Found opponent via regex: ${opponentName}`);
        }
      }
    }

    if (matchEventId) {
      const fromMatchEvent = this.detectFormatFromEventName(matchEventId);
      if (fromMatchEvent !== 'Unknown') {
        format = fromMatchEvent;
      } else if (format === 'Unknown') {
        format = this.prettifyEventName(matchEventId);
      }
      console.log(`[Parser] Format from match event ${matchEventId}: ${format}`);
    }

    if (format === 'Unknown') {
      const course = this.findCourseForMatch(index, deckId);
      if (course) {
        const fromEvent = this.detectFormatFromEventName(course.eventName);
        if (fromEvent !== 'Unknown') {
          format = fromEvent;
        } else if (course.deckFormat) {
          format = course.deckFormat;
        } else {
          format = this.prettifyEventName(course.eventName);
        }
        console.log(`[Parser] Format from course ${course.eventName}: ${format}`);
      }
    }

    playerDeck = playerDeck || this.findDeckForMatch(index);

    const submittedDeck = playerDeck ? this.identifyDeck(playerDeck.deckCards) : null;
    if (submittedDeck) {
      if (submittedDeck.deckId !== deckId) {
        console.log(`[Parser] Deck identified from its cards: ${submittedDeck.name || submittedDeck.deckId}`);
      }
      deckId = submittedDeck.deckId;
      if (submittedDeck.name) {
        deckName = submittedDeck.name;
      }
    }

    const loggedDeckName = deckName;
    deckName = this.resolveDeckName(deckName, deckId);

    this.currentMatch = {
      matchId: actualMatchId,
      startTime: timestamp,
      startIndex: index,
      format: format,
      deckName: deckName,
      deckNameKey: deckName !== loggedDeckName ? loggedDeckName : null,
      arenaDeckId: deckId,
      opponentName: opponentName,
      playerDeck: playerDeck,
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchCompleted(line, allLines, index) {
    if (!this.currentMatch) return null;

    let result = this.resultFromFinalMatchResult(this.findFinalMatchResult(
      allLines,
      (this.currentMatch.startIndex || index) - 10,
      index + 20,
      this.currentMatch.matchId
    ));

    if (result !== 'unknown') {
      console.log(`[Parser] Match end (finalMatchResult): result=${result}, playerTeam=${this.playerTeamId}`);
    } else {
      result = this.pendingResult || 'unknown';
    }

    for (let i = index + 1; result === 'unknown' && i < Math.min(index + 20, allLines.length); i++) {
      const nextLine = allLines[i];

      if (nextLine.includes('Victory') || nextLine.includes('"resultType":"Victory"')) {
        result = 'win';
        break;
      }
      if (nextLine.includes('Defeat') || nextLine.includes('"resultType":"Defeat"')) {
        result = 'loss';
        break;
      }
      if (nextLine.includes('Draw') || nextLine.includes('"resultType":"Draw"')) {
        result = 'draw';
        break;
      }

      if (nextLine.includes('"winningTeamId"')) {
        const teamMatch = nextLine.match(/"winningTeamId"\s*:\s*(\d+)/);
        if (teamMatch) {
          const winningTeam = parseInt(teamMatch[1]);

          const playerTeam = this.playerTeamId;
          result = winningTeam === playerTeam ? 'win' : 'loss';
          console.log(`[Parser] Match end (lookahead): winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);
          break;
        }
      }
    }

    if (result === 'unknown') {
      for (let i = Math.max(0, index - 50); i < index; i++) {
        const prevLine = allLines[i];
        if (prevLine.includes('Victory') || prevLine.includes('"resultType":"Victory"')) {
          result = 'win';
          break;
        }
        if (prevLine.includes('Defeat') || prevLine.includes('"resultType":"Defeat"')) {
          result = 'loss';
          break;
        }
        if (prevLine.includes('"resultType":"Draw"') || prevLine.includes('ResultType_Draw')) {
          result = 'draw';
          break;
        }
        if (prevLine.includes('"winningTeamId"')) {
          const teamMatch = prevLine.match(/"winningTeamId"\s*:\s*(\d+)/);
          if (teamMatch) {
            const winningTeam = parseInt(teamMatch[1]);

            const playerTeam = this.playerTeamId;
            result = winningTeam === playerTeam ? 'win' : 'loss';
            console.log(`[Parser] Match end (lookback): winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);
            break;
          }
        }
      }
    }

    const opponentCards = this.collectOpponentCards(this.currentMatch.startIndex ?? index, index);

    const matchData = {
      matchId: this.currentMatch.matchId,
      result: result,
      format: this.currentMatch.format,
      deckName: this.currentMatch.deckName || 'Unknown Deck',
      deckNameKey: this.currentMatch.deckNameKey || null,
      arenaDeckId: this.currentMatch.arenaDeckId || null,
      opponentName: this.currentMatch.opponentName || null,
      opponentDeck: opponentCards.cards.length > 0 ? opponentCards : null,
      playerDeck: this.currentMatch.playerDeck || null,
      timestamp: this.findServerTime(allLines, this.currentMatch.startIndex ?? index, index)
    };

    console.log(`[Parser] Match ended: ${matchData.matchId}, Result: ${result}, Deck: ${matchData.deckName}, Opponent: ${matchData.opponentName}`);

    this.pendingResult = null;

    return {
      type: 'MATCH_END',
      data: matchData
    };
  }

  handleMatchEndScene(line, allLines, index) {
    this.currentMatch = null;
    return null;
  }

  handleMatchExit(line) {
    this.currentMatch = null;
    return null;
  }

  handleResultFromJSON(line) {
    try {
      const data = JSON.parse(line);
      const resultType = data.resultType || data.ResultType;

      if (resultType) {
        const result = this.normalizeResult(resultType);

        return {
          type: 'GAME_END',
          data: {
            result: result,
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
    }

    return null;
  }

  handleGameEnd(line) {
    try {
      const data = JSON.parse(line);

      if (data.winningTeamId !== undefined) {
        const winningTeam = data.winningTeamId;

        const playerTeam = this.playerTeamId;
        const result = winningTeam === playerTeam ? 'win' : 'loss';
        console.log(`[Parser] Game end detected: winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);

        this.pendingResult = result;

        return {
          type: 'GAME_END',
          data: {
            result: result,
            winningTeamId: winningTeam,
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
    }

    return null;
  }

  handleInventoryInfo(line) {
    try {
      const data = JSON.parse(line);
      if (data.InventoryInfo) {
        const info = data.InventoryInfo;
        return {
          type: 'INVENTORY_UPDATE',
          data: {
            gems: info.Gems || 0,
            gold: info.Gold || 0,
            totalVaultProgress: info.TotalVaultProgress || 0,
            wildCardCommons: info.WildCardCommons || 0,
            wildCardUnCommons: info.WildCardUnCommons || 0,
            wildCardRares: info.WildCardRares || 0,
            wildCardMythics: info.WildCardMythics || 0,
            boosters: info.Boosters || [],
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
    }
    return null;
  }

  extractLocalPlayer(lines) {
    for (const line of lines) {
      if (line.includes('authenticateResponse')) {
        const auth = this.parseJsonFromLine(line)?.authenticateResponse;
        if (auth && (auth.clientId || auth.screenName)) {
          this.localUserId = auth.clientId || null;
          this.localScreenName = auth.screenName || null;
          console.log(`[Parser] Local player: ${this.localScreenName} (${this.localUserId})`);
          return;
        }
      }

      // Every "Match to <userId>:" line names the local account too.
      if (!this.localUserId) {
        const idMatch = line.match(/Match to ([A-Z0-9]{20,}):/);
        if (idMatch) {
          this.localUserId = idMatch[1];
        }
      }
    }

    if (this.localUserId) {
      console.log(`[Parser] Local player id: ${this.localUserId}`);
    }
  }

  isLocalPlayer(player) {
    if (!player) {
      return false;
    }
    if (this.localUserId && player.userId) {
      return player.userId === this.localUserId;
    }
    if (this.localScreenName && player.playerName) {
      return player.playerName === this.localScreenName;
    }
    return false;
  }

  // The game room's finalMatchResult states the match-scope outcome directly,
  // including draws that never produced a game result.
  findFinalMatchResult(allLines, fromIndex, toIndex, matchId) {
    const start = Math.max(0, fromIndex);
    for (let i = Math.min(toIndex, allLines.length - 1); i >= start; i--) {
      const line = allLines[i];
      if (!line.includes('"finalMatchResult"')) continue;

      const info = this.parseJsonFromLine(line)?.matchGameRoomStateChangedEvent?.gameRoomInfo;
      const final = info?.finalMatchResult;
      if (!final) continue;
      if (matchId && final.matchId && final.matchId !== matchId) continue;

      const entry = (final.resultList || []).find(r => r.scope === 'MatchScope_Match');
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  findServerTime(allLines, fromIndex, toIndex) {
    const start = Math.max(0, fromIndex);
    for (let i = Math.min(toIndex, allLines.length - 1); i >= start; i--) {
      const timeMatch = allLines[i].match(/"timestamp"\s*:\s*"(\d{13})"/);
      if (timeMatch) {
        return new Date(Number(timeMatch[1])).toISOString();
      }
    }
    return null;
  }

  resultFromFinalMatchResult(entry) {
    if (!entry) {
      return 'unknown';
    }
    if (entry.result === 'ResultType_Draw') {
      return 'draw';
    }
    if (typeof entry.winningTeamId === 'number') {
      return entry.winningTeamId === this.playerTeamId ? 'win' : 'loss';
    }
    return 'unknown';
  }

  normalizeResult(result) {
    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'victory') return 'win';
      if (lower === 'defeat') return 'loss';
      if (lower === 'draw') return 'draw';
    }
    return 'unknown';
  }

  extractDeckNamesById(lines) {
    const deckEntry = /"Deck(?:Id|IdInternal)"\s*:\s*"([0-9a-fA-F-]{36})"\s*,\s*"Name"\s*:\s*"([^"]+)"/g;
    let found = 0;

    for (const line of lines) {
      if (!line.includes('"Name"')) continue;

      deckEntry.lastIndex = 0;
      let match;
      while ((match = deckEntry.exec(line)) !== null) {
        const [, deckId, name] = match;
        const deckName = name.trim();

        if (deckName && !this.isLocalizationKey(deckName)) {
          this.deckNamesById.set(deckId, deckName);
          found++;
        }
      }
    }

    if (found > 0) {
      console.log(`[Parser] Cached ${this.deckNamesById.size} deck name(s) by deck id`);
    }
  }

  isLocalizationKey(name) {
    return typeof name === 'string' && (name.startsWith('?=?') || name.startsWith('Loc/'));
  }

  prettifyLocalizationKey(name) {
    const lastSegment = name.replace(/^\?=\?/, '').split('/').pop() || name;
    const readable = lastSegment.replace(/_/g, ' ').trim();
    return readable || name;
  }

  resolveDeckName(deckName, deckId) {
    if (deckId && this.deckNamesById.has(deckId)) {
      const resolved = this.deckNamesById.get(deckId);
      if (resolved !== deckName) {
        console.log(`[Parser] Resolved deck name for ${deckId}: ${deckName} -> ${resolved}`);
      }
      return resolved;
    }

    if (this.isLocalizationKey(deckName)) {
      const readable = this.prettifyLocalizationKey(deckName);
      console.log(`[Parser] No real name for ${deckName}, falling back to: ${readable}`);
      return readable;
    }

    return deckName;
  }

  extractCourseDeckSummary(line) {
    const start = line.indexOf('"CourseDeckSummary"');
    if (start === -1) {
      return null;
    }

    const summary = line.slice(start, start + 500);
    const nameMatch = summary.match(/"Name"\s*:\s*"([^"]+)"/);
    const idMatch = summary.match(/"DeckId"\s*:\s*"([^"]+)"/);

    if (!nameMatch || !nameMatch[1].trim()) {
      return null;
    }

    return { name: nameMatch[1].trim(), deckId: idMatch ? idMatch[1] : null };
  }

  extractCourses(lines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('"Courses"') || !line.includes('"InternalEventName"')) {
        continue;
      }

      const start = line.indexOf('{"Courses"');
      if (start === -1) {
        continue;
      }

      try {
        const payload = JSON.parse(line.slice(start));
        for (const course of payload.Courses || []) {
          if (!course.InternalEventName) {
            continue;
          }
          const summary = course.CourseDeckSummary || {};
          const formatAttribute = (summary.Attributes || [])
            .find(attribute => attribute.name === 'Format');
          this.courses.push({
            index: i,
            eventName: course.InternalEventName,
            deckId: summary.DeckId || null,
            deckFormat: formatAttribute ? formatAttribute.value : null
          });
        }
      } catch (e) {
        console.log(`[Parser] Could not parse Courses payload at line ${i}: ${e.message}`);
      }
    }

    if (this.courses.length > 0) {
      console.log(`[Parser] Found ${this.courses.length} event course(s): ${this.courses.map(c => c.eventName).join(', ')}`);
    }
  }

  findCourseForMatch(index, deckId) {
    let forDeck = null;
    let latest = null;

    for (const course of this.courses) {
      if (course.index > index) {
        break;
      }
      latest = course;
      if (deckId && course.deckId === deckId) {
        forDeck = course;
      }
    }

    return forDeck || latest;
  }

  prettifyEventName(eventName) {
    return eventName
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  parseJsonFromLine(line) {
    const start = line.indexOf('{');
    if (start === -1) {
      return null;
    }
    try {
      return JSON.parse(line.slice(start));
    } catch (e) {
      return null;
    }
  }

  readDeckPayloads(line) {
    const decks = [];

    const collect = (summary, deck) => {
      if (!summary || !summary.DeckId || !deck || !Array.isArray(deck.MainDeck)) {
        return;
      }
      const cards = [];
      for (const entry of deck.MainDeck) {
        const cardId = entry.cardId !== undefined ? entry.cardId : entry.id;
        for (let n = 0; n < (entry.quantity || 0); n++) {
          cards.push(cardId);
        }
      }
      decks.push({ deckId: summary.DeckId, cards });
    };

    const payload = this.parseJsonFromLine(line);
    if (!payload) {
      return decks;
    }

    for (const key of ['PreconDecks', 'Courses', 'Decks']) {
      for (const entry of payload[key] || []) {
        collect(entry.Summary || entry.CourseDeckSummary, entry.Deck || entry.CourseDeck);
      }
    }
    collect(payload.Summary, payload.Deck);

    if (typeof payload.request === 'string') {
      const inner = this.parseJsonFromLine(payload.request);
      if (inner) {
        collect(inner.Summary, inner.Deck);
      }
    }

    return decks;
  }

  extractDeckLists(lines) {
    for (const line of lines) {
      if (!line.includes('"MainDeck"')) {
        continue;
      }
      for (const deck of this.readDeckPayloads(line)) {
        const key = this.deckCardKey(deck.cards);
        if (key) {
          this.decksByCardList.set(key, deck.deckId);
        }
      }
    }

    if (this.decksByCardList.size > 0) {
      console.log(`[Parser] Indexed ${this.decksByCardList.size} deck list(s)`);
    }
  }

  deckCardKey(cards) {
    if (!Array.isArray(cards) || cards.length === 0) {
      return null;
    }
    return cards.slice().sort((a, b) => a - b).join(',');
  }

  findDeckForMatch(index) {
    let previous = null;

    for (const submission of this.deckMessages) {
      if (submission.line <= index) {
        previous = submission;
        continue;
      }
      return submission.line - index <= 200 ? submission : previous;
    }

    return previous;
  }

  identifyDeck(cards) {
    const key = this.deckCardKey(cards);
    const deckId = key ? this.decksByCardList.get(key) : null;
    if (!deckId) {
      return null;
    }
    return { deckId, name: this.deckNamesById.get(deckId) || null };
  }

  extractDeckCards(lines) {
    console.log(`[Parser] Searching for deck cards in ${lines.length} lines...`);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('"deckMessage"') && line.includes('"deckCards"')) {
        console.log(`[Parser] Found deckMessage with deckCards at line ${i}`);
        try {
          const cardsMatch = line.match(/"deckCards"\s*:\s*(\[[^\]]*\])/);
          if (cardsMatch) {
            const deckCards = JSON.parse(cardsMatch[1]);

            let commanderCards = [];
            const cmdrMatch = line.match(/"commanderCards"\s*:\s*(\[[^\]]*\])/);
            if (cmdrMatch) {
              commanderCards = JSON.parse(cmdrMatch[1]);
            }

            let sideboardCards = [];
            const sbMatch = line.match(/"sideboardCards"\s*:\s*(\[[^\]]*\])/);
            if (sbMatch) {
              sideboardCards = JSON.parse(sbMatch[1]);
            }
            const submission = {
              line: i,
              deckCards: deckCards,
              sideboardCards: sideboardCards,
              commandZoneCards: commanderCards
            };
            this.deckMessages.push(submission);

            if (!this.deckCards) {
              this.deckCards = submission;
            }
            console.log(`[Parser] Deck submitted at line ${i}: ${deckCards.length} main, ${sideboardCards.length} sideboard, ${commanderCards.length} commanders`);
          } else {
            console.log(`[Parser] Found deckMessage but could not extract deckCards array`);
          }
        } catch (e) {
          console.log('[Parser] Failed to extract deck cards:', e.message);
        }
      }
    }
    if (this.deckMessages.length === 0) {
      console.log(`[Parser] No deckMessage with deckCards found in log`);
    }
  }

  extractDeckNames(lines) {
    for (let i = 0; i < Math.min(500, lines.length); i++) {
      const line = lines[i];

      if (line.includes('"Courses"')) {
        const coursesMatch = line.match(/"Courses":\s*(\[.*?\])/);
        if (coursesMatch) {
          try {
            const coursesData = JSON.parse(coursesMatch[1]);
            coursesData.forEach(course => {
              if (course.CourseDeckSummary && course.CourseDeckSummary.Name) {
                const eventName = course.InternalEventName || 'Unknown';
                this.deckNames.set(eventName, course.CourseDeckSummary.Name);
                console.log(`[Parser] Cached deck for ${eventName}: ${course.CourseDeckSummary.Name}`);
              }
            });
          } catch (e) {
            const nameMatches = line.matchAll(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/g);
            for (const match of nameMatches) {
              const deckName = match[1];
              console.log(`[Parser] Found deck name via regex: ${deckName}`);
            }
          }
        }
      }

      if (line.includes('"CourseDeckSummary"')) {
        const nameMatch = line.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
          console.log(`[Parser] Found deck in early lines: ${nameMatch[1]}`);
        }
      }
    }
  }

  formatCourseId(courseId) {
    if (!courseId) return 'Unknown Deck';

    const match = courseId.match(/Avatar_Basic_(.+)/);
    if (match) {
      return match[1].replace(/_/g, ' ');
    }
    return courseId.replace(/_/g, ' ');
  }

  extractRevealedCards(lines) {
    let game = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('"gameStateMessage"')) {
        continue;
      }

      const payload = this.parseJsonFromLine(line);
      if (!payload) {
        continue;
      }

      for (const message of payload.greToClientEvent?.greToClientMessages || []) {
        const gameState = message.gameStateMessage;
        if (!gameState) {
          continue;
        }

        const gameInfo = gameState.gameInfo;
        if (gameInfo?.matchID) {
          game = `${gameInfo.matchID}#${gameInfo.gameNumber || 1}`;
        }

        for (const object of gameState.gameObjects || []) {
          if (object.type !== 'GameObjectType_Card' || object.grpId === undefined) {
            continue;
          }
          this.revealedCards.push({
            line: i,
            game: game,
            instanceId: object.instanceId,
            seatId: object.ownerSeatId,
            grpId: object.grpId,
            visibility: object.visibility,
            viewers: object.viewers || [],
            colors: (object.color || []).map(color => GRE_CARD_COLORS[color]).filter(Boolean)
          });
        }

        for (const annotation of gameState.annotations || []) {
          if (!(annotation.type || []).includes('AnnotationType_ObjectIdChanged')) {
            continue;
          }
          const detail = key => (annotation.details || []).find(d => d.key === key)?.valueInt32?.[0];
          const from = detail('orig_id');
          const to = detail('new_id');
          if (from !== undefined && to !== undefined) {
            this.objectIdChanges.push({ line: i, game: game, from: from, to: to });
          }
        }
      }
    }

    if (this.revealedCards.length > 0) {
      console.log(`[Parser] Recorded ${this.revealedCards.length} card sighting(s) from game states`);
    }
  }

  collectOpponentCards(fromLine, toLine) {
    const previousId = new Map();
    for (const change of this.objectIdChanges) {
      if (change.line < fromLine) continue;
      if (change.line > toLine) break;
      previousId.set(`${change.game}:${change.to}`, `${change.game}:${change.from}`);
    }

    const originalId = (game, instanceId) => {
      let key = `${game}:${instanceId}`;
      const visited = new Set();
      while (previousId.has(key) && !visited.has(key)) {
        visited.add(key);
        key = previousId.get(key);
      }
      return key;
    };

    const copiesPerGame = new Map();
    const colors = new Set();

    for (const sighting of this.revealedCards) {
      if (sighting.line < fromLine) continue;
      if (sighting.line > toLine) break;
      if (sighting.seatId === this.playerSeatId) continue;
      if (sighting.visibility !== 'Visibility_Public' &&
          !sighting.viewers.includes(this.playerSeatId)) {
        continue;
      }

      if (!copiesPerGame.has(sighting.grpId)) {
        copiesPerGame.set(sighting.grpId, new Map());
      }
      const games = copiesPerGame.get(sighting.grpId);
      if (!games.has(sighting.game)) {
        games.set(sighting.game, new Set());
      }
      games.get(sighting.game).add(originalId(sighting.game, sighting.instanceId));

      for (const color of sighting.colors) {
        colors.add(color);
      }
    }

    const cards = [];
    for (const [grpId, games] of copiesPerGame) {
      const copies = Math.max(...Array.from(games.values(), copiesSeen => copiesSeen.size));
      for (let n = 0; n < copies; n++) {
        cards.push(grpId);
      }
    }

    return {
      cards: cards,
      colors: COLOR_ORDER.filter(color => colors.has(color))
    };
  }

  detectFormatFromEventName(eventName) {
    if (!eventName) return 'Unknown';
    const name = eventName.toLowerCase();

    const knownEvents = {
      dualcolorprecons: 'Starter Deck Duel',
      directgame: 'Direct Challenge',
      colorchallenge: 'Color Challenge',
      jump_in: 'Jump In',
      jump_in_2024: 'Jump In'
    };
    if (knownEvents[name]) return knownEvents[name];

    if (name.includes('standard')) return 'Standard';
    if (name.includes('alchemy')) return 'Alchemy';
    if (name.includes('historic')) {
      if (name.includes('brawl')) return 'Brawl';
      if (name.includes('play')) return 'Historic';
      return 'Historic';
    }
    if (name === 'historic_play') return 'Historic';
    if (name.includes('explorer')) return 'Explorer';
    if (name.includes('pioneer')) return 'Pioneer';
    if (name.includes('timeless')) return 'Timeless';
    if (name.includes('brawl')) return 'Standard Brawl';
    if (name.includes('draft')) return 'Draft';
    if (name.includes('sealed')) return 'Sealed';
    if (name.includes('constructed')) return 'Constructed';

    return 'Unknown';
  }
}

module.exports = LogParser;
