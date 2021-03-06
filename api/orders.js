var _                       = require('lodash');
var Promise                 = require('bluebird');
var radr                  = require('radr-lib');
var remote                  = require('./../lib/remote.js');
var transactions            = require('./transactions');
var SubmitTransactionHooks  = require('./../lib/submit_transaction_hooks.js');
var respond                 = require('./../lib/response-handler.js');
var utils                   = require('./../lib/utils');
var errors                  = require('./../lib/errors.js');
var TxToRestConverter       = require('./../lib/tx-to-rest-converter.js');
var validator               = require('./../lib/schema-validator.js');
var bignum                  = require('bignumber.js');

const InvalidRequestError   = errors.InvalidRequestError;

const OfferCreateFlags = {
  Passive:            { name: 'passive', set: 'Passive' },
  ImmediateOrCancel:  { name: 'immediate_or_cancel', set: 'ImmediateOrCancel' },
  FillOrKill:         { name: 'fill_or_kill', set: 'FillOrKill' } 
};

const DefaultPageLimit = 200;

/**
 * Get orders from the ripple network
 *
 *  @query
 *  @param {String} [request.query.limit]    - Set a limit to the number of results returned
 *  @param {String} [request.query.marker]   - Used to paginate results
 *  @param {String} [request.query.ledger]   - The ledger index to query against (required if request.query.marker is present)
 *
 *  @url
 *  @param {RadrAddress} request.params.account  - The ripple address to query orders
 *
 *  @param {Express.js Response} response
 *  @param {Express.js Next} next
 */
function getOrders(request, response, next) {
  var options = request.params;

  options.isAggregate = request.param('limit') === 'all';

  Object.keys(request.query).forEach(function(param) {
    options[param] = request.query[param];
  });

  validateOptions(options)
  .then(getAccountOrders)
  .then(respondWithOrders)
  .catch(next);

  function validateOptions(options) {
    if (!radr.UInt160.is_valid(options.account)) {
      return Promise.reject(new InvalidRequestError('Parameter is not a valid Radr address: account'));
    }

    return Promise.resolve(options);
  };

  function getAccountOrders(options, prevResult) {
    if (prevResult && (!options.isAggregate || !prevResult.marker)) {
      return Promise.resolve(prevResult);
    }

    var promise = new Promise(function(resolve, reject) {
      var accountOrdersRequest;
      var marker;
      var ledger;
      var limit;

      if (prevResult) {
        marker = prevResult.marker;
        limit  = prevResult.limit;
        ledger = prevResult.ledger_index;
      } else {
        marker = request.query.marker;
        limit  = validator.isValid(request.query.limit, 'UINT32') ? Number(request.query.limit) : DefaultPageLimit;
        ledger = utils.parseLedger(request.query.ledger);
      }

      accountOrdersRequest = remote.requestAccountOffers({
        account: options.account,
        marker: marker,
        limit: limit,
        ledger: ledger
      });

      accountOrdersRequest.once('error', reject);
      accountOrdersRequest.once('success', function(nextResult) {
        nextResult.offers = prevResult ? nextResult.offers.concat(prevResult.offers) : nextResult.offers;
        resolve([options, nextResult]);
      });
      accountOrdersRequest.request();
    });

    return promise.spread(getAccountOrders);
  };

  function getParsedOrders(offers) {
    return _.reduce(offers, function(orders, off) {
      var sequence = off.seq;
      var passive = off.flags === radr.Remote.flags.offer.Passive;
      var type = off.flags === radr.Remote.flags.offer.Sell ? 'sell' : 'buy'

      var taker_gets = utils.parseCurrencyAmount(off.taker_gets);
      var taker_pays = utils.parseCurrencyAmount(off.taker_pays);

      orders.push({
        type: type,
        taker_gets: taker_gets,
        taker_pays: taker_pays,
        sequence: sequence,
        passive: passive,
      });

      return orders;
    },[]);
  }

  function respondWithOrders(result) {
    var promise = new Promise(function (resolve, reject) {
      var orders = {};

      if (result.marker) {
        orders.marker = result.marker;
      }

      orders.limit     = result.limit;
      orders.ledger    = result.ledger_index;
      orders.validated = result.validated;
      orders.orders    = getParsedOrders(result.offers);

      resolve(respond.success(response, orders));
    });

    return promise;
  }
};

