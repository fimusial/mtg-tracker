// Rebuilds the course of a match - what both players did, turn by turn - from the
// Game Rules Engine (GRE) messages MTG Arena writes to Player.log.
// A course is plain data. Each game is a list of lines and each line is a list of
// parts: plain text, or a reference to a player ({ player: seatId }), a card
// ({ card: grpId }) or a life total ({ life: n }). Cards stay as Arena ids so the
// renderer can show them like everywhere else in the app.

const COURSE_VERSION = 2;
const ARENA_MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COUNTER_NAMES = {
  1: '+1/+1', 2: '-1/-1', 3: 'poison', 5: 'time', 6: 'fade', 7: 'loyalty', 9: 'age',
  15: 'blood', 19: 'charge', 25: 'death', 31: 'doom', 35: 'energy', 38: 'fate',
  44: 'fuse', 46: 'gold', 47: 'growth', 52: 'hunger', 53: 'ice', 57: 'ki', 58: 'level',
  59: 'luck', 64: 'mine', 69: 'omen', 71: 'page', 74: 'petal', 78: 'plague',
  82: 'quest', 86: 'shield', 88: 'sleep', 92: 'spell', 93: 'spore', 94: 'storage',
  96: 'study', 101: 'training', 103: 'treasure', 104: 'verse', 108: 'lore',
  109: '+1/+2', 110: '+0/+1', 111: '+0/+2', 112: '+1/+0', 113: '+2/+2', 114: '-0/-1',
  115: '-0/-2', 116: '-1/-0', 117: '-2/-1', 118: '-2/-2', 120: 'gem', 124: 'unity',
  128: 'prey', 130: 'egg', 131: 'hit', 132: 'knowledge', 133: 'task', 134: 'coin',
  135: 'deathtouch', 136: 'first strike', 137: 'flying', 138: 'hexproof',
  139: 'lifelink', 140: 'menace', 141: 'reach', 142: 'trample', 143: 'vigilance',
  146: 'soul', 147: 'voyage', 150: 'indestructible', 156: 'void', 164: 'suspect',
  165: 'acorn', 167: 'stash', 172: 'stun', 173: 'oil', 174: 'defense',
  175: 'experience', 178: 'burden', 192: 'story', 194: 'blight', 195: 'supply',
  205: 'decayed', 209: 'double strike', 215: 'haste', 216: 'shadow'
};

const LOSS_REASONS = {
  SBA_LifeTotal: '\'s life total reached 0',
  SBA_PoisonCounters: ' got 10 poison counters',
  SBA_Poison: ' got 10 poison counters',
  SBA_DrawFromEmptyLibrary: ' drew from an empty library',
  SBA_EmptyLibrary: ' drew from an empty library'
};

const ACTION_ACTIVATE = 2;
const DAMAGE_COMBAT = 1;
const MAX_SNAPSHOTS = 16;

const zoneKind = zone => (zone?.type || '').replace('ZoneType_', '');

const stripPrefix = (values, prefix) => (values || []).map(value => value.replace(prefix, ''));

function detailsOf(annotation) {
  const details = {};
  for (const detail of annotation.details || []) {
    details[detail.key] = detail.valueInt32 || detail.valueUint32 || detail.valueString || [];
  }
  return details;
}

