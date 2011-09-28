
var sqlite = require('sqlite');
module.exports = sqlite;


sqlite.Database.prototype.prepareN = function(ioSet, iCallback, _async) {
  var that = this;
  for (var a in ioSet) {
    if (typeof ioSet[a] !== 'string')
      continue;
    that.prepare(ioSet[a], function(err, stmt) {
      if (err) return iCallback(err);
      ioSet[a] = stmt;
      that.prepareN(ioSet, iCallback, 1);
    });
    return;
  }
  if (!_async)
    process.nextTick(iCallback);
  else
    iCallback();
};

sqlite.Database.finalizeN = function(ioSet) {
  for (var a in ioSet) {
    if (typeof ioSet[a].finalize === 'function')
      ioSet[a].finalize();
    else
      exports.Database.finalizeN(ioSet[a]);
    delete ioSet[a];
  }
};

sqlite.Database.prototype.exec = function(iSql, iRowCallback, iDoneCallback) {
  var that = this;
  that.prepare(iSql, function(err, stmt) {
    if (err) return iRowCallback(err);
    stmt.step(fStepCall);
    function fStepCall(stepErr, row) {
      if (stepErr)
        stepErr.sql = stmt.sql();
      iRowCallback(stepErr, row);
      if (row) {
        stmt.step(fStepCall);
      } else {
        stmt.finalize();
        if (stepErr)
          return;
        if (stmt.tail)
          that.exec(stmt.tail, iRowCallback, iDoneCallback);
        else if (iDoneCallback)
          iDoneCallback();
      }
    }
  });
};

sqlite.Statement.prototype.bindN = function(iArgument) {
  for (var a=0; a < arguments.length; ++a)
    this.bind(a+1, arguments[a]);
};

sqlite.Statement.prototype.results = function(iOptionalParseColumns, iCallback) {
  var aList = [];
  var iArgs = arguments;
  var iDoneCallback = iArgs[iArgs.length-1];
  this.step(fStepCall);
  function fStepCall(err, row) {
    if (err) return iDoneCallback(err);
    if (row) {
      for (var a=0; a < iArgs.length-1; ++a)
        row[iArgs[a]] = JSON.parse(row[iArgs[a]]);
      aList.push(row);
      this.step(fStepCall);
    } else {
      this.reset();
      iDoneCallback(null, aList);
    }
  }
};

sqlite.Statement.prototype.stepOnce = function(iCallback) {
  this.step(function(err, row) {
    this.reset();
    iCallback(err, row);
  });
};