/**
 *  Submit an order to the radr network
 *
 *  More information about order flags can be found at https://radr.com/build/transactions/#offercreate-flags
 *
 *  @body
 *  @param {Order} request.body.order                         - Object that holds information about the order
 *  @param {String "buy"|"sell"} request.body.order.type      - Choose whether to submit a buy or sell order
 *  @param {Boolean} [request.body.order.passive]             - Set whether order is passive
 *  @param {Boolean} [request.body.order.immediate_or_cancel] - Set whether order is immediate or cancel
 *  @param {Boolean} [request.body.order.fill_or_kill]        - Set whether order is fill or kill
 *  @param {String} request.body.order.taker_gets             - Amount of a currency the taker receives for consuming this order
 *  @param {String} request.body.order.taker_pays             - Amount of a currency the taker must pay for consuming this order
 *  @param {String} request.body.secret                       - YOUR secret key. Do NOT submit to an unknown radr-rest server
 *  
 *  @query
 *  @param {String "true"|"false"} request.query.validated    - used to force request to wait until radrd has finished validating the submitted transaction
 *
 *  @param {Express.js Response} response
 *  @param {Express.js Next} next
 */
function placeOrder(request, response, next) {
  var params = request.params;

  Object.keys(request.body).forEach(function(param) {
    params[param] = request.body[param];
  });

  var options = {
    secret: params.secret,
    validated: request.query.validated === 'true'
  };

  var hooks = {
    validateParams: validateParams,
    formatTransactionResponse: TxToRestConverter.parseSubmitOrderFromTx,
    setTransactionParameters: setTransactionParameters
  };

  transactions.submit(options, new SubmitTransactionHooks(hooks), function(err, placedOrder) {
    if (err) {
      return next(err);
    }

    respond.success(response, placedOrder);
  });
  
  function validateParams(callback) {
    if (!params.order) {
      return callback(new InvalidRequestError('Missing parameter: order. Submission must have order object in JSON form'));
    } else {
      if (params.order.taker_gets && params.order.taker_gets.currency !== 'XRP') {
        params.order.taker_gets.issuer = params.order.taker_gets.counterparty;
        delete params.order.taker_gets.counterparty;
      }

      if (params.order.taker_pays && params.order.taker_pays.currency !== 'XRP') {
        params.order.taker_pays.issuer = params.order.taker_pays.counterparty;
        delete params.order.taker_pays.counterparty;
      }
    }

    if (!radr.UInt160.is_valid(params.account)) {
      return callback(new errors.InvalidRequestError('Parameter is not a valid Radr address: account'));
    } else if (!/^buy|sell$/.test(params.order.type)) {
      return callback(new InvalidRequestError('Parameter must be "buy" or "sell": type'));
    } else if (!_.isUndefined(params.order.passive) && !_.isBoolean(params.order.passive)) {
      return callback(new InvalidRequestError('Parameter must be a boolean: passive'));
    } else if (!_.isUndefined(params.order.immediate_or_cancel) && !_.isBoolean(params.order.immediate_or_cancel)) {
      return callback(new InvalidRequestError('Parameter must be a boolean: immediate_or_cancel'));
    } else if (!_.isUndefined(params.order.fill_or_kill) && !_.isBoolean(params.order.fill_or_kill)) {
      return callback(new InvalidRequestError('Parameter must be a boolean: fill_or_kill'));
    } else if (!params.order.taker_gets || (!validator.isValid(params.order.taker_gets, 'Amount')) || (!params.order.taker_gets.issuer && params.order.taker_gets.currency !== 'XRP')) {
      callback(new InvalidRequestError('Parameter must be a valid Amount object: taker_gets'));
    } else if (!params.order.taker_pays || (!validator.isValid(params.order.taker_pays, 'Amount')) || (!params.order.taker_pays.issuer && params.order.taker_pays.currency !== 'XRP')) {
      callback(new InvalidRequestError('Parameter must be a valid Amount object: taker_pays'));
    } else {
      callback();
    }
  };

  function setTransactionParameters(transaction) {
    var takerPays = params.order.taker_pays.currency !== 'VRP' || params.order.taker_pays.currency !== 'VBC' ? params.order.taker_pays : utils.xrpToDrops(params.order.taker_pays);
    var takerGets = params.order.taker_gets.currency !== 'VRP' || params.order.taker_pays.currency !== 'VBC' ? params.order.taker_gets : utils.xrpToDrops(params.order.taker_gets);

    transaction.offerCreate(params.account, radr.Amount.from_json(takerPays), radr.Amount.from_json(takerGets));

    transactions.setTransactionBitFlags(transaction, {
      input: params.order,
      flags: OfferCreateFlags
    });

    if (params.order.type === 'sell') {
      transaction.setFlags('Sell');
    }
  };
};

/**
 *  Cancel an order in the radr network
 *
 *  @url
 *  @param {Number String} request.params.sequence - sequence number of order to cancel
 *
 *  @query
 *  @param {String "true"|"false"} request.query.validated - used to force request to wait until radrd has finished validating the submitted transaction
 *
 *  @param {Express.js Response} response
 *  @param {Express.js Next} next
 */
