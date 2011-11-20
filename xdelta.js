
var child = require('child_process');
var sys = require('sys');
var fs = require('fs');

exports.diff = function(iSrc, iDest, iCallback) {
  /*if (typeof iCallback === 'undefined' && typeof oList === 'function') {
    iCallback = oList;
    oList = null;
  }*/
  var aC = child.spawn('xdelta3', iSrc ? ['-e', '-s', iSrc, iDest] : ['-e', iDest]);
  var aErr = 'unknown error';
  aC.stderr.on('data', function(data) { aErr = data.toString() });
  var aBufLen = 0, aBufList = [];
  aC.stdout.on('data', function(data) { aBufList.push(data); aBufLen += data.length; });
  aC.on('exit', function(code) {
    if (code)
      return iCallback(new Error('xdDiff failed: '+aErr));
    if (aBufList.length === 1)
      return iCallback(null, aBufList[0]);
    var aDiff = new Buffer(aBufLen);
    for (var a=0, aOff=0; a < aBufList.length; aOff += aBufList[a++].length)
      aBufList[a].copy(aDiff, aOff, 0);
    iCallback(null, aDiff);
  });
}

function noop(err) { if (err) throw err }

exports.patch = function(iSrc, iDiff, iDest, iCallback) {
  var aC = child.spawn('xdelta3', iSrc ? ['-d', '-c', '-s', iSrc] : ['-d', '-c']);
  var aErr = 'unknown error';
  aC.stderr.on('data', function(data) { aErr = data.toString() });
  sys.pump(aC.stdout, fs.createWriteStream(iDest), noop);
  aC.on('exit', function(code) {
    iCallback(code ? new Error('xdPatch failed: '+aErr) : undefined);
  });
  aC.stdin.end(iDiff);
}

