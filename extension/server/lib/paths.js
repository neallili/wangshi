'use strict';
const os = require('os');
const path = require('path');

const dataDir = () => path.join(os.homedir(), '.wangshi');
const dbPath = () => path.join(dataDir(), 'wangshi.db');
const downloadsDir = () => path.join(os.homedir(), 'Downloads');

module.exports = { dataDir, dbPath, downloadsDir };