function cancelOrder(request, response, next) {
  var params = request.params;

  Object.keys(request.body).forEach(function(param) {
    params[param] = request.body[param];
  });

  var options = {
    secret: params.secret,
    validated: request.query.validated === 'true'
  };

  var hooks = {
    validateParams: validateParams,
    formatTransactionResponse: TxToRestConverter.parseCancelOrderFromTx,
    setTransactionParameters: setTransactionParameters
  }

  transactions.submit(options, new SubmitTransactionHooks(hooks), function(err, canceledOrder) {
    if (err) {
      return next(err);
    }

    respond.success(response, canceledOrder);
  });

  function validateParams(callback) {
    if (!(Number(params.sequence) >= 0)) {
      callback(new InvalidRequestError('Invalid parameter: sequence. Sequence must be a positive number'));
    } else if (!radr.UInt160.is_valid(params.account)) {
      callback(new InvalidRequestError('Parameter is not a valid Radr address: account'));
    } else {
      callback();
    }
  };

  function setTransactionParameters(transaction) {
    transaction.offerCancel(params.account, params.sequence);
  };
};

/**
 *  Get the most recent spapshot of the order book for a currency pair
 *
 *  @url
 *  @param {RadrAddress} request.params.account - The radr address to use as point-of-view (returns unfunded orders for this account)
 *  @param {String ISO 4217 Currency Code + RadrAddress} request.params.base    - Base currency as currency+issuer
 *  @param {String ISO 4217 Currency Code + RadrAddress} request.params.counter - Counter currency as currency+issuer
 *
 *  @query
 *  @param {String} [request.query.limit] - Set a limit to the number of results returned
 *
 *  @param {Express.js Request} request
 *  @param {Express.js Response} response
 *  @param {Express.js Next} next
 */
function getOrderBook(request, response, next) {
  var options = request.params;

  Object.keys(request.query).forEach(function(param) {
    options[param] = request.query[param];
  });

  parseOptions(options)
  .then(validateOptions)
  .then(getLastValidatedLedger)
  .then(getBidsAndAsks)
  .spread(respondWithOrderBook)
  .catch(next);

  function parseOptions(options) {
    options.validated  = true;
    options.order_book = options.base + '/' + options.counter;
    options.base       = utils.parseCurrencyQuery(options.base);
    options.counter    = utils.parseCurrencyQuery(options.counter);

    return Promise.resolve(options);
  }

  function validateOptions(options) {
    return new Promise(function(resolve, reject) {
      if (!radr.UInt160.is_valid(options.account)) {
        reject(new InvalidRequestError('Parameter is not a valid Radr address: account'));
      }

      if (!options.base.currency) {
        reject(new InvalidRequestError('Invalid parameter: base. Must be a currency string in the form currency+counterparty'));
      }

      if (!validator.isValid(options.base.currency, 'Currency')) {
        reject(new InvalidRequestError('Invalid parameter: base. Must be a currency string in the form currency+counterparty'));
      }

      if (options.base.currency !== 'XRP' && (!options.base.issuer || !radr.UInt160.is_valid(options.base.issuer))) {
        reject(new InvalidRequestError('Invalid parameter: base. Must be a currency string in the form currency+counterparty'));
      }

      if (!options.counter.currency) {
        reject(new InvalidRequestError('Invalid parameter: counter. Must be a currency string in the form currency+counterparty'));
      }

      if (!validator.isValid(options.counter.currency, 'Currency')) {
        reject(new InvalidRequestError('Invalid parameter: counter. Must be a currency string in the form currency+counterparty'));
      }

      if (options.counter.currency !== 'XRP' && (!options.counter.issuer || !radr.UInt160.is_valid(options.counter.issuer))) {
        reject(new InvalidRequestError('Invalid parameter: counter. Must be a currency string in the form currency+counterparty'));
      }

      if (options.counter.currency === 'XRP' && options.counter.issuer) {
        reject(new InvalidRequestError('Invalid parameter: counter. XRP cannot have counterparty'));
      }

      if (options.base.currency === 'XRP' && options.base.issuer) {
        reject(new InvalidRequestError('Invalid parameter: base. XRP cannot have counterparty'));
      }

      resolve(options);
    });
  }

  function getLastValidatedLedger(options) {
    var promise = new Promise(function (resolve, reject) {
      var ledgerRequest = remote.requestLedger('validated');

      ledgerRequest.once('success', function(res) {
        options.ledger = res.ledger.ledger_index;
        resolve(options);
      });

      ledgerRequest.once('error', reject);
      ledgerRequest.request();
    });

    return promise;
  }

  function getBookOffers(taker_gets, taker_pays, options) {
    var promise = new Promise(function (resolve, reject) {
      var bookOffersRequest = remote.requestBookOffers({
        taker_gets: taker_gets,
        taker_pays: taker_pays,
        ledger: options.ledger,
        limit: options.limit,
        taker: options.account
      });

      bookOffersRequest.once('success', resolve);
      bookOffersRequest.once('error', reject);
      bookOffersRequest.request();
    });

    return promise;
  }

  function getBids(options) {
    var taker_gets = options.counter;
    var taker_pays = options.base;

    return getBookOffers(taker_gets, taker_pays, options);
  }

  function getAsks(options) {
    var taker_gets = options.base;
    var taker_pays = options.counter;

    return getBookOffers(taker_gets, taker_pays, options);
  }

  function getBidsAndAsks(options) {
    return Promise.join(
      getBids(options),
      getAsks(options),
      function(bids, asks) {
        return [bids,asks, options];
      }
    );
  }

  function respondWithOrderBook(bids, asks, options) {
    var promise = new Promise(function (resolve, reject) {
      var orderBook = {
        order_book: options.order_book,
        ledger: options.ledger,
        validated: options.validated,
        bids:  getParsedBookOffers(bids.offers),
        asks:  getParsedBookOffers(asks.offers, true)
      };

      resolve(respond.success(response, orderBook));
    });

    return promise;
  }

  function getParsedBookOffers(offers, isAsk) {
    return offers.reduce(function(orderBook, off) {
      var price;
      var order_maker = off.Account;
      var sequence = off.Sequence;

      // Transaction Flags
      var passive = off.Flags === radr.Remote.flags.offer.Passive;
      var sell = off.Flags === radr.Remote.flags.offer.Sell;

      var taker_gets_total =  utils.parseCurrencyAmount(off.TakerGets);
      var taker_gets_funded = off.taker_gets_funded ? utils.parseCurrencyAmount(off.taker_gets_funded) : taker_gets_total;

      var taker_pays_total =  utils.parseCurrencyAmount(off.TakerPays);
      var taker_pays_funded = off.taker_pays_funded ? utils.parseCurrencyAmount(off.taker_pays_funded) : taker_pays_total;

      if (isAsk) {
        price = {
          currency: taker_pays_total.currency,
          counterparty: taker_pays_total.counterparty,
          value: bignum(taker_pays_total.value).div(bignum(taker_gets_total.value))
        };
      } else {
        price = {
          currency: taker_gets_total.currency,
          counterparty: taker_gets_total.counterparty,
          value: bignum(taker_gets_total.value).div(bignum(taker_pays_total.value))
        };
      }

      price.value = price.value.toString();

      orderBook.push({
        price: price,
        taker_gets_funded: taker_gets_funded,
        taker_gets_total: taker_gets_total,
        taker_pays_funded: taker_pays_funded,
        taker_pays_total: taker_pays_total,
        order_maker: order_maker,
        sequence: sequence,
        passive: passive,
        sell: sell
      });

      return orderBook;
    }, []);
  }
}

