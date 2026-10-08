// Scenario registry: name -> async function. Order matters only within a scenario; each scenario starts from the same server.
module.exports = {
  rider: require('./rider'),
  driver: require('./driver'),
  ride: require('./ride'),
  platform: require('./platform'),
  business: require('./business'),
  uploads: require('./uploads'),
  legacy: require('./legacy')
};
