
// test directory manager for elembe
//
// make test-name node-name [node-name2 ...]
//   add a new test
//
// update
//   recreate all test data for new schema
//
// run node-name first-test-name [last-test-name]
//   run a test or sequence

var sDir = 'test/';
var sNextdata = 'Nextdata';
var sRecording = 'recording';
var sData = 'data-test';
var sDataArg = sData.slice(5);
var sPort = 8900;

process.on('SIGINT', function() {});

function main(argv) {
  argv.shift();
  mkdir(sDir);

  switch(argv[1]) {
  case 'make':
    if (argv.length < 4) return console.log('missing arguments');
    var aCmd = [];
    for (var aN=0; aN+3 < argv.length; ++aN) {
      var aData = sData+aN;
      var aRecording = sRecording+aN;
      if (stat(aData))      return console.log(aData      +' already exists');
      if (stat(aRecording)) return console.log(aRecording +' already exists');
      var aDataArg = sDataArg+aN;
      var aPort = sPort+aN;
      var aNode = sDir+argv[aN+3]+'/';
      var aNext = aNode+sNextdata;
      var aItem = readdir(aNode);
      if (!aItem || !aItem.length) {
        aItem = 'a0';
      } else {
        aItem = aItem.sort().pop();
        if (aItem.charAt(2) !== '_')   return console.log('unexpected last test "'+aItem+'" in '+aNode);
        if (aItem.slice(0,2) === 'zz') return console.log(aNode+' has max number of tests');
        aItem = (parseInt(aItem.slice(0,2), 36) +1).toString(36);
      }
      var aTest = aNode+aItem+'_'+argv[2];
      if (stat(aTest)) return console.log(aTest+' already exists');
      mkdir(aNode);
      var aHasNext = stat(aNext);
      aCmd.push(
        (aHasNext ? 'cp -r '+aNext+' '+aData+';' : '')+'\
        echo starting node '+argv[aN+3]+' on port '+aPort+'; \
        node elembe.js -data '+aDataArg+' -port '+aPort+' -rec '+aRecording+'; \
        mkdir '+aTest+'; \
        mv '+aRecording+' '+aTest+'/'+sRecording+';\n'+
        (aHasNext ? 'mv '+aNext+' '+aTest+'/'+sData+';' : '')+' \
        mv '+aData+' '+aNext+'; ' );
    }
    for (var aN=0; aN < aCmd.length; ++aN)
      run(aCmd[aN], aN.toString(), fDone);
    function fDone(n) {
      if (n)
        run('rm -rf '+sData+n+' '+sRecording+n, function() { console.log('test aborted') });
      else
        console.log('test created');
    }
    break;

  case 'update':
    var aNode = readdir(sDir);
    if (!aNode || !aNode.length) return console.log('nothing found in '+sDir);
    if (stat(sData))             return console.log(sData+' already exists');
    fNode(0);
    function fNode(nodeN) {
      if (nodeN === aNode.length)
        return console.log('update complete');
      var aNodeDir = sDir+aNode[nodeN]+'/';
      var aTest = readdir(aNodeDir) || [];
      aTest.sort();
      process.nextTick(function() { fTest(0) });
      function fTest(testN) {
        if (testN === aTest.length)
          return fNode(++nodeN);
        var aData = aTest[testN] === sNextdata ? sNextdata : aTest[testN]+'/'+sData;
        if (!stat(aNodeDir+aData)) {
          process.nextTick(function() { fTest(++testN) });
          return;
        }
        var aCmd = '\
          cp -r '+aNodeDir+aData+' '+sData+'; \
          node elembe.js -data '+sDataArg+' -port '+sPort+' -updt; \
          rm -r '+aNodeDir+aData+'; \
          mv '+sData+' '+aNodeDir+aData+'; \
          echo updated '+aNode[nodeN]+' '+aTest[testN]+';';
        run(aCmd, 1, function(n) {
          if (n)
            run('rm -rf '+sData, function() { console.log('update failed') });
          else
            fTest(++testN);
        });
      }
    }
    break;

  case 'run':
    var aNode = sDir+argv[2]+'/';
    var aFirst = argv[3];
    var aLast = argv[4];
    var aDir = readdir(aNode);
    if (!aDir || !aDir.length) return console.log(aNode+' is missing or empty');
    if (!aFirst)               return console.log('missing test name');
    if (stat(sData))           return console.log(sData+' already exists');
    aDir.sort();
    var aStartData;
    var aTests = '';
    for (var a=1; a < aDir.length; ++a) {
      if (aDir[a] < aFirst)
        continue;
      if (!aStartData)
        aStartData = aNode+aDir[a]+'/'+sData;
      aTests += aNode+aDir[a]+'/'+sRecording+' ';
      if (!aLast || aDir[a] > aLast)
        break;
    }
    if (!aStartData) return console.log('test '+aFirst+' not found in '+aNode);
    var aCmd =
      (stat(aStartData) ? 'cp -r '+aStartData+' . ;' : '')+' \
      node elembe.js -data '+sDataArg+' -port '+sPort+' -play '+aTests+';';
    run(aCmd, function() {
      if (stat(sData))
        run('rm -rf '+sData, function(){});
    });
    break;

  default:
    console.log('unknown test command "'+argv[1]+'"');
  }
}

var nChild = require('child_process');
var nFs = require('fs');

function run(iCommand, iErrValue, iCallback) {
  if (arguments.length < 3) {
    iCallback = iErrValue;
    iErrValue = undefined;
  }
  var aLine = iCommand.split(/\s*;\s*/);
  fRun(0);
  function fRun(aN) {
    for (; aN < aLine.length; ++aN) {
      var aArg = aLine[aN].split(/\s+/);
      if (aArg[0] === '')
        aArg.shift();
      if (aArg.length)
        break;
    }
    if (aN === aLine.length)
      return process.nextTick(iCallback);
    if (aArg[aArg.length-1] === '')
      aArg.pop();
    var aCmd = aArg.shift();
    var aC = nChild.spawn(aCmd, aArg, {customFds:[0,1,2], env:process.env});
    aC.on('exit', function(code) {
      if (code) return iCallback(iErrValue);
      fRun(++aN);
    });
  }
}

function mkdir(iDir) {
  try {
    nFs.mkdirSync(iDir, 0700);
  } catch (err) {
    if (err.errno !== process.EEXIST) throw err;
  }
}

function readdir(iDir) {
  try {
    return nFs.readdirSync(iDir);
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
  }
  return null;
}

function stat(iName) {
  try {
    return nFs.statSync(iName);
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
  }
  return null;
}

main(process.argv);