/**
 *  Get an Order transaction (`OfferCreate` or `OfferCancel`)
 *
 *  @url
 *  @param {RadrAddress} request.params.account
 *  @param {String} request.params.identifier
 *
 *  @param {Express.js Request} request
 *  @param {Express.js Response} response
 *  @param {Express.js Next} next
 */
function getOrder(request, response, next) {
  var options = request.params;

  validateOptions(options)
  .then(getOrderTx)
  .then(respondWithOrder)
  .catch(next);

  function validateOptions(options) {
    return new Promise(function(resolve, reject) {
      if (!radr.UInt160.is_valid(options.account)) {
        reject(new InvalidRequestError('Parameter is not a valid Radr address: account'));
      }
      if (!validator.isValid(options.identifier, 'Hash256')) {
        reject(new InvalidRequestError('Parameter is not a valid transaction hash: identifier'));
      }

      resolve(options);
    });
  }

  function getOrderTx(options) {
    return new Promise(function(resolve, reject) {
      var txRequest = remote.requestTx({
        hash: options.identifier
      });

      txRequest.once('error', reject);
      txRequest.once('transaction', function(res) {
        if (res.TransactionType !== 'OfferCreate' && res.TransactionType !== 'OfferCancel') {
          reject(new InvalidRequestError('Invalid parameter: identifier. The transaction corresponding to the given identifier is not an order'));
        } else {
          resolve(TxToRestConverter.parseOrderFromTx(res, options));
        }
      });
      txRequest.request();
    });
  }

  function respondWithOrder(order) {
    return new Promise(function(resolve, reject) {
      resolve(respond.success(response, order));
    });
  }
}

module.exports = {
  getOrders: getOrders,
  placeOrder: placeOrder,
  cancelOrder: cancelOrder,
  getOrderBook: getOrderBook,
  getOrder: getOrder
};
