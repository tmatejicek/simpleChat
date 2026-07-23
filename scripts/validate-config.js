'use strict';

require('dotenv').config();

const {readConfig, validateConfig} = require('../src/config');

validateConfig(readConfig());
console.log('Configuration is valid');
