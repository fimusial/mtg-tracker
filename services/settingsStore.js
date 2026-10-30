const fs = require('fs');
const path = require('path');
const DataStore = require('./dataStore');

class SettingsStore {
  static settingsFilePath() {
    return path.join(DataStore.dataDirectory(), 'settings.json');
  }

  constructor() {
    this.settingsFile = SettingsStore.settingsFilePath();
    this.settings = SettingsStore.loadSettings();
  }

  static loadSettings() {
    try {
      const settingsFile = SettingsStore.settingsFilePath();
      if (fs.existsSync(settingsFile)) {
        const content = fs.readFileSync(settingsFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }

    return {
      minimizeToTray: true,
      showNotifications: true,
      zoomFactor: 1
    };
  }

  saveSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  getSettings() {
    return this.settings;
  }
}

module.exports = SettingsStore;
