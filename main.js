const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const LogParser = require('./services/logParser');
const DataStore = require('./services/dataStore');
const SettingsStore = require('./services/settingsStore');
const CardUpdater = require('./services/cardUpdater');
const { CourseStore, courseCardIds } = require('./course/courseStore');

let mainWindow;
let tray;
let logWatcher;
let dataStore;
let settingsStore;
let courseStore;
let cardUpdater;
let isQuitting = false;

const MTGA_LOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'LocalLow',
  'Wizards Of The Coast',
  'MTGA'
);

function getLogPath() {
  const playerLog = path.join(MTGA_LOG_DIR, 'Player.log');
  const outputLog = path.join(MTGA_LOG_DIR, 'output_log.txt');

  if (fs.existsSync(playerLog)) {
    console.log('Found log file:', playerLog);
    return playerLog;
  }
  if (fs.existsSync(outputLog)) {
    console.log('Found log file:', outputLog);
    return outputLog;
  }

  return playerLog;
}

const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.5;

function clampZoom(factor) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(factor) || 1));
}

function applySavedZoom() {
  if (!mainWindow || !settingsStore) {
    return;
  }

  const zoom = clampZoom(settingsStore.getSettings().zoomFactor);

  if (mainWindow.isVisible()) {
    mainWindow.webContents.setZoomFactor(zoom);
  } else {
    mainWindow.once('show', () => {
      if (mainWindow) {
        mainWindow.webContents.setZoomFactor(zoom);
      }
    });
  }
}

function saveWindowState() {
  if (!mainWindow || !settingsStore || mainWindow.isMinimized()) {
    return;
  }

  const { x, y, width, height } = mainWindow.getNormalBounds();
  settingsStore.saveSettings({ window: { x, y, width, height, isMaximized: mainWindow.isMaximized() } });
}

function onScreenBounds({ x, y, width, height }) {
  if (![x, y, width, height].every(Number.isInteger)) {
    return { width, height };
  }

  const { workArea } = screen.getDisplayMatching({ x, y, width, height });
  const fittedWidth = Math.min(width, workArea.width);
  const fittedHeight = Math.min(height, workArea.height);

  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - fittedWidth)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - fittedHeight)),
    width: fittedWidth,
    height: fittedHeight
  };
}

