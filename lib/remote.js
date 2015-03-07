var radr  = require('radr-lib');
var config = require('./config');
var logger = require('./logger.js').logger;

var remoteOpts = {
  servers: config.get('radrd_servers'),
  max_fee: parseFloat(config.get('max_transaction_fee'))
};

if (config.get('debug')) {
  remoteOpts.trace = true;
}

var remote = new radr.Remote(remoteOpts);

function prepareRemote() {
  var connect = remote.connect;
  var connected = false;

  function ready() {
    if (!connected) {
      logger.info('[RIPD] Connection established');
      connected = true;
    }
  };

  remote.connect = function() {
    logger.info('[RIPD] Attempting to connect to the Radr network...');
    connect.apply(remote, arguments);
  };

  remote.on('error', function(err) {
    logger.error('[RIPD] error: ', err);
  });

  remote.on('disconnect', function() {
    logger.info('[RIPD] Disconnected from the Radr network');
    connected = false;
  });

  remote._servers.forEach(function(server) {
    server.on('connect', function() {
      logger.info('[RIPD] Connected to radrd server:', server.getServerID());
      server.once('ledger_closed', ready);
    });
    server.on('disconnect', function() {
      logger.info('[RIPD] Disconnected from radrd server:', server.getServerID());
    });
  });

  process.on('SIGHUP', function() {
    logger.info('Received signal SIGHUP, reconnecting to Radr network');
    remote.reconnect();
  });

  setInterval(function() {
    var pingRequest = remote.request('ping');
    pingRequest.on('error', function(){});
    pingRequest.broadcast();
  }, 1000 * 15);

  remote.connect();
};

if (config.get('NODE_ENV') !== 'test') {
  prepareRemote();
}

module.exports = remote;
