var _         = require('lodash');
var bignum    = require('bignumber.js');
var config    = require('./config.js');
var pJson     = require('./../package.json');
var validator = require('./schema-validator.js');

module.exports = {
  dropsToXrp: dropsToXrp,
  xrpToDrops: xrpToDrops,
  getPackageVersion: getPackageVersion,
  getApiVersion: getApiVersion,
  getUrlBase: getUrlBase,
  parseLedger: parseLedger,
  parseCurrencyAmount: parseCurrencyAmount,
  parseCurrencyQuery: parseCurrencyQuery
};

function dropsToXrp(drops) {
  if(typeof drops === 'string'){
    return {
      value: bignum(drops).dividedBy(1e6).toString(),
      currency: 'VRP',
      issuer: ''
    }
  }
  return {
    value: bignum(drops.value).dividedBy(1e6).toString(),
    currency: drops.currency,
    issuer: drops.issuer || ''
  };
}

function xrpToDrops(xrp) {
  if(typeof xrp === 'string'){
    return {
      value: bignum(xrp).times(1e6).toString(),
      currency: 'VRP',
      issuer: ''
    }
  }
  return {
    value: bignum(xrp.value).times(1e6).toString(),
    currency: xrp.currency,
    issuer: xrp.issuer || ''
  };
}

function getPackageVersion() {
  return pJson.version;
}

function getApiVersion() {
  var pattern = /([0-9])(?:\.)/g;
  return pattern.exec(pJson.apiVersion)[1];
}

function getUrlBase(request) {
  if (config.get('url_base')) {
    return config.get('url_base');
  }
  return request.protocol + '://' + request.hostname + (config && config.get('port') ? ':' + config.get('port') : '');
}

function isValidHash256(hash) {
  return validator.isValid(hash,'Hash256');
}

function parseLedger(ledger) {
  if (/^current$|^closed$|^validated$/.test(ledger)) {
    return ledger;
  }

  if (ledger && Number(ledger) >= 0 && isFinite(Number(ledger))) {
    return Number(ledger);
  }

  if (isValidHash256(ledger)) {
    return ledger;
  }

  return 'validated';
}

function parseCurrencyAmount(currencyAmount) {
  if (typeof currencyAmount === 'string') {
    return {
      currency: 'VRP',
      counterparty: '',
      value: dropsToXrp(currencyAmount)
    };
  } else {
    return {
      currency: currencyAmount.currency,
      counterparty: currencyAmount.issuer,
      value: currencyAmount.value
    };
  }
}

function parseCurrencyQuery(query) {
  var params = query.split('+');

  if (!isNaN(params[0])) {
    return {
      value:    (params.length >= 1 ? params[0] : ''),
      currency: (params.length >= 2 ? params[1] : ''),
      issuer:   (params.length >= 3 ? params[2] : '')
    };
  } else {
    return {
      currency: (params.length >= 1 ? params[0] : ''),
      issuer:   (params.length >= 2 ? params[1] : '')
    };
  }
}