function createWindow() {
  const { x, y, width = 1400, height = 1200, isMaximized = false } = settingsStore.getSettings().window || {};

  mainWindow = new BrowserWindow({
    ...onScreenBounds({ x, y, width, height }),
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'images/icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    show: false
  });

  mainWindow.loadFile('index.html');

  const openExternally = (url) => {
    // Only ever hand http(s) to the OS, never file:// or anything exotic.
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  };

  mainWindow.webContents.setWindowOpenHandler(({ url }) => openExternally(url));

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      openExternally(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (isMaximized) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  let saveStateTimer;
  const scheduleStateSave = () => {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(saveWindowState, 500);
  };
  mainWindow.on('resize', scheduleStateSave);
  mainWindow.on('move', scheduleStateSave);

  mainWindow.on('close', (event) => {
    clearTimeout(saveStateTimer);
    saveWindowState();

    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  let iconPath;
  try {
    const trayIconPath = path.join(__dirname, 'images/tray-icon.png');
    if (fs.existsSync(trayIconPath)) {
      iconPath = trayIconPath;
    } else {
      iconPath = null;
    }
  } catch (e) {
    iconPath = null;
  }

  try {
    if (iconPath) {
      tray = new Tray(iconPath);
    } else {
      const { nativeImage } = require('electron');
      const emptyIcon = nativeImage.createEmpty();
      tray = new Tray(emptyIcon);
    }
  } catch (e) {
    console.log('Could not create tray icon:', e.message);
    return null;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Tracker',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Status: Waiting for MTG Arena...',
      id: 'status',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('MTG Arena Tracker');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } else {
      createWindow();
    }
  });

  return contextMenu;
}

function updateTrayStatus(message) {
  if (tray) {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Tracker',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          }
        }
      },
      { type: 'separator' },
      {
        label: `Status: ${message}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`MTG Arena Tracker - ${message}`);
  }
}

function getPreviousLogPath(logPath) {
  const extension = path.extname(logPath);
  const name = path.basename(logPath, extension);
  return path.join(path.dirname(logPath), `${name}-prev${extension}`);
}

function scanLogForMatches(logFile, label, { includeInventory = false } = {}) {
  const empty = { events: 0, matches: 0, bytes: 0 };

  if (!fs.existsSync(logFile)) {
    console.log(`[${label}] No log found at:`, logFile);
    return empty;
  }

  try {
    const data = fs.readFileSync(logFile, 'utf8');
    const events = new LogParser().parse(data);

    const wanted = includeInventory ? ['MATCH_END', 'INVENTORY_UPDATE'] : ['MATCH_END'];
    const matchEvents = events.filter(event => event.type === 'MATCH_END');

    for (const event of events) {
      if (wanted.includes(event.type)) {
        handleGameEvent(event, { silent: true });
      }
    }

    recordMatchCourses(data, events);

    console.log(`[${label}] Scanned ${logFile}: ${matchEvents.length} match(es) from ${events.length} events`);
    return { events: events.length, matches: matchEvents.length, bytes: data.length };
  } catch (error) {
    console.error(`[${label}] Error scanning log:`, error.message);
    return empty;
  }
}

function trySendStatus(payload) {
  if (!mainWindow || !mainWindow.webContents) {
    return;
  }

  const wc = mainWindow.webContents;
  if (wc.isLoading()) {
    wc.once('did-finish-load', () => wc.send('update-status', payload));
  } else {
    wc.send('update-status', payload);
  }
}

function startLogWatcher(logPath) {
  if (logWatcher) {
    logWatcher.close();
  }

  if (!fs.existsSync(logPath)) {
    console.log('Log file not found at:', logPath);
    updateTrayStatus('Log file not found, check settings...');
    trySendStatus({ status: 'warning', text: 'Log file not found, check settings...' });
    return false;
  }

  logWatcher = chokidar.watch(logPath, {
    persistent: true,
    usePolling: true,
    interval: 1000,
    binaryInterval: 1000,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  let lastSize = 0;
  try {
    const stats = fs.statSync(logPath);
    lastSize = stats.size;
    console.log('Initial log size:', lastSize);
  } catch (e) {
    console.error('Error getting initial file size:', e);
  }

  console.log('[AutoScan] Starting auto-scan every 2 seconds...');
  setInterval(async () => {
    try {
      const stats = fs.statSync(logPath);
      const currentSize = stats.size;

      if (currentSize > 0) {
        const fullData = fs.readFileSync(logPath, 'utf8');

        if (Math.abs(currentSize - lastSize) > 100 || !lastSize) {
          lastSize = currentSize;

          const freshParser = new LogParser();
          const events = freshParser.parse(fullData);

          if (events.length > 0) {
            console.log(`[AutoScan] Parsed ${events.length} events from full log`);
            let matchCount = 0;
            for (const event of events) {
              if (event.type === 'MATCH_END') {
                matchCount++;
                console.log(`[AutoScan] Found match: ${event.data.matchId} - Result: ${event.data.result}`);
              }
              handleGameEvent(event);
            }

            recordMatchCourses(fullData, events);
            console.log(`[AutoScan] Processed ${matchCount} matches`);
          }
        }
      }
    } catch (error) {
      console.error('[AutoScan] Error in periodic log check:', error);
    }
  }, 2000);

  logWatcher.on('change', async (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      if (currentSize < lastSize) {
        console.log('Log file rotated, re-reading...');
        const fullData = fs.readFileSync(filePath, 'utf8');
        lastSize = fullData.length;

        const freshParser = new LogParser();
        const events = freshParser.parse(fullData);

        for (const event of events) {
          handleGameEvent(event);
        }
        recordMatchCourses(fullData, events);
      }
    } catch (error) {
      console.error('Error reading log file:', error);
    }
  });

  logWatcher.on('error', error => {
    console.error('Log watcher error:', error);
    updateTrayStatus('Error watching log');
    trySendStatus({ status: 'danger', text: 'Error watching log' });
  });

  console.log('Started watching log file:', logPath);
  updateTrayStatus('Connected - Watching for matches');
  trySendStatus({ status: 'success', text: 'Connected - Watching for matches' });

  return true;
}

function handleGameEvent(event, { silent = false } = {}) {
  console.log('Game event:', event.type, event.data);

  if (!dataStore) {
    console.error('dataStore not initialized, cannot save event');
    return;
  }

  switch (event.type) {
    case 'MATCH_START':
      updateTrayStatus('Match in progress...');
      trySendStatus({ status: 'success', text: 'Match in progress...' });
      break;

    case 'GAME_END':
      break;

    case 'MATCH_END':

      try {
        dataStore.addMatch(event.data);
        console.log('Match saved:', event.data);

        if (!silent) {
          updateTrayStatus(`Match ended: ${event.data.result}`);
          trySendStatus({ status: 'success', text: `Match ended: ${event.data.result}`, refresh: true });
        }

        if (event.data.playerDeck) {
          console.log('[Deck Save] Saving deck with card data:', JSON.stringify(event.data.playerDeck));
          dataStore.addDeck({
            name: event.data.deckName,
            format: event.data.format,
            mainDeck: event.data.playerDeck.deckCards,
            sideboard: event.data.playerDeck.sideboardCards,
            commandZone: event.data.playerDeck.commandZoneCards,
            timestamp: event.data.timestamp
          });
        } else {
          console.log('[Deck Save] No playerDeck data found in event');
        }

        const settings = settingsStore.getSettings();
        console.log('[Notification] Settings:', settings);
        console.log('[Notification] Tray available:', !!tray);
        console.log('[Notification] Show notifications:', settings.showNotifications);

        if (!silent && tray && settings.showNotifications !== false) {
          const result = event.data.result;
          const emoji = result === 'win' ? '🏆' : result === 'loss' ? '❌' : '🤝';
          console.log('[Notification] Displaying notification');

          if (process.platform === 'win32') {
            tray.displayBalloon({
              title: 'MTG Arena Tracker',
              content: `${emoji} Match ended: ${result.toUpperCase()}`,
              iconType: 'info'
            });
          } else {
            const notif = new Notification({
              title: 'MTG Arena Tracker',
              body: `${emoji} Match ended: ${result.toUpperCase()}`,
              icon: path.join(__dirname, 'images/icon.png')
            });
            notif.show();
          }
        } else {
          console.log('[Notification] Skipping notification - disabled or no tray');
        }
      } catch (e) {
        console.error('Error handling match end:', e);
      }
      break;

    case 'INVENTORY_UPDATE':

      try {
        dataStore.updateInventory(event.data);
        console.log('[Inventory] Updated:', event.data.gems, 'gems,', event.data.gold, 'gold,', event.data.totalVaultProgress, 'vault progress');
        if (mainWindow) {
          mainWindow.webContents.send('inventory-updated', dataStore.getInventory());
          console.log('[Inventory] Sent update to renderer');
        }
      } catch (e) {
        console.error('[Inventory] Error handling inventory update:', e);
      }
      break;

    case 'DECK_SUBMISSION':

      if (mainWindow) {
        mainWindow.webContents.send('deck-submitted', event.data);
      }
      break;

    case 'GRE_TO_CLIENT':

      break;
  }
}

function keptMatchIds() {
  return new Set(dataStore.getMatches().map(match => match.matchId));
}

function recordMatchCourses(logText, events) {
  if (!courseStore || !dataStore) {
    return;
  }
  try {
    courseStore.recordFromEvents(logText, events, keptMatchIds());
  } catch (error) {
    console.error('[Course] Error recording match courses:', error);
  }
}

function matchLogPaths() {
  const logPath = getLogPath();
  return [logPath, getPreviousLogPath(logPath)];
}

ipcMain.handle('get-match-course', async (event, id) => {
  if (!dataStore || !courseStore) return null;
  const match = dataStore.getMatch(id);
  if (!match) return null;

  const course = await courseStore.get(match.matchId, matchLogPaths());
  const cards = {};
  for (const cardId of courseCardIds(course)) {
    cards[cardId] = {
      name: dataStore.getCardName(cardId),
      manaCost: dataStore.getCardManaCost(cardId),
      scryfallUri: dataStore.getCardScryfallUri(cardId)
    };
  }
  return { match, course, cards };
});

ipcMain.handle('get-inventory', async () => {
  if (!dataStore) return null;
  return dataStore.getInventory();
});

ipcMain.handle('get-card-name', async (event, cardId) => {
  if (!dataStore) return `Card ${cardId}`;
  return dataStore.getCardName(cardId);
});

ipcMain.handle('get-deck', async (event, deckId) => {
  if (!dataStore) return null;
  const deck = dataStore.getDeck(deckId);
  if (deck) {
    const mainDeckWithNames = deck.mainDeck.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId),
      manaCost: dataStore.getCardManaCost(cardId),
      scryfallUri: dataStore.getCardScryfallUri(cardId)
    }));
    const sideboardWithNames = deck.sideboard.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId),
      manaCost: dataStore.getCardManaCost(cardId),
      scryfallUri: dataStore.getCardScryfallUri(cardId)
    }));
    const commandZoneWithNames = deck.commandZone.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId),
      manaCost: dataStore.getCardManaCost(cardId),
      scryfallUri: dataStore.getCardScryfallUri(cardId)
    }));
    return {
      ...deck,
      mainDeck: mainDeckWithNames,
      sideboard: sideboardWithNames,
      commandZone: commandZoneWithNames
    };
  }
  return deck;
});

ipcMain.handle('get-match-opponent-deck', async (event, matchId) => {
  if (!dataStore) return null;
  const match = dataStore.getMatch(matchId);
  if (!match) return null;
  const deck = match.opponentDeck || { name: 'Unknown Deck', colors: [], cards: [] };
  return {
    name: deck.name,
    colors: deck.colors,
    format: match.format,
    cards: deck.cards.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId),
      manaCost: dataStore.getCardManaCost(cardId),
      scryfallUri: dataStore.getCardScryfallUri(cardId)
    }))
  };
});

ipcMain.handle('get-stats', async () => {
  if (!dataStore) return { matches: [], decks: [] };
  return dataStore.getStats();
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('close-window', () => {
  isQuitting = true;
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('get-matches', async () => {
  if (!dataStore) return [];
  return dataStore.getMatches();
});

ipcMain.handle('get-decks', async () => {
  if (!dataStore) return [];
  return dataStore.getDecks();
});

ipcMain.handle('delete-match', async (event, matchId) => {
  if (!dataStore) return false;
  const match = dataStore.getMatch(matchId);
  dataStore.deleteMatch(matchId);
  if (match && courseStore) {
    courseStore.delete(match.matchId);
  }
  return true;
});

ipcMain.handle('clear-data', async () => {
  if (!dataStore) return false;
  dataStore.clearAll();
  if (courseStore) {
    courseStore.clear();
  }
  return true;
});

ipcMain.handle('export-data', async () => {
  if (!dataStore) return null;

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `mtg-arena-data-${new Date().toISOString().split('T')[0]}.json`,
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (!result.canceled) {
    dataStore.exportToFile(result.filePath);
    return result.filePath;
  }
  return null;
});

ipcMain.handle('import-data', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      dataStore.importFromFile(result.filePaths[0]);
      return true;
    } catch (e) {
      console.error('Import error:', e);
      return false;
    }
  }
  return false;
});

ipcMain.handle('refresh-log', async () => {
  const logPath = getLogPath();
  if (!fs.existsSync(logPath)) {
    return { success: false, error: 'Log file not found' };
  }

  try {
    const previous = scanLogForMatches(getPreviousLogPath(logPath), 'Manual Refresh (previous)');
    const current = scanLogForMatches(logPath, 'Manual Refresh', { includeInventory: true });

    return {
      success: true,
      eventsFound: previous.events + current.events,
      matchesProcessed: previous.matches + current.matches,
      bytesRead: previous.bytes + current.bytes
    };
  } catch (e) {
    console.error('[Manual Refresh] Error:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-log-path', async () => {
  return getLogPath();
});

ipcMain.handle('set-log-path', async (event, logPath) => {
  startLogWatcher(logPath);
  return true;
});

ipcMain.handle('set-zoom', async (event, factor) => {
  const zoom = clampZoom(factor);
  if (mainWindow) {
    mainWindow.webContents.setZoomFactor(zoom);
  }
  return zoom;
});

ipcMain.handle('get-settings', async () => {
  if (!settingsStore) return {};
  return settingsStore.getSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
  if (!settingsStore) return false;
  settingsStore.saveSettings(settings);
  return true;
});

ipcMain.handle('get-card-db-status', async () => {
  try {
    const cardsPath = DataStore.cardsFilePath();
    if (!fs.existsSync(cardsPath)) {
      return { exists: false, cardCount: 0, lastUpdated: null };
    }

    const content = fs.readFileSync(cardsPath, 'utf8');
    const data = JSON.parse(content);
    const cardCount = Object.keys(data.cards || {}).length;

    return {
      exists: true,
      cardCount,
      lastUpdated: data.lastUpdated || null,
      source: data.source || 'unknown',
      sourceUpdatedAt: data.sourceUpdatedAt || null
    };
  } catch (error) {
    return { exists: false, cardCount: 0, error: error.message };
  }
});

ipcMain.handle('update-card-db', async () => {
  if (!cardUpdater) {
    cardUpdater = new CardUpdater(DataStore.cardsFilePath());
  }

  try {
    const result = await cardUpdater.update({ force: true });

    if (dataStore) {
      dataStore.reloadCards();
    }

    return {
      success: true,
      updated: result,
      cardCount: Object.keys(cardUpdater.cardsData.cards || {}).length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('test-notification', async () => {
  try {
    const settings = settingsStore.getSettings();
    console.log('[Test Notification] Settings:', settings);
    console.log('[Test Notification] Tray available:', !!tray);

    if (!tray) {
      return { success: false, error: 'Tray not available' };
    }

    if (settings.showNotifications === false) {
      return { success: false, error: 'Notifications are disabled in settings' };
    }

    const isWindows = process.platform === 'win32';
    console.log('[Test Notification] Platform:', process.platform);

    let notificationMethod = 'balloon';

    if (isWindows) {
      tray.displayBalloon({
        title: 'MTG Arena Tracker - Test',
        content: '🏆 This is a test notification! Match ended: WIN',
        iconType: 'info'
      });
      console.log('[Test Notification] Balloon displayed');
    } else {
      notificationMethod = 'native';
      const notification = new Notification({
        title: 'MTG Arena Tracker - Test',
        body: '🏆 This is a test notification! Match ended: WIN',
        icon: path.join(__dirname, 'images/icon.png')
      });
      notification.show();
      console.log('[Test Notification] Native notification displayed');
    }

    return {
      success: true,
      platform: process.platform,
      isWindows,
      method: isWindows ? 'balloon' : 'native',
      troubleshooting: isWindows ? [
        'Notification sent to Windows tray. If you don\'t see it:',
        '1. Check Windows Settings → System → Notifications',
        '2. Make sure "MTG Arena Tracker" is allowed to show notifications',
        '3. Check Focus Assist is not blocking notifications (Win+A)',
        '4. Look in the system tray area for the notification icon',
        '5. Some notifications only show in Action Center (bottom-right corner)',
        '6. Try running the app as Administrator if notifications still don\'t appear'
      ].join('\n') : 'Using native notification API'
    };
  } catch (error) {
    console.error('[Test Notification] Error:', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(async () => {
  settingsStore = new SettingsStore();
  createWindow();
  createTray();
  trySendStatus({ status: 'success', text: 'Starting...' });

  cardUpdater = new CardUpdater(DataStore.cardsFilePath());
  dataStore = new DataStore();
  courseStore = new CourseStore(dataStore.dataDir);
  dataStore.onMatchesRetired = matches => matches.forEach(match => courseStore.delete(match.matchId));
  courseStore.prune(keptMatchIds());
  applySavedZoom();

  const logPath = getLogPath();
  console.log('Using log path:', logPath);

  startLogWatcher(logPath);

  courseStore.recordFromLogs(matchLogPaths(), Array.from(keptMatchIds()))
    .catch(error => console.error('[Course] Error recording courses from logs:', error));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  console.log('[App] Checking for card database updates...');
  cardUpdater.update()
    .then(updated => updated
      ? console.log('[App] Card database was updated')
      : console.log('[App] Card database is up to date'))
    .catch(error =>
      console.error('[App] Failed to update card database:', error.message));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (logWatcher) {
    logWatcher.close();
  }
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