function article(word) {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function plural(count, word) {
  return count === 1 ? `${article(word)} ${word}` : `${count} ${word}s`;
}

function signed(value) {
  return value < 0 ? `${value}` : `+${value}`;
}

function joinParts(entries) {
  const parts = [];
  entries.forEach((entry, index) => {
    if (index > 0) {
      parts.push(index === entries.length - 1 ? ' and ' : ', ');
    }
    parts.push(...entry);
  });
  return parts;
}

function prettifyReason(reason) {
  return String(reason || '')
    .replace(/^(ResultReason_|SBA_)/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

class CourseBuilder {
  constructor(matchId) {
    this.matchId = matchId;
    this.localSeat = null;
    this.localUserId = null;
    this.players = new Map();
    this.dieRolls = null;
    this.games = [];
    this.game = null;
    this.matchResult = null;
    this.done = false;
    this.message = null;
  }

  readLine(line, header) {
    if (this.done) {
      return;
    }

    const userMatch = header && header.match(/Match to ([^:\s]+):/);
    if (userMatch && !this.localUserId) {
      this.localUserId = userMatch[1];
    }

    if (line.includes('"greToClientEvent"')) {
      const payload = parseJson(line);
      const time = Number(payload?.timestamp) || null;
      for (const message of payload?.greToClientEvent?.greToClientMessages || []) {
        this.readGreMessage(message, time);
        if (this.done) {
          return;
        }
      }
    } else if (line.includes('"matchGameRoomStateChangedEvent"')) {
      const roomInfo = parseJson(line)?.matchGameRoomStateChangedEvent?.gameRoomInfo;
      const config = roomInfo?.gameRoomConfig;
      if (config?.reservedPlayers && (config.matchId === this.matchId || (!config.matchId && this.games.length === 0))) {
        this.readPlayers(config.reservedPlayers);
      }
      if (roomInfo?.finalMatchResult?.matchId === this.matchId) {
        this.readFinalResult(roomInfo.finalMatchResult);
      }
    }
  }

  readSummarizedMessage() {
    const game = this.game;
    if (!game || game.finished || this.done || game.lines[game.lines.length - 1]?.kind === 'gap') {
      return;
    }
    this.line('gap', null, ['Some events are missing here']);
  }

  readPlayers(reservedPlayers) {
    for (const reserved of reservedPlayers) {
      if (typeof reserved.systemSeatId !== 'number') {
        continue;
      }
      this.players.set(reserved.systemSeatId, {
        seat: reserved.systemSeatId,
        team: typeof reserved.teamId === 'number' ? reserved.teamId : reserved.systemSeatId,
        name: reserved.playerName || `Player ${reserved.systemSeatId}`
      });
      if (this.localUserId && reserved.userId === this.localUserId && this.localSeat === null) {
        this.localSeat = reserved.systemSeatId;
      }
    }
  }

  readGreMessage(message, time) {
    if (message.type === 'GREMessageType_DieRollResultsResp') {
      this.dieRolls = (message.dieRollResultsResp?.playerDieRolls || [])
        .filter(roll => typeof roll.systemSeatId === 'number');
      return;
    }

    if (message.type === 'GREMessageType_ConnectResp' && (message.systemSeatIds || []).length === 1) {
      this.localSeat = message.systemSeatIds[0];
      return;
    }

    if (message.gameStateMessage) {
      if (this.localSeat === null && (message.systemSeatIds || []).length === 1) {
        this.localSeat = message.systemSeatIds[0];
      }
      this.readGameState(message.gameStateMessage, time);
    }
  }

  readGameState(state, time) {
    const info = state.gameInfo;

    if (info?.matchID && info.matchID !== this.matchId) {
      if (this.games.length > 0) {
        this.done = true;
      }
      return;
    }

    if (info && (!this.game || (info.gameNumber || 1) !== this.game.number)) {
      this.startGame(info.gameNumber || 1, time);
    }

    const game = this.game;
    if (!game || game.states.has(state.gameStateId)) {
      return;
    }
    game.states.add(state.gameStateId);
    game.endedAt = time || game.endedAt;

    if (state.update === 'GameStateUpdate_Undo') {
      this.restore(state.prevGameStateId);
    }

    this.message = {
      draws: new Map(),
      playerDamage: new Map(),
      taps: new Map(),
      countered: new Set()
    };

    for (const zone of state.zones || []) {
      game.zones.set(zone.zoneId, zone);
    }
    const lifeTotals = new Map();
    for (const player of state.players || []) {
      this.readPlayerState(player, lifeTotals);
    }
    for (const object of state.gameObjects || []) {
      game.objects.set(object.instanceId, object);
    }

    if (state.turnInfo) {
      this.readTurn(state.turnInfo, time);
    }
    if (game.opened) {
      this.readCombat(state.gameObjects || []);
    }
    let lastAnnotationId = game.lastAnnotationId;
    for (const annotation of state.annotations || []) {
      if (annotation.id <= game.lastAnnotationId) {
        continue;
      }
      lastAnnotationId = Math.max(lastAnnotationId, annotation.id || 0);
      this.readAnnotation(annotation);
    }
    game.lastAnnotationId = lastAnnotationId;
    for (const annotation of state.persistentAnnotations || []) {
      this.readPersistentAnnotation(annotation);
    }

    this.flushMessage();
    for (const [seat, life] of lifeTotals) {
      game.life.set(seat, life);
    }

    if (info) {
      this.readResult(info, time);
    }

    this.snapshot(state.gameStateId);
  }

  snapshot(stateId) {
    const game = this.game;
    game.snapshots.set(stateId, {
      lineCount: game.lines.length,
      zones: new Map(game.zones),
      objects: new Map(game.objects),
      previousId: new Map(game.previousId),
      life: new Map(game.life),
      turn: game.turn,
      activePlayer: game.activePlayer,
      opened: game.opened,
      attackers: new Set(game.attackers),
      blockers: new Set(game.blockers),
      stackLines: new Map(game.stackLines),
      abilities: new Map(game.abilities),
      lastAnnotationId: game.lastAnnotationId,
      lossReason: game.lossReason
    });

    if (game.snapshots.size > MAX_SNAPSHOTS) {
      game.snapshots.delete(game.snapshots.keys().next().value);
    }
  }

  restore(stateId) {
    const game = this.game;
    const snapshot = game.snapshots.get(stateId);
    if (!snapshot) {
      return;
    }

    const { lineCount, ...state } = snapshot;
    game.lines.length = lineCount;
    Object.assign(game, state, {
      zones: new Map(state.zones),
      objects: new Map(state.objects),
      previousId: new Map(state.previousId),
      life: new Map(state.life),
      attackers: new Set(state.attackers),
      blockers: new Set(state.blockers),
      stackLines: new Map(state.stackLines),
      abilities: new Map(state.abilities)
    });

    for (const id of Array.from(game.snapshots.keys())) {
      if (id > stateId) {
        game.snapshots.delete(id);
      }
    }
  }

  readPlayerState(player, lifeTotals) {
    const game = this.game;
    const seat = player.systemSeatNumber;
    if (typeof seat !== 'number') {
      return;
    }

    game.seats.add(seat);
    if (!this.players.has(seat)) {
      this.players.set(seat, { seat, team: player.teamId ?? seat, name: `Player ${seat}` });
    }
    if (typeof player.mulliganCount === 'number') {
      game.mulligans.set(seat, player.mulliganCount);
    }
    if (typeof player.lifeTotal === 'number') {
      if (!game.life.has(seat)) {
        game.life.set(seat, player.lifeTotal);
      }
      lifeTotals.set(seat, player.lifeTotal);
    }
  }

  startGame(number, time) {
    this.game = {
      number,
      startedAt: time,
      endedAt: time,
      lines: [],
      states: new Set(),
      zones: new Map(),
      objects: new Map(),
      previousId: new Map(),
      seats: new Set(),
      life: new Map(),
      mulligans: new Map(),
      turn: 0,
      activePlayer: null,
      opened: false,
      attackers: new Set(),
      blockers: new Set(),
      stackLines: new Map(),
      abilities: new Map(),
      lastAnnotationId: 0,
      snapshots: new Map(),
      lossReason: null,
      finished: false,
      result: null
    };
    this.games.push(this.game);
  }

  push(line) {
    if (this.game) {
      this.game.lines.push(line);
    }
    return line;
  }

  line(kind, seat, parts) {
    return this.lineIn(this.game, kind, seat, parts);
  }

  lineIn(game, kind, seat, parts) {
    const line = { turn: game.turn, seat: seat ?? null, kind, parts };
    game.lines.push(line);
    return line;
  }

  readTurn(turnInfo, time) {
    const game = this.game;
    const turn = turnInfo.turnNumber;
    if (typeof turn !== 'number' || turn <= game.turn) {
      return;
    }

    const activePlayer = turnInfo.activePlayer ?? game.activePlayer;
    if (!game.opened && turn === 1) {
      this.openGame(activePlayer);
    }

    game.opened = true;
    game.turn = turn;
    game.activePlayer = activePlayer;
    game.attackers.clear();
    game.blockers.clear();

    this.push({
      turn,
      seat: activePlayer,
      kind: 'turn',
      time,
      life: Object.fromEntries(game.life)
    });
  }

  openGame(firstSeat) {
    const game = this.game;
    game.opened = true;

    if (game.number === 1 && this.dieRolls?.length > 1) {
      const parts = ['Die roll: '];
      this.dieRolls.forEach((roll, index) => {
        parts.push(index > 0 ? ', ' : '', { player: roll.systemSeatId }, ` ${roll.rollValue}`);
      });
      this.line('setup', null, parts);
    }

    if (typeof firstSeat === 'number') {
      this.line('setup', firstSeat, [{ player: firstSeat }, ' plays first']);
    }

    const seats = Array.from(game.seats).sort((a, b) => (a === firstSeat ? -1 : b === firstSeat ? 1 : a - b));
    for (const seat of seats) {
      const hand = Array.from(game.zones.values())
        .find(zone => zoneKind(zone) === 'Hand' && zone.ownerSeatId === seat);
      const ids = hand?.objectInstanceIds || [];
      const mulligans = game.mulligans.get(seat) || 0;

      const parts = [{ player: seat }];
      parts.push(mulligans > 0
        ? ` mulligans ${mulligans === 1 ? 'once' : `${mulligans} times`} and keeps ${ids.length}`
        : ` keeps ${ids.length}`);

      const known = ids.map(id => this.cardPart(id)).filter(part => typeof part !== 'string');
      if (known.length === ids.length && ids.length > 0) {
        parts.push(': ', ...joinParts(known.map(part => [part])));
      }
      this.line('setup', seat, parts);
    }
  }

  readResult(info, time) {
    const results = info.results || [];

    const gameResult = results.find(result => result.scope === 'MatchScope_Game');
    if (gameResult) {
      this.finishGame(this.game, gameResult, time);
    }

    const matchResult = results.find(result => result.scope === 'MatchScope_Match');
    if (matchResult) {
      this.finishMatch(matchResult);
    }
  }

  readFinalResult(finalResult) {
    const results = finalResult.resultList || [];

    results.filter(result => result.scope === 'MatchScope_Game').forEach((result, index) => {
      const game = this.games.find(candidate => candidate.number === index + 1);
      if (game) {
        this.finishGame(game, result, null);
      }
    });

    const matchResult = results.find(result => result.scope === 'MatchScope_Match');
    if (matchResult) {
      this.finishMatch(matchResult);
    }
  }

  finishGame(game, result, time) {
    if (game.finished) {
      return;
    }
    game.finished = true;
    game.endedAt = time || game.endedAt;
    game.result = {
      winningTeam: result.winningTeamId ?? null,
      draw: result.result === 'ResultType_Draw',
      reason: (result.reason || '').replace('ResultReason_', '') || null
    };

    if (game.result.draw) {
      this.lineIn(game, 'result', null, [`Game ${game.number} ends in a draw`]);
      return;
    }

    const winner = this.seatOfTeam(result.winningTeamId);
    const loser = Array.from(game.seats).find(seat => seat !== winner) ?? null;
    game.result.winner = winner;

    const parts = [{ player: winner }, ` wins game ${game.number}`];
    const reason = game.result.reason;
    if (loser !== null && reason === 'Concede') {
      parts.push(' (', { player: loser }, ' conceded)');
    } else if (loser !== null && reason === 'Timeout') {
      parts.push(' (', { player: loser }, ' ran out of time)');
    } else if (loser !== null && game.lossReason) {
      parts.push(' (', { player: loser }, `${LOSS_REASONS[game.lossReason] || ` lost: ${prettifyReason(game.lossReason)}`})`);
    } else if (reason && reason !== 'Game') {
      parts.push(` (${prettifyReason(reason)})`);
    }
    this.lineIn(game, 'result', winner, parts);
  }

  finishMatch(result) {
    if (this.matchResult) {
      return;
    }
    this.matchResult = result;

    const lastGame = this.games[this.games.length - 1];
    if (this.games.length < 2 || !lastGame) {
      return;
    }
    if (result.result === 'ResultType_Draw') {
      this.lineIn(lastGame, 'result', null, ['The match ends in a draw']);
      return;
    }
    const winner = this.seatOfTeam(result.winningTeamId);
    const wins = this.games.filter(game => game.result?.winner === winner).length;
    const losses = this.games.filter(game => game.result && !game.result.draw && game.result.winner !== winner).length;
    this.lineIn(lastGame, 'result', winner, [{ player: winner }, ` wins the match ${wins}-${losses}`]);
  }

  seatOfTeam(team) {
    for (const player of this.players.values()) {
      if (player.team === team) {
        return player.seat;
      }
    }
    return team ?? null;
  }

  object(id) {
    const game = this.game;
    let current = id;
    const visited = new Set();
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const object = game.objects.get(current);
      if (object && (object.grpId || object.type === 'GameObjectType_Ability')) {
        return object;
      }
      current = game.previousId.get(current);
    }
    return game.objects.get(id) || null;
  }

  isPlayer(id) {
    return this.game.seats.has(id);
  }

  controllerOf(id) {
    if (this.isPlayer(id)) {
      return id;
    }
    const object = this.object(id);
    return object ? (object.controllerSeatId ?? object.ownerSeatId ?? null) : null;
  }

  ownerOf(id, ...zones) {
    const object = this.object(id);
    if (object?.ownerSeatId) {
      return object.ownerSeatId;
    }
    const zone = zones.find(candidate => candidate?.ownerSeatId);
    return zone ? zone.ownerSeatId : null;
  }

  cardPart(id) {
    if (this.isPlayer(id)) {
      return { player: id };
    }

    const object = this.object(id);
    if (!object) {
      return 'a card';
    }
    if (object.type === 'GameObjectType_Ability') {
      return this.sourcePart(object.parentId, object.objectSourceGrpId);
    }
    if (!object.grpId) {
      return 'a card';
    }
    if (object.type === 'GameObjectType_Token') {
      return this.tokenPart(object);
    }
    return { card: object.grpId };
  }

  tokenPart(object) {
    const subtypes = stripPrefix(object.subtypes, 'SubType_');
    const types = stripPrefix(object.cardTypes, 'CardType_');
    const part = { card: object.grpId, token: (subtypes.length ? subtypes : types).join(' ') || 'Token' };
    if (types.includes('Creature') && object.power && object.toughness) {
      part.pt = `${object.power.value ?? 0}/${object.toughness.value ?? 0}`;
    }
    return part;
  }

  sourcePart(id, fallbackGrpId) {
    const object = id !== undefined ? this.object(id) : null;
    if (object && object.type === 'GameObjectType_Ability') {
      return this.sourcePart(object.parentId, object.objectSourceGrpId);
    }
    if (object) {
      return this.cardPart(id);
    }
    return fallbackGrpId ? { card: fallbackGrpId } : 'an ability';
  }

  readCombat(objects) {
    const game = this.game;
    const attacks = new Map();
    const blocks = new Map();

    for (const object of objects) {
      const id = object.instanceId;

      if (object.attackState === 'AttackState_Attacking') {
        if (!game.attackers.has(id)) {
          game.attackers.add(id);
          const seat = object.controllerSeatId;
          const target = object.attackInfo?.targetId ?? null;
          const key = `${seat}:${target}`;
          if (!attacks.has(key)) {
            attacks.set(key, { seat, target, ids: [] });
          }
          attacks.get(key).ids.push(id);
        }
      } else {
        game.attackers.delete(id);
      }

      if (object.blockState === 'BlockState_Blocking') {
        if (!game.blockers.has(id)) {
          game.blockers.add(id);
          for (const attackerId of object.blockInfo?.attackerIds || []) {
            if (!blocks.has(attackerId)) {
              blocks.set(attackerId, { seat: object.controllerSeatId, ids: [] });
            }
            blocks.get(attackerId).ids.push(id);
          }
        }
      } else {
        game.blockers.delete(id);
      }
    }

    for (const attack of attacks.values()) {
      const parts = [{ player: attack.seat }, ' attacks'];
      if (attack.target !== null) {
        parts.push(' ', this.cardPart(attack.target));
      }
      parts.push(' with ', ...joinParts(attack.ids.map(id => [this.cardPart(id)])));
      this.line('attack', attack.seat, parts);
    }

    for (const [attackerId, block] of blocks) {
      this.line('block', block.seat, [
        { player: block.seat }, ' blocks ', this.cardPart(attackerId),
        ' with ', ...joinParts(block.ids.map(id => [this.cardPart(id)]))
      ]);
    }
  }

  readAnnotation(annotation) {
    const details = detailsOf(annotation);

    for (const type of annotation.type || []) {
      switch (type) {
        case 'AnnotationType_ObjectIdChanged':
          if (details.orig_id?.length && details.new_id?.length) {
            this.game.previousId.set(details.new_id[0], details.orig_id[0]);
          }
          break;
        case 'AnnotationType_ZoneTransfer':
          if (this.game.opened) {
            this.readZoneTransfer(annotation, details);
          }
          break;
        case 'AnnotationType_AbilityInstanceCreated':
          this.readAbility(annotation);
          break;
        case 'AnnotationType_UserActionTaken':
          this.readUserAction(annotation, details);
          break;
        case 'AnnotationType_DamageDealt':
          this.readDamage(annotation, details);
          break;
        case 'AnnotationType_ModifiedLife':
          this.readLife(annotation, details);
          break;
        case 'AnnotationType_CounterAdded':
          this.readCounters(annotation, details, 'gets');
          break;
        case 'AnnotationType_CounterRemoved':
          this.readCounters(annotation, details, 'loses');
          break;
        case 'AnnotationType_PowerToughnessModCreated':
          this.readPowerToughness(annotation, details);
          break;
        case 'AnnotationType_TokenCreated':
          this.readTokens(annotation);
          break;
        case 'AnnotationType_AttachmentCreated':
          this.readAttachment(annotation);
          break;
        case 'AnnotationType_Scry':
          this.readScry(annotation, details);
          break;
        case 'AnnotationType_CastingTimeOption':
          this.readCastingOption(annotation, details);
          break;
        case 'AnnotationType_TappedUntappedPermanent':
          if (this.game.opened) {
            this.readTap(annotation, details);
          }
          break;
      }
    }
  }

  readPersistentAnnotation(annotation) {
    const types = annotation.type || [];

    if (types.includes('AnnotationType_TargetSpec')) {
      const line = this.game.stackLines.get(annotation.affectorId);
      if (!line) {
        return;
      }
      line.targets = line.targets || [];
      for (const target of annotation.affectedIds || []) {
        if (!line.targets.includes(target)) {
          line.parts.push(line.targets.length === 0 ? ' targeting ' : ', ', this.cardPart(target));
          line.targets.push(target);
        }
      }
    }

    if (types.includes('AnnotationType_LossOfGame') && !this.game.lossReason) {
      this.game.lossReason = detailsOf(annotation).reason?.[0] || 'Lost';
    }
  }

  readZoneTransfer(annotation, details) {
    const game = this.game;
    const from = game.zones.get(details.zone_src?.[0]);
    const to = game.zones.get(details.zone_dest?.[0]);
    const category = details.category?.[0] || '';

    for (const id of annotation.affectedIds || []) {
      const card = this.cardPart(id);
      const owner = this.ownerOf(id, from, to);
      const controller = this.controllerOf(id) ?? owner;

      switch (category) {
        case 'PlayLand':
          this.line('land', controller, [{ player: controller }, ' plays ', card]);
          break;
        case 'CastSpell': {
          const parts = [{ player: controller }, ' casts ', card];
          if (zoneKind(from) && zoneKind(from) !== 'Hand') {
            parts.push(` from ${zoneKind(from) === 'Exile' ? 'exile' : `the ${zoneKind(from).toLowerCase()}`}`);
          }
          game.stackLines.set(id, this.line('cast', controller, parts));
          break;
        }
        case 'Resolve':
          break;
        case 'Countered':
          this.line('countered', controller, [card, ' is countered']);
          break;
        case 'Draw':
          this.addDraw(owner, id);
          break;
        case 'Discard':
          this.line('discard', owner, [{ player: owner }, ' discards ', card]);
          break;
        case 'Mill':
          this.line('mill', owner, [{ player: owner }, ' mills ', card]);
          break;
        case 'Surveil':
          this.line('mill', owner, [{ player: owner }, ' surveils ', card, ' into the graveyard']);
          break;
        case 'Sacrifice':
          this.line('sacrifice', controller, [{ player: controller }, ' sacrifices ', card]);
          break;
        case 'Destroy':
          this.line('destroy', controller, [card, ' is destroyed']);
          break;
        case 'SBA_Damage':
          this.line('destroy', controller, [card, ' is destroyed by lethal damage']);
          break;
        case 'SBA_Deathtouch':
          this.line('destroy', controller, [card, ' is destroyed by deathtouch damage']);
          break;
        case 'SBA_ZeroToughness':
          this.line('destroy', controller, [card, ' dies with 0 toughness']);
          break;
        case 'SBA_ZeroLoyalty':
          this.line('destroy', controller, [card, ' dies with 0 loyalty']);
          break;
        case 'SBA_LegendRule':
          this.line('destroy', controller, [card, ' is put into the graveyard by the legend rule']);
          break;
        case 'Exile':
          this.line('exile', controller, [card, ' is exiled', ...this.fromZone(from, 'Battlefield')]);
          break;
        default:
          if (category.startsWith('SBA_') && zoneKind(to) === 'Graveyard') {
            this.line('destroy', controller, [card, ` is put into the graveyard (${prettifyReason(category)})`]);
          } else {
            this.readMove(id, card, owner, controller, from, to);
          }
      }
    }
  }

  readMove(id, card, owner, controller, from, to) {
    const source = zoneKind(from);
    const destination = zoneKind(to);
    const dies = source === 'Battlefield' && (this.object(id)?.cardTypes || []).includes('CardType_Creature');

    switch (destination) {
      case 'Battlefield':
        this.line('move', controller, [card, source === 'Graveyard' || source === 'Exile'
          ? ' returns to the battlefield'
          : ' is put onto the battlefield', ...this.fromZone(from, 'Stack')]);
        break;
      case 'Hand':
        this.line('return', owner, [card, source === 'Battlefield' ? ' is returned to ' : ' is put into ',
          { player: owner }, '\'s hand', ...this.fromZone(from, 'Battlefield')]);
        break;
      case 'Graveyard':
        this.line(source === 'Battlefield' ? 'destroy' : 'move', controller,
          [card, dies ? ' dies' : ' is put into the graveyard', ...this.fromZone(from, 'Battlefield')]);
        break;
      case 'Exile':
        this.line('exile', controller, [card, ' is exiled', ...this.fromZone(from, 'Battlefield')]);
        break;
      case 'Library':
        this.line('move', owner, [card, ' is put into ', { player: owner }, '\'s library',
          ...this.fromZone(from, 'Battlefield')]);
        break;
    }
  }

  fromZone(zone, unremarkable) {
    const kind = zoneKind(zone);
    if (!kind || kind === unremarkable || !['Battlefield', 'Graveyard', 'Exile', 'Library', 'Hand', 'Stack'].includes(kind)) {
      return [];
    }
    return [kind === 'Exile' ? ' from exile' : ` from the ${kind.toLowerCase()}`];
  }

  readTap(annotation, details) {
    const tapped = details.tapped?.[0] !== 0;
    const source = annotation.affectorId !== undefined ? this.object(annotation.affectorId) : null;
    const sourceSeat = source ? (source.controllerSeatId ?? source.ownerSeatId ?? null) : null;

    for (const id of annotation.affectedIds || []) {
      const controller = this.controllerOf(id);
      const forced = sourceSeat !== null && sourceSeat !== controller;
      const key = `${tapped}:${controller}:${forced ? annotation.affectorId : ''}`;
      const taps = this.message.taps;
      if (!taps.has(key)) {
        taps.set(key, {
          line: this.line(tapped ? 'tap' : 'untap', controller, []),
          tapped,
          controller,
          sourceId: forced ? annotation.affectorId : null,
          ids: []
        });
      }
      taps.get(key).ids.push(id);
    }
  }

  addDraw(seat, id) {
    const draws = this.message.draws;
    if (!draws.has(seat)) {
      draws.set(seat, { line: this.line('draw', seat, []), ids: [] });
    }
    draws.get(seat).ids.push(id);
  }

  readAbility(annotation) {
    for (const id of annotation.affectedIds || []) {
      const ability = this.game.objects.get(id);
      if (!ability || ability.type !== 'GameObjectType_Ability') {
        continue;
      }
      const source = this.sourcePart(annotation.affectorId ?? ability.parentId, ability.objectSourceGrpId);
      const line = this.line('ability', ability.controllerSeatId, [source, ' triggers']);
      this.game.stackLines.set(id, line);
      this.game.abilities.set(id, { line, source });
    }
  }

  readUserAction(annotation, details) {
    if (details.actionType?.[0] !== ACTION_ACTIVATE) {
      return;
    }
    const seat = annotation.affectorId;
    for (const id of annotation.affectedIds || []) {
      const ability = this.game.abilities.get(id);
      if (ability && !ability.activated) {
        ability.activated = true;
        ability.line.parts.splice(0, 2, { player: seat }, ' activates ', ability.source);
      }
    }
  }

  readDamage(annotation, details) {
    const amount = details.damage?.[0] || 0;
    if (amount <= 0) {
      return;
    }
    const source = this.sourcePart(annotation.affectorId);
    const combat = details.type?.[0] === DAMAGE_COMBAT;

    for (const target of annotation.affectedIds || []) {
      if (this.isPlayer(target)) {
        const playerDamage = this.message.playerDamage;
        if (!playerDamage.has(target)) {
          playerDamage.set(target, { line: this.line('damage', target, []), sources: [], total: 0, explained: 0, life: null, combat });
        }
        const entry = playerDamage.get(target);
        entry.sources.push({ source, amount });
        entry.total += amount;
      } else {
        this.line('damage', this.controllerOf(annotation.affectorId), [
          source, ` deals ${amount} damage to `, this.cardPart(target)
        ]);
      }
    }
  }

  readLife(annotation, details) {
    const game = this.game;
    const delta = details.life?.[0] || 0;
    for (const seat of annotation.affectedIds || []) {
      if (!delta || !this.isPlayer(seat)) {
        continue;
      }
      const life = (game.life.get(seat) ?? 0) + delta;
      game.life.set(seat, life);

      if (delta > 0) {
        this.line('life', seat, [{ player: seat }, ` gains ${delta} life`, { life }]);
        continue;
      }

      let unexplained = -delta;
      const damage = this.message.playerDamage.get(seat);
      if (damage) {
        const explained = Math.min(unexplained, damage.total - damage.explained);
        damage.explained += explained;
        damage.life = life;
        unexplained -= explained;
      }
      if (unexplained > 0) {
        this.line('life', seat, [{ player: seat }, ` loses ${unexplained} life`, { life }]);
      }
    }
  }

  readCounters(annotation, details, verb) {
    const name = COUNTER_NAMES[details.counter_type?.[0]] || null;
    const amount = details.transaction_amount?.[0] || 1;
    const counters = plural(amount, name ? `${name} counter` : 'counter');

    for (const target of annotation.affectedIds || []) {
      this.message.countered.add(target);
      this.line('counter', this.controllerOf(target), [this.cardPart(target), ` ${verb} ${counters}`]);
    }
  }

  readPowerToughness(annotation, details) {
    const power = details.power?.[0] || 0;
    const toughness = details.toughness?.[0] || 0;
    if (!power && !toughness) {
      return;
    }

    for (const target of annotation.affectedIds || []) {
      if (this.message.countered.has(target)) {
        continue;
      }
      const parts = [this.cardPart(target), ` gets ${signed(power)}/${signed(toughness)}`];
      const sourceId = annotation.affectorId;
      if (sourceId !== undefined && sourceId !== target && this.object(sourceId)?.parentId !== target) {
        parts.push(' from ', this.sourcePart(sourceId));
      }
      this.line('effect', this.controllerOf(target), parts);
    }
  }

  readTokens(annotation) {
    const groups = new Map();
    for (const id of annotation.affectedIds || []) {
      const object = this.object(id);
      if (!object) {
        continue;
      }
      const part = this.tokenPart(object);
      const seat = object.controllerSeatId ?? object.ownerSeatId;
      const key = `${seat}:${part.card}:${part.token}:${part.pt || ''}`;
      if (!groups.has(key)) {
        groups.set(key, { seat, part, count: 0 });
      }
      groups.get(key).count++;
    }

    for (const { seat, part, count } of groups.values()) {
      const parts = [{ player: seat }, ' creates '];
      parts.push(count === 1 ? `${article(part.token)} ` : `${count} `, count === 1 ? part : { ...part, count });
      this.line('token', seat, parts);
    }
  }

  readAttachment(annotation) {
    const attachment = annotation.affectorId;
    for (const target of annotation.affectedIds || []) {
      this.line('effect', this.controllerOf(attachment), [
        this.cardPart(attachment), ' is attached to ', this.cardPart(target)
      ]);
    }
  }

  readScry(annotation, details) {
    const top = details.topIds || [];
    const bottom = details.bottomIds || [];
    const seat = this.controllerOf(annotation.affectorId);
    const parts = [{ player: seat }, ` scries ${top.length + bottom.length}`];

    const describe = (ids, where) => {
      const known = ids.map(id => this.cardPart(id));
      return known.every(part => typeof part !== 'string')
        ? [...joinParts(known.map(part => [part])), where]
        : [ids.length === 1 ? `1 card${where}` : `${ids.length} cards${where}`];
    };
    const placed = [];
    if (top.length) {
      placed.push(describe(top, ' on top'));
    }
    if (bottom.length) {
      placed.push(describe(bottom, ' to the bottom'));
    }
    if (placed.length) {
      parts.push(': ', ...joinParts(placed));
    }
    this.line('effect', seat, parts);
  }

  readCastingOption(annotation, details) {
    if (!details.kickerAbilityGrpId?.[0]) {
      return;
    }
    const line = this.game.stackLines.get(annotation.affectorId);
    if (line && !line.kicked) {
      line.kicked = true;
      line.parts.splice(3, 0, ' with kicker');
    }
  }

  flushMessage() {
    const message = this.message;

    for (const [seat, { line, ids }] of message.draws) {
      const known = ids.map(id => this.cardPart(id));
      line.parts.push({ player: seat });
      if (known.every(part => typeof part !== 'string')) {
        line.parts.push(ids.length === 1 ? ' draws ' : ` draws ${ids.length} cards: `, ...joinParts(known.map(part => [part])));
      } else {
        line.parts.push(` draws ${plural(ids.length, 'card')}`);
      }
    }

    for (const [seat, damage] of message.playerDamage) {
      const parts = [{ player: seat }, ` takes ${damage.total}${damage.combat ? ' combat' : ''} damage from `];
      parts.push(...joinParts(damage.sources.map(({ source, amount }) =>
        damage.sources.length > 1 ? [source, ` (${amount})`] : [source]
      )));
      if (damage.life !== null) {
        parts.push({ life: damage.life });
      }
      damage.line.parts = parts;
    }

    for (const { line, tapped, controller, sourceId, ids } of message.taps.values()) {
      const verb = tapped ? ' taps ' : ' untaps ';
      line.parts = [sourceId !== null ? this.sourcePart(sourceId) : { player: controller }, verb];
      line.parts.push(...joinParts(ids.map(id => [this.cardPart(id)])));
    }

    this.message = null;
  }

  build() {
    const games = this.games
      .filter(game => game.lines.length > 0)
      .map(game => ({
        number: game.number,
        startedAt: game.startedAt ? new Date(game.startedAt).toISOString() : null,
        endedAt: game.endedAt ? new Date(game.endedAt).toISOString() : null,
        result: game.result,
        lines: game.lines.map(({ targets, kicked, ...line }) => line)
      }));

    if (games.length === 0) {
      return null;
    }

    const winner = this.matchResult && this.matchResult.result !== 'ResultType_Draw'
      ? this.seatOfTeam(this.matchResult.winningTeamId)
      : null;

    return {
      version: COURSE_VERSION,
      matchId: this.matchId,
      localSeat: this.localSeat,
      players: Array.from(this.players.values()).sort((a, b) => a.seat - b.seat),
      winner,
      complete: Boolean(this.matchResult) || games.every(game => game.result),
      games
    };
  }
}

function parseJson(line) {
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

function parseCourse(logText, matchId) {
  if (!logText || !ARENA_MATCH_ID.test(matchId || '')) {
    return null;
  }

  const first = logText.indexOf(matchId);
  if (first === -1) {
    return null;
  }
  const last = logText.lastIndexOf(matchId);
  const start = logText.lastIndexOf('\n', first) + 1;
  let end = logText.indexOf('\n', last);
  end = end === -1 ? logText.length : end;

  const builder = new CourseBuilder(matchId);
  const lines = logText.slice(start, end).split('\n');
  let header = null;

  for (const line of lines) {
    if (line.startsWith('[UnityCrossThreadLogger]')) {
      header = line;
    }
    if (line.startsWith('[Message summarized')) {
      builder.readSummarizedMessage();
    } else if (line.includes('"greToClientEvent"') || line.includes('"matchGameRoomStateChangedEvent"')) {
      builder.readLine(line, header);
      if (builder.done) {
        break;
      }
    }
  }

  return builder.build();
}

module.exports = { COURSE_VERSION, ARENA_MATCH_ID, parseCourse };
