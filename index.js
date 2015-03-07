const router = require(__dirname+'/lib/router.js');
const remote = require(__dirname+'/lib/remote.js');

function RadrRestPlugin() {
  this.router = router;
  this.remote = remote;
}

module.exports = RadrRestPlugin;

