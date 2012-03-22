require.paths.unshift('/usr/lib/nodelib');

var sys = require('sys');
var fs = require('fs');
var http = require('http');
var url = require('url');
var child = require('child_process');

var sqlite = require('./sqliteplus');
var xd = require('./xdelta');
var io = require('socket.io');
var uuid = require('uuidjs');
var gm = require('gm');
var Inotify = require('inotify').Inotify;
var MqClient = require('mqclient');

http.IncomingMessage.prototype.pipe = 
fs.ReadStream.prototype.pipe = 
  function(to) { sys.pump(this, to, noOpCallback) };

var kSchemaV = {
  instance: '2012-03-07T00:07:44Z',
  services: '2012-03-07T00:07:44Z',
  projects: '2012-03-07T00:07:44Z',
  clients:  '2012-03-07T00:07:44Z',
  filename: null // Project db, defined below
};

var kSchema = {
  instance: {
    schemav: { v: 'text' },
    instance: {
      uuid: 'text',
      offset: 'integer',
      rowid: 'integer primary key autoincrement, check (uuid IS NULL OR rowid = 1)'
    }
  },
  services: {
    schemav: { v: 'text' },
    service: {
      host: 'text unique', // domain name
      nodeid: 'text',
      joined: 'text',
      aliases: 'text', // json [ string, ... ]
      comment: 'text',
      newreg: 'integer',
      addnode: 'text'
    }
  },
  projects: {
    schemav: { v: 'text' },
    project: {
      oid: 'text unique',
      service: 'text',
      data: 'text',  // json { name, blurb, created }
      dataw: 'text',
      localData: 'text' // json { lastViewed:datetime } 
    },
    invite: {
      date: 'text',   // iso/utc time
      from: 'text',   // uid
      toAlias: 'text',
      fromAlias: 'text',
      oid: 'text unique',
      service: 'text',
      data: 'text',  // json
      accept: 'text' // iso/utc time
    }
  },
  clients: {
    schemav: { v: 'text' },
    clientnav: {
      client: 'text unique',    // mac addr
      data: 'text'   // json { ... }
    }
  }
};

var kIncrOid = "INSERT INTO instance.instance (uuid) VALUES (NULL);\
                DELETE FROM instance.instance WHERE rowid = last_insert_rowid()";
var kNewOid = "SELECT uuid || '.' || (last_insert_rowid() * 100 + offset) AS oid FROM instance.instance";

function areEqual(iA, iB) {
  if (iA.constructor !== iB.constructor)
    return false;
  var aMemberCount = 0;
  for (var a in iA) {
    if (!iA.hasOwnProperty(a))
      continue;
    if (typeof iA[a] === 'object' && typeof iB[a] === 'object' ? !areEqual(iA[a], iB[a]) : iA[a] !== iB[a])
      return false;
    ++aMemberCount;
  }
  for (var a in iB)
    if (iB.hasOwnProperty(a))
      --aMemberCount;
  return aMemberCount ? false : true;
}

function noOpCallback(err, etc) {
  if (err)
    throw err;
}

// to add sql to transaction: createSchema(s, f).replace('\n\n', '\nSQL;\n')
function createSchema(iSchema, iFile) {
  var aSql = '';
  for (var aDb in iSchema)
    aSql += "ATTACH '"+(aDb === 'filename' ? iFile : sMainDir+aDb)+"' AS ["+aDb+"];\n";
  aSql += "BEGIN TRANSACTION;\n";
  for (var aDb in iSchema) {
    for (var aTb in iSchema[aDb]) {
      aSql += "CREATE TABLE IF NOT EXISTS ["+aDb+"].["+aTb+"] (";
      var aComma = '';
      for (var aCl in iSchema[aDb][aTb]) {
        aSql += aComma +(aCl && '['+aCl+'] ')+ iSchema[aDb][aTb][aCl];
        aComma = ' , ';
      }
      aSql += ");\n";
    }
    if (aTb) {
      aTb = null;
      aSql += "INSERT OR IGNORE INTO ["+aDb+"].schemav (rowid, v) VALUES (1, '"+kSchemaV[aDb]+"');\n";
    }
  }
  aSql += "\nCOMMIT TRANSACTION;\n";
  return aSql;
}

function makePath(iOid, _skipMkdir) {
  var aDir = sMainDir + iOid.slice(0, iOid.indexOf('.'));
  if (!_skipMkdir) {
    try {
    fs.mkdirSync(aDir, 0711);
    } catch (aErr) {
      if (aErr.errno !== process.EEXIST)
        throw aErr;
    }
  }
  return aDir + '/' + iOid;
}

function getPath(iOid) { return makePath(iOid, true); }

function getParent(iFile) {
  var aEnd = iFile.lastIndexOf('/');
  return aEnd >= 0 ? iFile.slice(0, aEnd) : '.';
}

function dupFile(iSrc, iDst, iCallback) {
  fs.stat(iSrc, function(err, stats) {
    if (err) return iCallback(err);
    fs.open(iSrc, 'r', function(err, infd) {
      if (err) return iCallback(err);
      fs.open(iDst, 'w', function(err, outfd) {
        if (err) { fs.close(infd); return iCallback(err); }
        fs.sendfile(outfd, infd, 0, stats.size, function(err, sent) {
          fs.close(infd, noOpCallback);
          if (err) { fs.close(outfd); return iCallback(err); }
          child.exec("touch -m -d '"+stats.mtime.toISOString().replace(/[TZ]/g, ' ')+" UTC' "+iDst, function(err) {//. replace with fs.utimes
            if (err) { fs.close(outfd); return iCallback(err); }
            fs.fsync(outfd, function(err) {
              fs.close(outfd);
              if (err) return iCallback(err);
              syncFile(getParent(iDst), iCallback);
            });
          });
        });
      });
    });
  });
}

function storeFile(iPath, iBuf, iCallback) {
  var aTemp = sMainDir+'storefile_'+storeFile.count++; //. use /tmp ?
  fs.open(aTemp, 'w', 0600, function(err, fd) {
    if (err) return iCallback(err);
    fWrite(iBuf);
    function fWrite(buf) {
      fs.write(fd, buf, 0, buf.length, null, function(err, written) {
        if (err) {
          fs.close(fd);
          return fErr(err);
        }
        if (written < buf.length)
          return fWrite(buf.slice(written));
        fs.fsync(fd, function(err) {
          fs.close(fd);
          if (err) return fErr(err);
          fs.rename(aTemp, iPath, function(err) {
            if (err) return fErr(err);
            syncFile(getParent(iPath), iCallback);
          });
        });
      });
    }
    function fErr(err) {
      fs.unlink(aTemp);
      iCallback(err);
    }
  });
}

storeFile.count = 0;

function syncFile(iPath, iCallback) {
  fs.open(iPath, 'r', function(err, fd) {
    if (err) return iCallback(err);
    fs.fsync(fd, function(err) {
      fs.close(fd);
      iCallback(err);
    });
  });
}

function RecordPlayback(iFile) {
  try {
    if (typeof iFile === 'string') {
      this.fd = fs.openSync(iFile, 'a', 0600);
    } else {
      this.fd = fs.openSync(iFile.shift(), 'r', 0600);
      this.file = iFile;
      this.buf = new Buffer(256*256);
    }
  } catch (err) {
    this.error = 'record/playback error: '+err.message;
  }
}

  RecordPlayback.prototype.save = function(iReq) {
    try {
    var aBufs = [];
    var aStr = JSON.stringify(iReq, function(key, value) {
      if (key === 'response')
        return;
      if (!Buffer.isBuffer(value))
        return value;
      aBufs.push(value);
      return {__buffer__:value.length};
    });
    aBufs.unshift(new Buffer((aStr.length.toString(16)+'   ').slice(0,4) + aStr));
    for (var a=0; a < aBufs.length; ++a)
      fs.writeSync(this.fd, aBufs[a], 0, aBufs[a].length, null);
    } catch (err) {
      console.log('recording error: '+err.message);
    }
  };

  RecordPlayback.prototype.next = function() {
    var that = this;
    for (var aGot; !(aGot = fs.readSync(that.fd, that.buf, 0, 4, null)); ) {
      fs.closeSync(that.fd);
      if (that.file.length === 0) {
        console.log('playback complete');
        process.exit(0);
      }
      try {
        that.fd = fs.openSync(that.file.shift(), 'r', 0600);
      } catch (err) {
        console.log('playback error: '+err.message);
        process.exit(1);
      }
    }
    var aLen = parseInt(that.buf.toString('ascii', 0, 4), 16);
    aGot = fs.readSync(that.fd, that.buf, 0, aLen, null);
    if (aGot !== aLen)
      console.log('playback error: request len '+aLen+' got '+aGot);
    var aReq = JSON.parse(that.buf.toString('ascii', 0, aLen), function(key, value) {
      if (typeof this[key] === 'object' && this[key] && '__buffer__' in this[key]) {
        var aBuf = new Buffer(this[key].__buffer__);
        aGot = fs.readSync(that.fd, aBuf, 0, this[key].__buffer__, null);
        if (aGot !== this[key].__buffer__)
          console.log('playback error: buffer misread');
        return aBuf;
      }
      return value;
    });
    console.log(aReq.type);
    aReq.client = null;
    return aReq;
  };

function Queue() {
  this.list = {};
  this.firstI = 0;
  this.nextI = 1;
}

  Queue.prototype.curr = function() {
    return this.firstI < this.nextI ? this.list[this.firstI] : null;
  };

  Queue.prototype.next = function() {
    delete this.list[this.firstI];
    if (++this.firstI === this.nextI)
      this.firstI = this.nextI = 0;
  };

  Queue.prototype.post = function(iReq) {
    var aRet = this.firstI === this.nextI;
    this.list[this.nextI++] = iReq;
    return aRet;
  };

  Queue._checkPause = null;

  Queue.pause = function(iCallback) {
    Queue._checkPause = function() {
      for (var a in Project.list)
        if (Project.list[a].queue.firstI !== Project.list[a].queue.nextI)
          return;
      if (sProjects.queue.firstI !== sProjects.queue.nextI)
        return;
      Queue._checkPause = true;
      iCallback();
    };
    process.nextTick(Queue._checkPause);
  };

  Queue.resume = function() {
    Queue._checkPause = null;
  };

  Queue.post = function(iReq) {
    if (Queue._checkPause)
      return;
    if (sRecord)
      sRecord.save(iReq);
    if (!iReq.project || !Project.list[iReq.project]) {
      if (sProjects.queue.post(iReq))
        Queue.process(null, true);
    } else {
      if (Project.list[iReq.project].queue.post(iReq))
        Queue.process(iReq.project, true);
    }
  };

  Queue.process = function(iProject, iUseCurr) {
    var aQ = iProject ? Project.list[iProject].queue : sProjects.queue;
    if (!iUseCurr)
      aQ.next();
    var aReq = aQ.curr();
    if (!aReq) {
      if (Queue._checkPause && Queue._checkPause !== true)
        Queue._checkPause();
      if (sPlayback)
        Queue.post(sPlayback.next());
      return;
    }
    if (aReq.type === 'deliver' && aReq.jso.type === 'acceptInvite' && aReq.from === sUUId)
      delete aReq.project;
    if (aReq.project && !Project.list[aReq.project]) {
      sProjects.lookup(aReq.project, function(data) {
        if (data === 'invite') {
          var aBuf = MqClient.packMsg({type:aReq.type, client:null, project:aReq.project, from:aReq.from, jso:aReq.jso}, aReq.data);
          storeFile(sInbound+aReq.project+'_'+Date.now(), aBuf, function(err) {
            if (err) throw err;
            sClients.respond(aReq, {}, 'noqueue');
          });
        } else if (data) {
          Project.list[aReq.project] = new Project(data, function() {
            if (data.installed)
              return fLastReq();
            fs.readdir(sInbound, function(err, array) {
              if (err) throw err;
              array.sort();
              fIter(0);
              function fIter(idx) {
                while (idx < array.length && array[idx].slice(0, array[idx].lastIndexOf('_')) !== aReq.project) ++idx;
                if (idx < array.length)
                  fs.readFile(sInbound+array[idx], function(err, buffer) {
                    if (err) throw err;
                    var aR = MqClient.unpackMsg(buffer);
                    aR.callback = function() { fs.unlink(sInbound+array[idx], noOpCallback) };
                    aR.data = aR._buf;
                    delete aR._buf;
                    Project.list[aReq.project].queue.post(aR);
                    fIter(idx+1);
                  });
                else
                  sProjects.setInstalled(aReq.project, fLastReq);
              }
            });
          });
          function fLastReq() {
            Project.list[aReq.project].queue.post(aReq);
            Queue.process(aReq.project, true);
          }
        } else
          sClients.respond(aReq, {error:'Request against invalid Project oid'}, 'noqueue');
        Queue.process();
      });
      return;
    }
    try {
    if (!aReq.hasOwnProperty('client'))
      throw 'client';
    if (aReq.type === 'deliver')
      aReq.type = aReq.project ? 'projectImport' : 'importt';
    var aHandler = 'handle_'+aReq.type;
    if (aHandler in sProjects) {
      for (a in sProjects[aReq.type])
        if (!aReq.hasOwnProperty(a))
          throw a;
      sProjects[aHandler](aReq);
    } else {
      if (!aReq.hasOwnProperty('project'))
        throw 'project';
      if (aHandler in Project.list[aReq.project]) {
        for (a in Project.list[aReq.project][aReq.type])
          if (a === 'autogen' ? /^#autogen/.test(aReq.project) : !aReq.hasOwnProperty(a))
            throw a;
        Project.list[aReq.project][aHandler](aReq);
      } else {
        throw 'unknown Project request '+aReq.type;
      }
    }
    } catch (aErr) {
      if (typeof aErr === 'object')
        throw aErr;
      sClients.respond(aReq, {error: aReq.type + (aErr === 'autogen' ? ' illegal for autogen project' : ' request missing parameter '+aErr)});
    }
  };

var sWelcome;
var sMainDir = 'data/';
var sRevisionCache = '#revisioncache/';
var sEditCache = '#editcache/';
var sSendDir = '#outbound/';
var sInbound = '#inbound/';
var sHttpPort = 8000;
var sUUId;
var sNodeOffset;
var sRecord = null;
var sPlayback = null;
var sUpdate = false;

function main(argv) {
  for (var a=2; a < argv.length; ++a) {
    var aOp = argv[a];
    switch (argv[a]) {
    case '-rec':  ++a; if (!fExcluded()) sRecord   =  argv[a];            break;
    case '-play': ++a; if (!fExcluded()) sPlayback = [argv[a]];           break;
    case '-updt':      if (!fExcluded()) sUpdate   = true;                break;
    case '-data': ++a; sMainDir = sMainDir.replace('/', '-'+argv[a]+'/'); break;
    case '-port': ++a; sHttpPort = +argv[a];                              break;
    default:
      if (aLastOp === '-play') {
        sPlayback.push(argv[a]);
        continue;
      } else {
        console.log('unknown command option '+argv[a]);
        process.exit(1);
      }
    }
    var aLastOp = aOp;
  }
  function fExcluded() { return sRecord || sPlayback || sUpdate ? true : false }

  sRevisionCache = sMainDir+sRevisionCache;
  sEditCache     = sMainDir+sEditCache;
  sSendDir       = sMainDir+sSendDir;
  sInbound       = sMainDir+sInbound;

  if (sUpdate) {
    updateSchema(function() {
      process.exit(0);
    });
    return;
  }
  if (sRecord || sPlayback) {
    var aRp = new RecordPlayback(sRecord || sPlayback);
    if (aRp.error) {
      console.log(aRp.error);
      process.exit(1);
    }
    if (sRecord) sRecord = aRp;
    if (sPlayback) sPlayback = aRp;
  }
  startDatabase(function() {
    Queue.process();
    if (sPlayback)
      return;
    aServer = http.createServer(httpRequest);
    aServer.listen(sHttpPort);
    var aSocket = io.listen(aServer);
    aSocket.on('connection', function(conn) {
      var aClientId = conn.request.headers.cookie.slice(conn.request.headers.cookie.indexOf('=')+1);
      sClients.client(aClientId, conn);
      var aOn = true;
      conn.on('message', function(msg) {
        if (!aOn) {
          console.log('message received on closed connection');
          return;
        }
        var aReq = JSON.parse(msg);
        aReq.client = aClientId;
        if (sWelcome && aReq.type !== 'autogen' && aReq.type !== 'syncFrom') {
          sClients.respond(aReq, {screen:'welcome', state:sWelcome, host:(sProjects.syncFromData && sProjects.syncFromData.host)}, true);
        } else if (sProjects.syncToSession) {
          if (aReq.type === 'interrupt') {
            delete sProjects.syncToSession;
            Queue.resume();
            sClients.notify(null, {type:'restart'});
          }
          sClients.respond(aReq, aReq.type === 'interrupt' ? {} : {screen:'interrupt'}, true);
        } else {
          Queue.post(aReq);
        }
      });
      conn.on('disconnect', function() {
        aOn = false;
        sClients.client(aClientId, null);
      });
    });
  });
}

function startDatabase(iCallback) {
  try {
  var aMain = fs.statSync(sMainDir);
  var aBuf = fs.readFileSync(sMainDir+'sync_filelist', 'ascii');
  if (aBuf.length)
    sProjects.syncFromData = JSON.parse(aBuf);
  sWelcome = aBuf.length ? 'syncPause' : 'new';
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
    sWelcome = aMain ? null : 'new';
  }
  if (sWelcome) {
    if (aBuf !== undefined && !aBuf.length)
      clearDirectories();
    process.nextTick(iCallback);
    return;
  }
  var aDb = new sqlite.Database();
  aDb.open(sMainDir+'instance', function (err) {
    if (err) throw err;
    aDb.exec("SELECT uuid, offset FROM instance", function(err, row) {
      if (err) throw err;
      if (row) {
        sUUId = row.uuid;
        sNodeOffset = row.offset;
      }
    }, function() {
      aDb.close();
      sAttachments.init();
      sServices.start(function() {
        sProjects.init(iCallback);
      });
    });
  });
}

function beginDirectories() {
  var aList = [ 0711, sMainDir, sSendDir, sInbound, 0777, sEditCache, sRevisionCache ];
  var aMask = process.umask(0000);
  for (var a=0; a < aList.length; ++a) {
    if (typeof aList[a] === 'number') {
      var aMode = aList[a];
      continue;
    }
    aList[a] = aList[a].replace(sMainDir.slice(0,-1), '$&_tmp');
    try {
    fs.mkdirSync(aList[a], aMode);
    } catch (err) {
      if (err.errno !== process.EEXIST) throw err;
    }
  }
  process.umask(aMask);
  try {
  fs.unlinkSync(sMainDir+'sync_filelist');
  } catch (err) {
    if (err.errno !== process.ENOENT) throw err;
  }
  sMainDir = aList[1];
}

function commitDirectories() {
  var aMain = sMainDir.replace('_tmp', '');
  fs.renameSync(sMainDir, aMain);
  sMainDir = aMain;
}

function clearDirectories(iLater) {
  fs.closeSync(fs.openSync(sMainDir+'sync_filelist', 'w'));
  if (iLater)
    return;
  fReadDir('');
  function fReadDir(path) {
    var aList = fs.readdirSync(sMainDir+path);
    for (var a=0; a < aList.length; ++a) {
      if (!path && aList[a] === 'sync_filelist')
        continue;
      var aStats = fs.statSync(sMainDir+path+aList[a]);
      if (aStats.isFile())
        fs.unlinkSync(sMainDir+path+aList[a]);
      else if (aStats.isDirectory())
        fReadDir(path+aList[a]+'/');
    }
    if (path)
      fs.rmdirSync(sMainDir+path);
    else
      fs.renameSync(sMainDir, sMainDir.replace('/', '_tmp/'));
  }
}

function updateSchema(iCallback) {
  fs.statSync(sMainDir+'instance');
  var aDb = new sqlite.Database();
  aDb.open(sMainDir+'instance', function(err) {
    if (err) throw err;
    var aSql = createSchema(kSchema);
    aDb.exec(aSql, noOpCallback, function() {
      aDb.prepare("SELECT oid FROM projects.project", function(err, stmt) {
        if (err) throw err;
        stmt.results(function(err, list) {
          if (err) throw err;
          var aSchema = {filename:Project.prototype.kSchema.filename};
          fProject(0);
          function fProject(projN) {
            if (projN < list.length) {
              aSql = createSchema(aSchema, getPath(list[projN].oid));
              aSql += "DETACH filename;\n";
              aDb.exec(aSql, noOpCallback, function() {
                fProject(++projN);
              });
              return;
            }
            aDb.close();
            iCallback();
          }
        });
      });
    });
  });
}

var kFileMap = {
  '/':'client/_suae_.html',
  '/socket-io.js':'socket.io/socket.io.js',
  '/applaunch':'client/applaunch.xpi',
  '/test':'dbtest.html',
  '/part':'part',
  '/sync':'sync',
  '/exit':'exit'
};
var kTypeMap = { js:'text/javascript', css:'text/css', html:'text/html', xpi:'application/x-xpinstall' };

function httpRequest(req, res) {
  var aUrl = url.parse(req.url, true), aFile = kFileMap[aUrl.pathname];
  if (aFile === 'exit') {
    if (aUrl.search === '?ok')
      Queue.pause(function() { process.exit(0) });
    else
      process.exit(1);
  } else if (aFile === 'sync') {
    sProjects.syncTo(aUrl.query || {}, function(status, data, size) {
      if (status !== 200 || !data) {
        res.writeHead(status);
        res.end();
      } else if (size) {
        res.writeHead(status, { 'Content-Length':size });
        fs.createReadStream(data).pipe(res);
      } else {
        var aStr = JSON.stringify(data);
        res.writeHead(status, { 'Content-Length':aStr.length });
        res.end(aStr);
      }
    });
  } else if (aFile === 'part') {
    if (req.method.toLowerCase() === 'post') {
      req.setEncoding('binary');
      var aBuf = new Buffer(+req.headers['content-length']);
      var aLastData = null, aLen;
      req.on('data', function(data) {
        if (aLastData === null)
          aLen = aBuf.write(data.slice(data.indexOf('\r\n\r\n')+4), 0, 'binary');
        else
          aLen += aBuf.write(data, aLen, 'binary');
        if (aLastData && data.length < 200)
          aLastData += data
        else
          aLastData = data;
      });
      req.on('end', function() {
        aBuf = aBuf.slice(0, aLen-(aLastData.length-aLastData.lastIndexOf('\r\n--')));
        Queue.post({type:'writePart', client:null, project:aUrl.query.project, page:aUrl.query.page, part:aUrl.query.oid, data:aBuf, response:res});
      });
    } else {
      aFile = aUrl.query.oid.indexOf('_') < 0 ? getPath(aUrl.query.oid) : sRevisionCache+aUrl.query.oid;
      fs.stat(aFile+'.w', function(errW, stats) {
        fs.stat(aFile, function(err, stats) {
          if (!errW)
            aFile += '.w';
          else if (err)
            aFile = 'image-default.png';
          gm(aFile).format(function(err, type) {
            if (err || (type !== 'PNG' && type !== 'GIF' && type !== 'JPEG')) {
              aFile = 'image-invalid.png';
              type = 'PNG';
            }
            res.writeHead(200, {'Content-Type':'image/'+type, 'Cache-Control':'no-store, no-cache'});
            fs.createReadStream(aFile).pipe(res);
          });
        });
      });
    }
  } else {
    if (!aFile)
      aFile = 'client'+aUrl.pathname;
    fs.readFile(aFile, function(err, data) {
      if (err) {
        if (err.errno !== process.ENOENT) throw err;
        res.writeHead(404, {'Content-Type':'text/plain'});
        res.end('Invalid Resource');
        return;
      }
      var aHeaders = { 'Content-Type': kTypeMap[aFile.slice(aFile.lastIndexOf('.')+1)] };
      if (!req.headers.cookie || req.headers.cookie.indexOf('anvlclient=') < 0)
        aHeaders['Set-Cookie'] = 'anvlclient='+uuid.generate()+'; expires=31-Oct-3333 01:01:01 GMT; path=/';
      res.writeHead(200, aHeaders);
      res.end(data);
    });
  }
}

var sServices = {
  db: null,
  s: {}
};

  sServices.start = function(iCallback) {
    var that = this;
    that.db = new sqlite.Database();
    that.db.open(sMainDir+'services', function(openErr) {
      if (openErr) throw openErr;
      that.db.exec("SELECT * FROM service", function(err, row) {
        if (err) throw err;
        if (row)
          that._create(row, function(svc) {
            that._connect(svc.host);
            sClients.notify(null, {type:'services', list:that.list(svc.host)}, '#services');
          });
      }, iCallback);
    });
  };

  sServices.end = function() {
    //. queue disconnect if conn in use
    for (var a in this.s) {
      if (this.s[a].status !== 'offline') {
        this.s[a].status = 'signing off';
        sClients.notify(null, {type:'services', list:this.list(a)}, '#services');
        this.s[a].conn.close();
      }
    }
  };

  sServices._create = function(iRow, iCallback) {
    if (!('queue' in iRow)) {
      fs.readdir(sSendDir+iRow.host, function(err, array) {
        if (err && err.errno !== process.ENOENT) throw err;
        if (err)
          fs.mkdirSync(sSendDir+iRow.host, 0700);
        iRow.queue = array || [];
        iRow.queue.sort();
        sServices._create(iRow, iCallback);
      });
      return;
    }
    this.s[iRow.host] = iRow;
    iRow.timer = null;
    iRow.msgHead = null;
    iRow.status = 'offline';
    iRow.conn = new MqClient();
    iRow.conn.on('registered', function(aliases, id, err) {
      if (err && err !== 'user exists')
        throw new Error(err);
      if (aliases !== undefined)
        iRow.aliases = aliases;
      var aJoined = '';
      if (iRow.joined === 'no') {
        iRow.joined = (new Date).toISOString();
        aJoined = ",joined='"+iRow.joined+"'";
      }
      if (iRow.status === 'trying') {
        if (iRow.addnode) {
          var aId = sServices._nodeIds(iRow.host);
          iRow.conn.addNode(sUUId, aId.add, aId.reg);
        } else {
          iRow.conn.login(sUUId, iRow.nodeid);
        }
      }
      iRow.newreg = 0;
      sServices.db.exec("UPDATE service SET newreg=0, aliases='"+iRow.aliases+"'"+aJoined+" WHERE host='"+iRow.host+"'", noOpCallback, function() {
        sClients.notify(null, {type:'services', list:sServices.list(iRow.host)}, '#services');
        if (id)
          iRow.conn.ack(id, 'ok');
      });
    });
    iRow.conn.on('added', function(offset, err) {
      if (err && err !== 'new nodename exists')
        throw new Error(err);
      if (iRow.status === 'trying')
        iRow.conn.login(sUUId, iRow.nodeid);
      if (typeof iRow.addnodeCallback === 'function')
        iRow.addnodeCallback(offset);
      else if (iRow.addnodeCallback === 'saving')
        iRow.addnodeCallback = fClear;
      else
        fClear(iRow.addnode.charAt(0) === '!');
      iRow.addnode = null;
      function fClear(isNew) {
        var a1 = "ATTACH 'instance' AS instance; \
                  BEGIN TRANSACTION; \
                  UPDATE instance.instance SET offset = "+offset+";";
        var a2 = "UPDATE service SET addnode = NULL WHERE host = '"+iRow.host+"';";
        var a3 = "COMMIT TRANSACTION; \
                  DETACH instance;";
        sServices.db.exec((isNew ? a1 : '') + a2 + (isNew ? a3 : ''), noOpCallback, noOpCallback);
      }
    });
    iRow.conn.on('info', function(msg) {
      if (msg === 'ok login') {
        iRow.status = 'online';
        sClients.notify(null, {type:'services', list:sServices.list(iRow.host)}, '#services');
        if (iRow.newreg)
          iRow.conn.register(sUUId, '', iRow.aliases);
        sServices._sendNext(iRow.host);
      }
    });
    iRow.conn.on('quit', function(msg) {
      if (iRow.timer)
        clearTimeout(iRow.timer);
      iRow.status = 'quit: '+msg;
      sClients.notify(null, {type:'services', list:sServices.list(iRow.host)}, '#services');
      console.log('service quit: '+iRow.host+' '+msg);
    });
    iRow.conn.on('deliver', function(id, from, msg, etc) {
      var aData = typeof msg === 'undefined' ? null : msg;
      var aReq = {type:'deliver', client:null, project:etc.project, from:from, jso:etc, data:aData, callback:function() { iRow.conn.ack(id, 'ok') } };
      Queue.post(aReq);
    });
    iRow.conn.on('ack', function(id, type, error) {
      if (!iRow.queue.length || id !== iRow.queue[0])
        return;
      if (iRow.timer)
        clearTimeout(iRow.timer);
      if (type === 'error')
        console.log('ack failure: '+error);
      fOk.count = 1;
      if (iRow.msgHead.etc && iRow.msgHead.etc.type === 'invite') {
        if (type !== 'ok') {
          ++fOk.count;
          Queue.post({type:'postMsg', client:null, project:iRow.msgHead.etc.oid, msg:'Invited user '+iRow.msgHead.alias+' is unknown', callback:fOk});
        }
        Queue.post({type:'projectImport', client:null, project:iRow.msgHead.etc.oid, from:sUUId, data:null, callback:fOk,
          jso:{type:'memberAlias', alias:iRow.msgHead.alias, invite:type === 'ok' ? 'accept' : 'invalid'}});
      } else {
        fOk();
      }
      function fOk() {
        if (--fOk.count > 0)
          return;
        iRow.msgHead = null;
        iRow.queue.shift();
        sServices._sendNext(iRow.host);
        fs.unlink(sSendDir+iRow.host+'/'+id, noOpCallback);
      }
    });
    iRow.conn.on('close', function() {
      iRow.status = iRow.status === 'signing off' ? 'offline' : 'trying';
      if (iRow.timer) {
        clearTimeout(iRow.timer);
        iRow.timer = null;
      }
      sClients.notify(null, {type:'services', list:sServices.list(iRow.host)}, '#services');
    });
    iRow.conn.on('error', function(err) {
      console.log('invalid message from service '+iRow.host+': '+err.message);
    });
    iCallback(iRow);
  };

  sServices._connect = function(iHost) {
    var aS = this.s[iHost];
    aS.status = 'trying';
    //var aAddr = iHost.split(':');
    aS.conn.connect(iHost, null, function() {
      var aId = sServices._nodeIds(iHost);
      if (aS.joined === 'no')
        aS.conn.register(sUUId, aId.reg, aS.aliases);
      else if (aS.addnode)
        aS.conn.addNode(sUUId, aId.add, aId.reg);
      else
        aS.conn.login(sUUId, aS.nodeid);
    });
  };

  sServices._nodeIds = function(iHost) {
    var aS = this.s[iHost];
    var aIsOrig = !aS.addnode || aS.addnode.charAt(0) !== '!';
    return { reg: aIsOrig ? aS.nodeid : aS.addnode.slice(1), add: aIsOrig ? aS.addnode : aS.nodeid };
  };

  sServices._sendNext = function(iHost) {
    if (!this.s[iHost].queue.length)
      return;
    var aId = this.s[iHost].queue[0];
    fs.readFile(sSendDir+iHost+'/'+aId, function(err, data) {
      if (err) throw err;
      if (sPlayback) {
        sServices.s[iHost].msgHead = {};
        setTimeout(sServices.s[iHost].conn.event_ack, 20, aId, 'ok');
        return;
      }
      sServices.s[iHost].msgHead = MqClient.unpackMsg(data);
      delete sServices.s[iHost].msgHead._buf;
      sServices.s[iHost].conn.send(data);
      sServices.s[iHost].timer = setTimeout(sServices._timeout, 20*1000, iHost);
    });
  };

  sServices._timeout = function(iHost) {
    sServices.s[iHost].timer = null;
    sServices._sendNext(iHost);
  };

  sServices.touch = function(iHost, iAliases, iComment, iReq, _tx) {
    var that = this;
    if (!that.stmtSave) {
      that.db.prepare("UPDATE service SET newreg=?, aliases=?, comment=? WHERE host = ?", function(err, stmt) {
        if (err) throw err;
        that.stmtSave = stmt;
        that.touch(iHost, iAliases, iComment, iReq);
      });
      return;
    }
    if (!(iHost in this.s)) {
      var aNodeId = uuid.generate();
      that.db.exec("BEGIN TRANSACTION;\
                    INSERT INTO service VALUES ('"+iHost+"', '"+aNodeId+"', 'no', NULL, NULL, 2, NULL);", noOpCallback, function() {
        that._create({ host:iHost, nodeid:aNodeId, joined:'no', aliases:null, comment:null, newreg:2, addnode:null }, function(svc) {
          that.touch(iHost, iAliases, iComment, iReq, true);
        });
      });
      return;
    }
    that.stmtSave.bind(1, this.s[iHost].newreg || (this.s[iHost].newreg = 1));
    that.stmtSave.bind(2, this.s[iHost].aliases = iAliases);
    that.stmtSave.bind(3, this.s[iHost].comment = iComment);
    that.stmtSave.bind(4, this.s[iHost].host);
    that.stmtSave.stepOnce(function(err, row) {
      if (err) throw err;
      if (_tx)
        that.db.exec("COMMIT TRANSACTION", noOpCallback, fDone);
      else
        fDone();
      function fDone() {
        if (that.s[iHost].status === 'offline')
          that._connect(iHost);
        else if (that.s[iHost].status === 'online')
          that.s[iHost].conn.register(sUUId, '', that.s[iHost].aliases);
        sClients.notify(iReq, {type:'services', list:that.list(iHost)}, '#services');
      }
    });
  };

  sServices.addNode = function(iHost, iNodeId, iCallback) {
    var that = this;
    that.s[iHost].addnode = iNodeId;
    that.s[iHost].conn.addNode(sUUId, iNodeId, that.s[iHost].nodeid);
    var aTimer = setTimeout(function() {
      that.s[iHost].addnodeCallback = 'saving';
      that.db.exec("UPDATE service SET addnode = '"+iNodeId+"' WHERE host = '"+iHost+"'", noOpCallback, function() {
        if (typeof that.s[iHost].addnodeCallback === 'function')
          that.s[iHost].addnodeCallback();
        that.s[iHost].addnodeCallback = null;
        iCallback(false);
      });
    }, 2*1000);
    that.s[iHost].addnodeCallback = function(offset) {
      clearTimeout(aTimer);
      that.s[iHost].addnodeCallback = null;
      iCallback(true, offset);
    };
  };

  sServices.list = function(iHost) {
    var aSvc = {};
    for (var a in this.s) {
      if (iHost && iHost !== a)
        continue;
      var aS = this.s[a];
      aSvc[a] = { host:aS.host, joined:aS.joined, aliases:aS.aliases, comment:aS.comment, status:aS.status };
    }
    return aSvc;
  };

  sServices.hasAlias = function(iHost, iStr) {
    var aAls = this.s[iHost].aliases;
    if (!aAls)
      return false;
    var aI = aAls.indexOf(iStr);
    if (aI < 0 || aI > 0 && aAls.charAt(aI-1) !== ' ' || aI+iStr.length < aAls.length && aAls.charAt(aI+iStr.length) !== ' ')
      return false;
    return true;
  };

  sServices.listEdit = function(iHost, iList, iOp, iMember, iEtc, iMsg, iCallback) {
    var aHead = { op:'listEdit', to:iList, type:iOp, member:iMember, etc:iEtc };
    this._queue(iHost, aHead, iMsg, iCallback);
  };

  sServices.listPost = function(iHost, iList, iEtc, iMsg, iCallback, _all) {
    var aHead = { op:'post', to:{}, etc:iEtc };
    aHead.to[iList] = _all || 2;
    this._queue(iHost, aHead, iMsg, iCallback);
  };

  sServices.listPostAll = function(iHost, iList, iEtc, iMsg, iCallback) {
    this.listPost(iHost, iList, iEtc, iMsg, iCallback, 3);
  };

  sServices.post = function(iHost, iTo, iEtc, iMsg, iCallback) {
    var aHead = typeof iTo === 'string' ? {op:'ping', alias:iTo, etc:iEtc} : {op:'post', to:iTo, etc:iEtc};
    this._queue(iHost, aHead, iMsg, iCallback);
  };

  sServices._queue = function(iHost, iHead, iMsg, iCallback) {
    iHead.id = Date.now().toString(); //. may need to append counter
    var aFile = sSendDir+iHost+'/'+iHead.id;
    fs.writeFile(aFile, MqClient.packMsg(iHead, iMsg), function(err) {
      if (err) throw err;
      sServices.s[iHost].queue.push(iHead.id);
      if (sServices.s[iHost].queue.length === 1)
        sServices._sendNext(iHost);
      syncFile(aFile, function(err) {
        if (err) throw err;
        syncFile(sSendDir+iHost, function(err) {
          if (err) throw err;
          iCallback();
        });
      });
    });
  };


var sAttachments = {
  file: {},
  notify: null
};

  sAttachments._addFile = function(iProject, iPage, iOid) {
    if (!this.file[iOid]) {
      this.file[iOid] = { readOnly:true, n:-1, id:null, onWrite: function(event) {
        if (event.mask & Inotify.IN_IGNORED)
          return;
        Queue.post({type:'writePart', client:null, project:iProject, page:iPage, part:iOid, data:null});
      }};
    }
    return this.file[iOid];
  };

  sAttachments.init = function() {
    var that = this;
    that.notify = new Inotify();
    that.notify.addWatch({path:sEditCache, watch_for:Inotify.IN_CREATE|Inotify.IN_MOVED_TO, callback: function(event) {
      if (event.mask & Inotify.IN_IGNORED)
        return;
      var aOid, aSeg = event.name.split('_');
      if (aSeg.length !== 5 || !that.file[aOid=aSeg[2]])
        return;
      var aId = that.file[aOid].id;
      that.file[aOid].id = that.notify.addWatch({path:sEditCache+event.name, watch_for:Inotify.IN_MODIFY, callback:that.file[aOid].onWrite});
      if (that.file[aOid].id === -1)
        throw new Error('addwatch for new file failed');
      if (aId !== null) {
        that.notify.removeWatch(aId);
        var aPath = getPath(aOid);
        fs.unlink(aPath+'.w', function(err) {
          if (err) throw err;
          fs.link(sEditCache+event.name, aPath+'.w', noOpCallback);
        });
        that.file[aOid].onWrite({mask:Inotify.IN_MODIFY});
      }
    }});
    fs.readdir(sEditCache, function(err, dir) {
      if (err) throw err;
      fCheck(0);
      function fCheck(fileN) {
        for (var aSeg; fileN < dir.length && (aSeg = dir[fileN].split('_')).length !== 5; ++fileN) {}
        if (fileN >= dir.length)
          return;
        var aFile = that._addFile(aSeg[0], aSeg[1], aSeg[2]);
        if (+aSeg[3] > aFile.n)
          aFile.n = +aSeg[3];
        fs.stat(sEditCache+dir[fileN], function(err, stats) {
          if (err) throw err;
          if (stats.mode % 01000 !== 0444) {
            aFile.readOnly = false;
            aFile.id = that.notify.addWatch({path:sEditCache+dir[fileN], watch_for:Inotify.IN_MODIFY, callback:aFile.onWrite});
            if (aFile.id === -1)
              throw new Error('addwatch for existing file failed');
          }
          fCheck(++fileN);
        });
      }
    });
  };

  sAttachments.ready = function(iProject, iPage, iOid, iDocType, iCallback) {
    if (iOid.indexOf('_') >= 0) {
      var aDocPath = sRevisionCache + iOid+'_'+iDocType;
      fs.symlink(iOid, aDocPath, function(err) { //. use .link()
        if (err && err.errno !== process.EEXIST) throw err;
        fs.chmod(sRevisionCache + iOid, 0444, function(err) {
          if (err) throw err;
          iCallback(aDocPath.replace(/\//g, '\\'));
        });
      });
      return;
    }
    var that = this;
    var aPath = getPath(iOid);
    fs.stat(aPath+'.w', function(err, stats) {
      if (err)
        dupFile(aPath, aPath+'.w', function(err) {
          if (err) throw err;
          fLink();
        });
      else
        fLink();
    });
    function fLink() {
      var aFile = that._addFile(iProject, iPage, iOid);
      if (aFile.readOnly) {
        aFile.readOnly = false;
        ++aFile.n;
      }
      var aDocPath = sEditCache + iProject+'_'+iPage+'_'+iOid+'_'+aFile.n+'_'+iDocType;
      fs.link(aPath+'.w', aDocPath, function(err) {
        if (err && err.errno !== process.EEXIST) throw err;
        iCallback(aDocPath.replace(/\//g, '\\'));
      });
    }
  };

  sAttachments.invalidate = function(iOid, iCallback) {
    var that = this;
    var aPath = getPath(iOid)+'.w';
    fs.chmod(aPath, 0444, function(err) {
      if (err) throw err;
      that.file[iOid].readOnly = true;
      that.notify.removeWatch(that.file[iOid].id);
      that.file[iOid].id = null;
      syncFile(aPath, function(err) {
        if (err) throw err;
        iCallback();
      });
    });
  };

  sAttachments.isOpen = function(iOid) {
    return this.file[iOid] ? !this.file[iOid].readOnly : false;
  };


var sProjects = {
  db: null,
  queue: new Queue,
  stmt: {}
};

  sProjects.init = function(iStart) {
    var that = this;
    that.db = new sqlite.Database();
    that.db.open(sMainDir+'projects', function(openErr) {
      if (openErr) throw openErr;
      var aList = [];
      that.db.exec("ATTACH '"+sMainDir+"instance' AS instance; \
                    ATTACH '"+sMainDir+"clients' AS clients; \
                    BEGIN TRANSACTION; \
                    SELECT oid, dataw AS data, service FROM project WHERE data = 'pending'; \
                    UPDATE project SET data = NULL WHERE data = 'pending';", function(err, row) {
        if (err) throw err;
        if (row) aList.push(row);
      }, fCommit);
      function fCommit() {
        var aRow = aList.pop();
        if (aRow) {
          aRow.type = 'newProject';
          sServices.post('localhost', {}, aRow, null, fCommit); //. use default service id
          return;
        }
        that.db.exec("COMMIT TRANSACTION", noOpCallback, iStart);
      }
    });
  };

  sProjects.finalize = function() {
    sqlite.Database.finalizeN(this.stmt);
    this.db.close();
  };

  sProjects.kClientNavInit = {sort:'name', history: {n:1, len:1, i: [{proj:'#autogen.01000', page:'#autogen.01010'}]}};

  sProjects.getClientNav = {};
  sProjects.handle_getClientNav = function(iReq) {
    var that = this;
    if (!that.stmt.getClientNav) {
      that.db.prepare("SELECT data FROM clients.clientnav WHERE client = ?", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.getClientNav = stmt;
        that.handle_getClientNav(iReq);
      });
      return;
    }
    that.stmt.getClientNav.bind(1, iReq.client);
    that.stmt.getClientNav.stepOnce(function(stepErr, row) {
      if (stepErr) throw stepErr;
      if (row)
        row.data = JSON.parse(row.data);
      sClients.respond(iReq, row || {data:that.kClientNavInit});
    });
  };

  sProjects.setClientNav = { data:true };
  sProjects.handle_setClientNav = function(iReq) {
    var that = this;
    if (!that.stmt.setClientNav) {
      that.db.prepare("INSERT OR REPLACE INTO clients.clientnav VALUES ( ?, ? )", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.setClientNav = stmt;
        that.handle_setClientNav(iReq);
      });
      return;
    }
    that.stmt.setClientNav.bind(1, iReq.client);
    that.stmt.setClientNav.bind(2, JSON.stringify(iReq.data));
    that.stmt.setClientNav.stepOnce(function(err, row) {
      if (err) throw err;
      sClients.respond(iReq, {status:'ok'});
    });
  };

  sProjects.autogen = { };
  sProjects.handle_autogen = function(iReq) {
    if (sWelcome !== 'new') {
      sClients.respond(iReq, {error:'cannot autogen from welcome state '+sWelcome});
      return;
    }
    sWelcome = 'autogen';
    beginDirectories();
    var aDb = new sqlite.Database();
    aDb.open(sMainDir+'instance', function (err) {
      if (err) throw err;
      var aSql = createSchema(kSchema) +
                "INSERT OR IGNORE INTO instance (uuid, offset) VALUES ('"+uuid.generate()+"', 0);";
      aDb.exec(aSql, noOpCallback, function() {
        aDb.close();
        fProject(0);
      });
    });
    var aJso = require('./autogen.js');
    function fProject(idx) {
      if (idx < aJso.length) {
        var aPath = makePath(aJso[idx].project);
        aDb.open(aPath, function(err) {
          if (err) throw err;
          var aStart = 0;
          var aSql = createSchema(Project.prototype.kSchema, aPath) +
                    "BEGIN TRANSACTION; \
                     INSERT OR IGNORE INTO projects.project (oid, data, localData) VALUES ( '"+aJso[idx].project+"', '"+JSON.stringify(aJso[idx].data)+"', '{}' ); ";
          aDb.exec(aSql, function(err, row) {
            if (err && err.message !== 'constraint failed') throw err;
            if (err) aStart = aJso[idx].list.length;
          }, function() {
            fDataLoop(aJso[idx].list, aStart);
          });
        });
      } else {
        commitDirectories();
        startDatabase(function() {
          sClients.notify(iReq, {type:'autogen'});
        });
      }
      function fDataLoop(dataArray, dataN) {
        if (dataN < dataArray.length) {
          switch(dataArray[dataN].type) {
          case 'page':
            aDb.exec("INSERT OR IGNORE INTO page (oid, data, layout) VALUES \
              ('"+dataArray[dataN].oid+"', '"+JSON.stringify(dataArray[dataN].data)+"', '"+JSON.stringify(dataArray[dataN].layout)+"')"
              , noOpCallback, function() {
              fDataLoop(dataArray, ++dataN);
            });
            return;
          case 'part':
            fs.writeFile(makePath(dataArray[dataN].oid), dataArray[dataN].data, 'utf8', function(err) {
              if (err) throw err;
              fDataLoop(dataArray, ++dataN);
            });
            return;
          default:
            throw new Error('unknown autogen type: '+dataArray[dataN].type);
          }
        } else {
          aDb.exec("COMMIT TRANSACTION", noOpCallback, function() {
            aDb.close();
            fProject(++idx);
          });
        }
      }
    }
  };

  sProjects.importt = { from:true, jso:true, data:true };
  sProjects.handle_importt = function(iReq) {
    // this function must defend against attack
    // anyone on the service can send a message here with the user's alias
    var that = this;
    if (!that.stmt.svcMsg) {
      that.stmt.svcMsg = {
        invite_select: "SELECT accept FROM invite WHERE oid = ?",
        invite_insert: "INSERT OR REPLACE INTO invite VALUES ( ?, ?, ?, ?, ?, ?, ?, NULL )",
        invite_update: "UPDATE invite SET accept = ? WHERE oid = ?",
        project_selectInvite:  "SELECT accept FROM invite  WHERE oid = ?",
        project_selectProject: "SELECT oid    FROM project WHERE oid = ?",
        project_insert: "INSERT INTO project VALUES ( ?, ?, ?, ?, NULL )"
      };
      that.db.prepareN(that.stmt.svcMsg, function(err) {
        if (err) throw err;
        that.handle_importt(iReq);
      });
      return;
    }
    switch(iReq.jso.type) {
    case 'invite':
      that.stmt.svcMsg.invite_select.bind(1, iReq.jso.oid);
      that.stmt.svcMsg.invite_select.stepOnce(function(err, row) {
        if (err) throw err;
        if (row && row.accept) {
          sClients.respond(iReq, {});
          return;
        }
        that.stmt.svcMsg.invite_insert.bind(1, iReq.jso.date);
        that.stmt.svcMsg.invite_insert.bind(2, iReq.from);
        that.stmt.svcMsg.invite_insert.bind(3, iReq.jso.toAlias);
        that.stmt.svcMsg.invite_insert.bind(4, iReq.jso.fromAlias);
        that.stmt.svcMsg.invite_insert.bind(5, iReq.jso.oid);
        that.stmt.svcMsg.invite_insert.bind(6, iReq.jso.service);
        that.stmt.svcMsg.invite_insert.bind(7, iReq.jso.data);
        that.stmt.svcMsg.invite_insert.stepOnce(function(err, row) {
          if (err) throw err;
          iReq.jso.from = iReq.from;
          iReq.jso.data = JSON.parse(iReq.jso.data);
          sClients.notify(iReq, iReq.jso);
        });
      });
      return;

    case 'acceptInvite':
      that.stmt.svcMsg.invite_update.bind(1, iReq.jso.date);
      that.stmt.svcMsg.invite_update.bind(2, iReq.jso.project);
      that.stmt.svcMsg.invite_update.stepOnce(function(err, row) {
        if (err) throw err;
        sClients.notify(iReq, {type:'acceptinvite', oid:iReq.jso.project, accept:iReq.jso.date});
      });
      return;

    case 'project':
    case 'newProject':
      var aIsNew = iReq.jso.type === 'newProject';
      if (aIsNew ? iReq.from !== sUUId : !iReq.data || !(iReq.jso.filemap instanceof Array))
        return fQuit();
      var aFiles = aIsNew ? [] : iReq.jso.filemap;
      that.stmt.svcMsg.project_selectProject.bind(1, iReq.jso.oid);
      that.stmt.svcMsg.project_selectProject.stepOnce(function(err, row) {
        if (err) throw err;
        if (row)
          return fQuit();
        if (aIsNew) {
          var aDb = new sqlite.Database();
          var aPath = makePath(iReq.jso.oid);
          aDb.open(aPath, function(err) {
            if (err) throw err;
            var aSchemaSql = createSchema(Project.prototype.kSchema, aPath);
            aSchemaSql += "INSERT OR IGNORE INTO revision (oid, map, parents) VALUES (' ', '"+Project.prototype.revisionMapJson('notouch')+"', '{}');";
            aDb.exec(aSchemaSql, noOpCallback, function() {
              aDb.close();
              fFileLoop(0, 0);
            });
          });
          return;
        }
        that.stmt.svcMsg.project_selectInvite.bind(1, iReq.jso.oid);
        that.stmt.svcMsg.project_selectInvite.stepOnce(function(err, row) {
          if (err) throw err;
          if (!row || !row.accept)
            return fQuit();
          fFileLoop(0, 0);
        });
      });
      function fQuit() {
        sClients.respond(iReq, {});
      }
      function fFileLoop(fileN, offset) {
        if (fileN < aFiles.length) {
          fs.writeFile(makePath(aFiles[fileN].oid), iReq.data.slice(offset, offset+aFiles[fileN].size), function(err) {
            if (err) throw err;
            fFileLoop(fileN+1, offset + aFiles[fileN].size);
          });
          return;
        }
        that.stmt.svcMsg.project_insert.bind(1, iReq.jso.oid);
        that.stmt.svcMsg.project_insert.bind(2, iReq.jso.service);
        that.stmt.svcMsg.project_insert.bind(3, aIsNew ? null : iReq.jso.data);
        that.stmt.svcMsg.project_insert.bind(4, aIsNew ? iReq.jso.data : null);
        that.stmt.svcMsg.project_insert.stepOnce(function(err, row) {
          if (err) throw err;
          delete iReq.jso.filemap;
          iReq.jso.data = JSON.parse(iReq.jso.data);
          iReq.jso.type = 'project';
          sClients.notify(iReq, iReq.jso);
        });
      }
      return;

    default:
      console.log('unknown import type: '+iReq.jso.type);
      sClients.respond(iReq, {});
    }
  };

  sProjects.setInstalled = function(iOid, iCallback) {
    this.db.exec("UPDATE project SET localData = '{}' WHERE oid = '"+iOid+"'", noOpCallback, iCallback);
  };

  sProjects.getList = {};
  sProjects.handle_getList = function(iReq) {
    var that = this;
    if (!that.stmt.getList) {
      that.db.prepare("SELECT oid, service, CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM project", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.getList = stmt;
        that.handle_getList(iReq);
      });
      return;
    }
    that.stmt.getList.results('data', function(err, array) {
      if (err) throw err;
      sClients.respond(iReq, {list:array});
    });
  };

  sProjects.getInvites = {};
  sProjects.handle_getInvites = function(iReq) {
    var that = this;
    if (!that.stmt.getInvites) {
      that.db.prepare("SELECT * FROM invite", function(err, stmt) {
        if (err) throw err;
        that.stmt.getInvites = stmt;
        that.handle_getInvites(iReq);
      });
      return;
    }
    that.stmt.getInvites.results('data', function(err, array) {
      if (err) throw err;
      sClients.respond(iReq, {list:array});
    });
  };

  sProjects.acceptInvite = { oid:true, service:true, to:true, alias:true };
  sProjects.handle_acceptInvite = function(iReq) {
    var that = this;
    if (!that.stmt.acceptInvite) {
      that.db.prepare("UPDATE invite SET accept = ? WHERE oid = ?", function(err, stmt) {
        if (err) throw err;
        that.stmt.acceptInvite = stmt;
        that.handle_acceptInvite(iReq);
      });
      return;
    }
    var aTo = {};
    aTo[iReq.to] = 0;
    var aEtc = {type:'acceptInvite', project:iReq.oid, uid:sUUId, alias:iReq.alias, date:(new Date).toISOString()};
    sServices.post(iReq.service, aTo, aEtc, null, function() {
      that.stmt.acceptInvite.bind(1, aEtc.date);
      that.stmt.acceptInvite.bind(2, iReq.oid);
      that.stmt.acceptInvite.stepOnce(function(err, row) {
        if (err) throw err;
        sClients.notify(iReq, {type:'acceptinvite', oid:iReq.oid, accept:aEtc.date});
      });
    });
  };

  sProjects.kNewSql = "\
    BEGIN TRANSACTION;\
    "+kIncrOid+";\
    INSERT INTO project VALUES ( ("+kNewOid+"), '', 'pending', '"+JSON.stringify({name:'Untitled', blurb:'something', created:(new Date).toISOString()})+"', '{}' );\
    SELECT oid, dataw AS data, service, 1 AS installed FROM project WHERE rowid = last_insert_rowid();\
    COMMIT TRANSACTION;";

  sProjects.newProject = {};
  sProjects.handle_newProject = function(iReq) {
    var that = this;
    var aProj;
    that.db.exec(this.kNewSql, function(err, row) {
      if (err) throw err;
      if (row) aProj = row;
    }, function() {
      var aEtc = { type:'newProject', oid:aProj.oid, data:aProj.data, service:aProj.service };
      sServices.post('localhost', {}, aEtc, null, function() { //. use default service id
        that.db.exec("UPDATE project SET data = NULL WHERE oid = '"+aProj.oid+"'", noOpCallback, function() {
          Project.list[aProj.oid] = new Project(aProj, function () {
            sClients.project(iReq.client, aProj.oid);
            aProj.data = JSON.parse(aProj.data);
            delete aProj.service;
            aProj.type = 'project';
            sClients.notify(iReq, aProj);
          });
        });
      });
    });
  };

  sProjects.readyAttachment = { uri:true, doctype:true };
  sProjects.handle_readyAttachment = function(iReq) {
    var aUri = url.parse(iReq.uri, true);
    sAttachments.ready(aUri.query.project, aUri.query.page, aUri.query.oid, iReq.doctype, function(path) {
      sClients.respond(iReq, { path:path });
    });
  };

  sProjects.subscribeServices = {};
  sProjects.handle_subscribeServices = function(iReq) {
    sClients.project(iReq.client, '#services');
    sClients.respond(iReq, {data:sServices.list()});
  };

  sProjects.touchService = { host:true, aliases:true, comment:true };
  sProjects.handle_touchService = function(iReq) {
    sServices.touch(iReq.host, iReq.aliases, iReq.comment, iReq);
  };

  sProjects.lookup = function(iOid, iCallback) {
    var that = this;
    if (!that.stmt.lookup) {
      that.stmt.lookup = {
        project: "SELECT oid, service, localData NOT NULL AS installed FROM project WHERE oid = ?",
        invite: "SELECT accept FROM invite WHERE oid = ?"
      };
      that.db.prepareN(that.stmt.lookup, function(err) {
        if (err) throw err;
        that.lookup(iOid, iCallback);
      });
      return;
    }
    that.stmt.lookup.project.bind(1, iOid);
    that.stmt.lookup.project.stepOnce(function(err, row) {
      if (err) throw err;
      if (row)
        return iCallback(row);
      that.stmt.lookup.invite.bind(1, iOid);
      that.stmt.lookup.invite.stepOnce(function(err, row) {
        if (err) throw err;
        iCallback(row && row.accept ? 'invite' : null);
      });
    });
  };

  sProjects._syncMakePath = function(iName, _skipMkdir) {
    return /^#/.test(iName) || iName.indexOf('.') < 0 ? sMainDir+iName : makePath(iName, _skipMkdir);
  };

  sProjects._syncGetPath = function(iName) { return this._syncMakePath(iName, true) };

  sProjects._syncStop = function(iLater, iLocal, iReq) {
    sClients.notify(iReq, {type:'linkprogress', message: iLocal ? 'canceling' : iLater ? 'session expired' : 'host busy'});
    if (sProjects.syncFromData.stop === (iLocal ? 'expired' : 'stopping'))
      iLater = false;
    if (iLater || iLocal)
      clearDirectories(iLater);
    if (iLater) {
      sProjects.syncFromData.stop = iLocal ? 'stopping' : 'expired';
    } else {
      sWelcome = 'new';
      delete sProjects.syncFromData;
      if (iLocal)
        sClients.notify(null, {type:'restart'});
    }
  };

  sProjects.syncFrom = { op:true, ssid:true, password:true, host:true };
  sProjects.handle_syncFrom = function(iReq) {
    if (!sWelcome) {
      sClients.respond(iReq, {error:'cannot sync over a database'});
      return;
    }
    if (iReq.op === 'stop') {
      if (sWelcome !== 'syncRun' && sWelcome !== 'syncPause')
        sClients.respond(iReq, {error:'sync not started'});
      else
        sProjects._syncStop(sWelcome !== 'syncPause', true, iReq);
      return;
    }
    if (!sProjects.syncFromData)
      sProjects.syncFromData = { host: { ssid:iReq.ssid, password:iReq.password, host:iReq.host }};
    sWelcome = 'syncRun';
    //. connect to ssid
    var aHost = sProjects.syncFromData.host.host.split(':');
    var aHeader = { /*'Connection':'keep-alive',*/ 'Content-Length':0 };
    var aRename = { 'sync_services':1, 'sync_instance':1 };
    var aSent = 0;

    if (!sProjects.syncFromData.list) {
      var aHtReq = http.createClient(+aHost[1] || 80, aHost[0]).request('GET', '/sync', aHeader);
      aHtReq.end();
      sClients.notify(iReq, {type:'linkprogress', message:'connecting'});
      console.log('sent newNode request');
      aHtReq.on('response', function(aResp) {
        if (aResp.statusCode === 300) {
          sProjects._syncStop(false, false);
          return;
        }
        sClients.notify(null, {type:'linkprogress', message:'starting'});
        aResp.setEncoding('ascii');
        var aNodeInfo = '';
        aResp.on('data', function(aData) { aNodeInfo += aData.toString() });
        aResp.on('end', function() {
          aNodeInfo = JSON.parse(aNodeInfo);
          aNodeInfo.host = sProjects.syncFromData.host;
          sProjects.syncFromData = aNodeInfo;
          beginDirectories();
          makePath('#autogen.0');
          fs.writeFileSync(sMainDir+'sync_filelist', JSON.stringify(aNodeInfo));
          commitDirectories();
          fGet(aNodeInfo.list, 0);
        });
      });
    } else {
      sClients.notify(iReq, {type:'linkprogress', message:'resuming'});
      fGet(sProjects.syncFromData.list, 0);
    }
    function fGet(list, idx) {
      var aHttp = http.createClient(+aHost[1] || 80, aHost[0]);
      if (sProjects.syncFromData.stop) {
        aHtReq = aHttp.request('GET', '/sync?session='+sProjects.syncFromData.session+'&done=cancel', { 'Content-Length':0 });
        aHtReq.end();
        aHtReq.on('response', function(aResp) {});
        sProjects._syncStop(false, true);
        return;
      }
      for (var aAlreadySent = 0; idx < list.length; ++idx) {
        var aFile = sProjects._syncMakePath(list[idx] in aRename ? list[idx].slice(5) : list[idx]);
        try {
          aAlreadySent += fs.statSync(aFile).size;
        } catch (err) {
          if (err.errno !== process.ENOENT) throw err;
          break;
        }
      }
      if (aAlreadySent) {
        aSent += aAlreadySent;
        sClients.notify(null, {type:'linkprogress', ratio:aSent/sProjects.syncFromData.size});
      }
      if (idx < list.length) {
        console.log('request file '+list[idx]);
        var aHtReq = aHttp.request('GET', '/sync?session='+sProjects.syncFromData.session+'&file='+encodeURIComponent(list[idx]), aHeader);
        aHtReq.end();
        aHtReq.on('response', function(aResp) {
          console.log('start recv '+aFile+' '+aResp.headers['content-length']);
          switch (aResp.statusCode) {
          case 300:
            sProjects._syncStop(true, false);
            return;
          case 400:
            fGet(list, idx+1);
            return;
          }
          var aStream = fs.createWriteStream(aFile+'-sync');
          aResp.pipe(aStream);
          aStream.on('close', function() {
            console.log('receive file '+aFile);
            syncFile(aFile+'-sync', fRename);
            syncFile(getParent(aFile), fRename);
            var aCount = 2;
            function fRename(err) {
              if (err && err.errno !== process.ENOENT) throw err;
              if (--aCount > 0)
                return;
              fs.renameSync(aFile+'-sync', aFile);
              aSent += +aResp.headers['content-length'];
              sClients.notify(null, {type:'linkprogress', ratio:aSent/sProjects.syncFromData.size});
              fGet(list, idx+1);
            }
          });
        });
        return;
      }
      aHtReq = aHttp.request('GET', '/sync?session='+sProjects.syncFromData.session+'&done=ok', { 'Content-Length':0 });
      aHtReq.end();
      aHtReq.on('response', function(aResp) {
        if (aResp.statusCode === 300) {
          sProjects._syncStop(true, false);
          return;
        }
        delete sProjects.syncFromData;
        fs.unlinkSync(sMainDir+'sync_filelist');
        startDatabase(function() {
          sClients.notify(null, {type:'linkprogress', message:'complete'});
        });
      });
    }
  };

  sProjects.syncTo = function(iReq, iCallback) {
    if (sWelcome || (!iReq.session ? sProjects.syncToSession : iReq.session !== sProjects.syncToSession)) {
      iCallback(300);
      return;
    }
    if (iReq.file) {
      var aPath = sProjects._syncGetPath(iReq.file);
      fs.stat(aPath, function(err, stats) {
        if (err && err.errno !== process.ENOENT) throw err;
        iCallback(stats ? 200 : 400, stats && aPath, stats && stats.size);
      });
      return;
    } else if (iReq.done) {
      delete sProjects.syncToSession;
      Queue.resume();
      sClients.notify(null, {type:'restart'});
      if (iReq.done === 'cancel') {
        process.nextTick(fCb);
        return;
      }
      fs.unlink(sMainDir+'sync_services', fDone);
      fs.unlink(sMainDir+'sync_instance', fDone);
      var aCount = 2;
      function fDone(err) {
        if (err && err.errno !== process.ENOENT) throw err;
        if (--aCount === 0)
          syncFile(sMainDir, fCb);
      }
      function fCb(err) {
        if (err) throw err;
        iCallback(200); //. if this isn't received, nodeid will be abandoned
      }
      return;
    }
    sProjects.syncToSession = Date.now().toString();
    sClients.notify(null, {type:'restart'}); //. should wait til clients have pushed updates
    var aDb = new sqlite.Database();
    try {
    var aStat = fs.statSync('sync_services');
    } catch (err) {
      if (err.errno !== process.ENOENT) throw err;
    }
    if (!aStat) {
      dupFile(sMainDir+'services', sMainDir+'sync_services-tmp', function(err) { //. could services db change during copy?
        if (err) throw err;
        aDb.open(sMainDir+'sync_services-tmp', function(err) {
          if (err) throw err;
          var aSql = createSchema({sync_instance:kSchema.instance}) +"\
                     BEGIN TRANSACTION; \
                     INSERT OR IGNORE INTO instance (uuid) VALUES ('"+sUUId+"'); ";
          for (var aSvc in sServices.s)
            aSql += "UPDATE service SET addnode = '!'||nodeid, nodeid = '"+uuid.generate()+"' WHERE host = '"+aSvc+"';";
          aSql   += "COMMIT TRANSACTION; ";
          aDb.exec(aSql, noOpCallback, function() {
            aDb.close();
            fs.renameSync(sMainDir+'sync_services-tmp', sMainDir+'sync_services');
            fAddNodes();
          });
        });
      });
    } else {
      fAddNodes();
    }
    function fAddNodes() {
      aDb.open(sMainDir+'sync_services', function(err) {
        if (err) throw err;
        var aNodeId = {};
        aDb.exec("SELECT addnode, host, nodeid FROM service; \
                  ATTACH '"+sMainDir+"sync_instance' AS instance; \
                  BEGIN TRANSACTION; ", function(err, row) {
          if (err) throw err;
          if (row && row.addnode) aNodeId[row.host] = row.nodeid;
        }, fIter);
        function fIter() {
          for (var aSvc in aNodeId) {
            sServices.addNode(aSvc, aNodeId[aSvc], function(done, offset) {
              if (!done)
                return fIter();
              var aSql = "UPDATE service SET addnode = NULL WHERE host = '"+aSvc+"';";
              if (offset)
                aSql += "UPDATE instance SET offset = "+offset+";";
              aDb.exec(aSql, noOpCallback, fIter);
            });
            delete aNodeId[aSvc];
            return;
          }
          aDb.exec("COMMIT TRANSACTION", noOpCallback, function() {
            aDb.close();
            var aData = { session:sProjects.syncToSession, size:0, list:[] };
            var aOmit = { 'instance':1, 'services':1, '#editcache':1, '#revisioncache':1 };
            Queue.pause(function() {
              fReadDir('');
              iCallback(200, aData);
            });
            function fReadDir(path, type) {
              var aList = fs.readdirSync(sMainDir+path);
              for (var a=0; a < aList.length; ++a) {
                if (!type && aList[a] in aOmit)
                  continue;
                var aStats = fs.statSync(sMainDir+path+aList[a]);
                if (aStats.isFile()) {
                  aData.size += aStats.size;
                  aData.list.push((type === 'file' ? '' : path)+aList[a]);
                } else if (aStats.isDirectory()) {
                  var aType = type === '#' || /^#/.test(aList[a]) ? '#' : 'file';
                  fReadDir(path+aList[a]+'/', aType);
                }
              }
            }
          });
        }
      });
    }
  };


function Project(iRecord, iCallback) {
  this.oid = iRecord.oid;
  this.service = iRecord.service;
  this.revisionMap = null;
  this.parentMap = null;
  this.stmt = {};
  this.db = new sqlite.Database();
  this.queue = new Queue;

  var that = this;
  var aPath = makePath(iRecord.oid);
  that.db.open(aPath, function(openErr) {
    if (openErr) throw openErr;
    var aSchemaSql = createSchema(that.kSchema, aPath);
    aSchemaSql += "SELECT oid, map FROM revision WHERE oid LIKE '!%';";
    var aRevPending;
    that.db.exec(aSchemaSql, function(err, row) {
      if (err) throw err;
      if (row) aRevPending = row;
    }, function () {
      if (/^#autogen/.test(iRecord.oid)) {
        that.queue.next();
        iCallback();
        return;
      }
      that.db.prepare("UPDATE revision SET map = ?, author = "+sNodeOffset+" WHERE oid = ' '", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.setRevisionMap = stmt;
        if (aRevPending) {
          fs.readFile(sSendDir+aRevPending.oid.slice(1), function(err, buffer) {
            if (err && err.errno !== process.ENOENT) throw err;
            if (buffer) {
              var aRevMsg = MqClient.unpackMsg(buffer);
              var aRevBuf = aRevMsg._buf;
              delete aRevMsg._buf;
            }
            that._finishRevision(that.db, JSON.parse(aRevPending.map), aRevMsg, aRevBuf, fDone);
          });
        } else {
          that.db.exec("INSERT OR IGNORE INTO revision (oid, map, parents) VALUES (' ', '"+that.revisionMapJson()+"', '{}')", noOpCallback, fDone);
        }
      });
    });
    function fDone() {
      that.db.exec("SELECT map, parents FROM revision WHERE oid = ' '", function(err, row) {
        if (err) throw err;
        if (row) {
          that.revisionMap = row.map ? JSON.parse(row.map) : that.revisionMapInit();
          that.parentMap = JSON.parse(row.parents);
        }
      }, function() {
        that.queue.next();
        iCallback();
      });
    }
  });
}

  Project.list = {};

  Project.prototype.finalize = function() {
    sqlite.Database.finalizeN(this.stmt);
    this.db.close();
    delete Project.list[this.oid];
  };

  kSchemaV.filename = '2012-03-07T00:07:44Z';

  Project.prototype.kSchema = {
    instance: {},
    projects: {},
    filename: {
      schemav: { v: 'text' },
      page: {
        oid: 'text unique',
        data: 'text',     // json { name:'', added:'date' }
        dataw: 'text',
        layout: 'text',   // json [ {pid:'',...}, ... ]
        layoutw: 'text'
      },
      revision: {
        oid: 'text unique',       // ' ' for open revision
        author: 'text',
        date: 'text',      // iso/utc time
        map: 'text',        // json {project:{}, page:{oid:{op:'.', touch:'', part:{oid:{op:'!', touch:''}, ...}}, ...}}
        parents: 'text',   // { author:counter, ... }
        sideline: 'text'
      },
      diff: {
        object: 'text', // oid
        revision: 'text', // oid
        data: 'blob',
        '': 'primary key ( object, revision )'
      },
      message: {
        date: 'text',      // iso/utc time
        html: 'text'
      },
      member: {
        uid: 'text unique',
        alias: 'text unique',
        joined: 'text',     // iso/utc time
        left: 'text'        // iso/utc time
      },
      clientstate: {
        client: 'text unique',    // mac addr
        state: 'text'      // json { ... }
      }
    }
  };

  Project.prototype.projectImport = { autogen:true, from:true, jso:true, data:true };
  Project.prototype.handle_projectImport = function(iReq) {
    var that = this;
    if (!that.stmt.svcMsg) {
      that.stmt.svcMsg = {
        member_find: "SELECT uid FROM member WHERE uid = ? OR alias = ?",
        member_insert: "INSERT OR REPLACE INTO member VALUES (?, ?, ?, ?)",
        member_setAlias: "UPDATE member SET alias = ?2 WHERE uid = ?1",
        member_setLeft: "UPDATE member SET left = ?2 WHERE uid = ?1",
        member_select: "SELECT uid, alias, joined, left FROM member WHERE alias = ?",
        accept_select: "SELECT uid, left FROM member WHERE alias = ?",
        revision_has: "SELECT (SELECT 1 FROM member WHERE uid = ?) AS hasmem, (SELECT 1 FROM revision WHERE oid = ?) AS hasrev",
        revision_insert: "INSERT INTO revision VALUES (?, ?, ?, ?, ?, ?)",
        revision_insertDiff: "INSERT INTO diff VALUES ( ?1, ?3, ?2 )",
        revision_updateParentMap: "UPDATE revision SET parents = ? WHERE oid = ' '",
        revision_updateProject: "UPDATE projects.project SET data = ?, dataw = NULL WHERE oid = '"+that.oid+"'",
        revision_selectPage: "SELECT data, layout FROM page WHERE oid = ?",
        revision_insertPage: "INSERT OR REPLACE INTO page VALUES (?, ?, ?, ?, ?)"
      };
      that.db.prepareN(that.stmt.svcMsg, function(err) {
        if (err) throw err;
        that.handle_projectImport(iReq);
      });
      return;
    }
    switch(iReq.jso.type) {

    case 'memberAlias':
      that.stmt.svcMsg.member_find.bindN(iReq.jso.uid || null, iReq.jso.alias);
      that.stmt.svcMsg.member_find.stepOnce(function(err, row) {
        if (err) throw err;
        if (iReq.jso.invite === 'invalid') {
          that.stmt.svcMsg.member_insert.bindN(null, iReq.jso.alias, 'invalid', 'invalid');
          that.stmt.svcMsg.member_insert.stepOnce(fStep);
        } else if (!row || (!row.uid && iReq.jso.uid)) {
          that.stmt.svcMsg.member_insert.bindN(iReq.jso.uid || null, iReq.jso.alias, iReq.jso.joined || null, null);
          that.stmt.svcMsg.member_insert.stepOnce(fStep);
        } else if (row.uid && iReq.jso.alias) {
          that.stmt.svcMsg.member_setAlias.bindN(iReq.jso.uid, iReq.jso.alias);
          that.stmt.svcMsg.member_setAlias.stepOnce(fStep);
        } else if (row.uid && iReq.jso.resign) {
          that.stmt.svcMsg.member_setLeft.bindN(iReq.jso.uid, (new Date).toISOString());
          that.stmt.svcMsg.member_setLeft.stepOnce(fStep);
        } else
          fCircInvite();
        function fStep(err) {
          if (err) throw err;
          that.stmt.svcMsg.member_select.bind(1, iReq.jso.alias);
          that.stmt.svcMsg.member_select.stepOnce(function(err, row) {
            if (err) throw err;
            row.type = iReq.jso.uid === sUUId ? 'setuseralias' : 'memberalias';
            fCircInvite(row);
          });
        }
        function fCircInvite(notify) {
          if (iReq.jso.invite && iReq.jso.invite !== 'invalid')
            sServices.listPost(that.service, that.oid, { type:'memberAlias', project:that.oid, alias:iReq.jso.alias }, null, fRespond);
          else if (iReq.from === sUUId && iReq.jso.uid && iReq.jso.uid !== sUUId)
            that.sendProject(iReq.jso.uid, fRespond);
          else
            fRespond();
          function fRespond() {
            if (notify)
              sClients.notify(iReq, notify, that.oid);
            else
              sClients.respond(iReq, {});
          }
        }
      });
      return;

    case 'acceptInvite':
      that.stmt.svcMsg.accept_select.bind(1, iReq.jso.alias);
      that.stmt.svcMsg.accept_select.stepOnce(function(err, row) {
        if (err) throw err;
        if (!row || row.left || row.uid && row.uid !== iReq.jso.uid) {
          console.log('got acceptInvite for invalid member: '+sys.inspect(row))
          sClients.respond(iReq, {});
          return; //. log error
        }console.log('got acceptInvite');
        var aMsgToAll = { type:'memberAlias', project:that.oid, uid:iReq.from, alias:iReq.jso.alias, joined:iReq.jso.date };
        sServices.listEdit(that.service, that.oid, 'add', iReq.from, aMsgToAll, null, function() {
          sClients.respond(iReq, {});
        });
      });
      return;

    case 'revision':
      var aNotify;
      that.stmt.svcMsg.revision_has.bindN(iReq.from, iReq.jso.oid);
      that.stmt.svcMsg.revision_has.stepOnce(function(err, row) {
        if (err) throw err;
console.log(row);
        if (iReq.from !== sUUId && !row.hasmem || row.hasrev) {
          sClients.respond(iReq, {});
          console.log('skip rev '+iReq.jso.oid+' from '+iReq.from);
          return;
        }
        that.db.exec("BEGIN TRANSACTION", noOpCallback, function() {
          aNotify = [];
          for (var a in that.parentMap)
            if (!(a in iReq.jso.parents))
              iReq.jso.parents[a] = 0;
          that.checkConflict(iReq.jso, aNotify, function(sideline, partlist) {
console.log(partlist);
            iReq.jso.sideline = sideline;
            if (partlist)
              iReq.jso.map.page.sideline = {part:partlist};
            that.stmt.svcMsg.revision_insert.bindN((sideline ? '' : '!')+iReq.jso.oid, iReq.jso.author, iReq.jso.date,
                                                   JSON.stringify(iReq.jso.map), JSON.stringify(iReq.jso.parents), sideline || null);
            that.stmt.svcMsg.revision_insert.stepOnce(function(err, row) {
              if (err) throw err;
              that.stmt.svcMsg.revision_insertDiff.bind(3, iReq.jso.oid);
              if (sideline)
                return fIter();
              that.parentMap[iReq.jso.author] = +iReq.jso.oid.slice(iReq.jso.oid.indexOf('.')+1);
              that.stmt.svcMsg.revision_updateParentMap.bind(1, JSON.stringify(that.parentMap));
              that.stmt.svcMsg.revision_updateParentMap.stepOnce(function(err, row) {
                if (err) throw err;
                fIter();
              });
            });
          });
        });
      });
      function fIter(iterN, iterO) {
        if (!iterN) iterN = iterO = 0;
        if (iterN < iReq.jso.list.length) {
          var aStart = iterO;
          iterO += iReq.jso.list[iterN].size;
          var aDiff = iReq.jso.list[iterN].type === 'part' ? iReq.data.slice(aStart, iterO) : iReq.data.toString('ascii', aStart, iterO);
          if (iReq.jso.sideline)
            return fSetDiff(aDiff);
          switch(iReq.jso.list[iterN].type) {
          case 'proj':
            var aData = JSON.parse(aDiff).add;
            that.stmt.svcMsg.revision_updateProject.bind(1, JSON.stringify(aData));
            that.stmt.svcMsg.revision_updateProject.stepOnce(function(err, row) {
              if (err) throw err;
              sClients.notify(null, {type:'projectdata', oid:that.oid, data:aData});
              fSetDiff(aDiff);
            });
            break;
          case 'page':
            that.stmt.svcMsg.revision_selectPage.bind(1, iReq.jso.list[iterN].oid);
            that.stmt.svcMsg.revision_selectPage.stepOnce(function(err, row) {
              if (err) throw err;
              var aPage = row || {};
              aPage.data = JSON.parse(aPage.data || '{}');
              aPage.layout = JSON.parse(aPage.layout || '[]');
              that.patch(aPage, JSON.parse(aDiff));
              that.stmt.svcMsg.revision_insertPage.bindN(iReq.jso.list[iterN].oid, JSON.stringify(aPage.data), null, JSON.stringify(aPage.layout), null);
              that.stmt.svcMsg.revision_insertPage.stepOnce(function(err, row) {
                if (err) throw err;
                aNotify.push({type:'page', oid:iReq.jso.list[iterN].oid, data:aPage.data});
                fSetDiff(aDiff);
              });
            });
            break;
          case 'part':
            var aPath = iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || makePath(iReq.jso.list[iterN].oid);
            if (iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid])
              fApplyDiff(false);
            else
              fs.stat(aPath, fApplyDiff);
            function fApplyDiff(noPath) {
              xd.patch(!noPath && aPath, aDiff, aPath+'.temp', function(err) {
                if (err) throw err;
                fs.rename(aPath+'.temp', iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || aPath+'.new', function(err) {
                  if (err) throw err;
                  if (noPath)
                    return fSetDiff(null);
                  xd.diff(iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || aPath+'.new', aPath, function(err, diff) {
                    if (err) throw err;
                    fSetDiff(diff);
                  });
                });
              });
            }
            break;
          default:
            throw new Error('revision has unsupported type '+iReq.jso.list[iterN].type);
          }
          function fSetDiff(diff) {
            that.stmt.svcMsg.revision_insertDiff.bindN(iReq.jso.list[iterN].oid, diff);
            that.stmt.svcMsg.revision_insertDiff.stepOnce(function(err, row) {
              if (err) throw err;
              fIter(++iterN, iterO);
            });
          }
          return;
        }
        that.db.exec("COMMIT TRANSACTION", noOpCallback, function() {
          if (!iReq.jso.sideline)
            that._finishRevision(that.db, iReq.jso.map, null, null, fDone);
          else
            fDone();
          function fDone() {
            delete iReq.jso.list;
            aNotify.push(iReq.jso);
            sClients.notify(iReq, aNotify, that.oid);
          }
        });
      }
      return;
    default:
      throw new Error('unknown import type: '+iReq.jso.type);
    }
  };

  Project.prototype.sendProject = function(iTo, iCallback) {
    var that = this;
    var aMsgHead, aPath;
    this.db.exec("SELECT oid, service, data FROM projects.project WHERE oid = '"+this.oid+"';", function(err, row) {
      if (err) throw err;
      if (row) aMsgHead = row;
    }, function() {
      aMsgHead.filemap = [{oid:aMsgHead.oid+'.temp', size:0}];
      var aOids = {};
      aPath = getPath(aMsgHead.oid);
      dupFile(aPath, aPath+'.temp', function(err) {
        if (err) throw err;
        var aDb = new sqlite.Database();
        aDb.open(aPath+'.temp', function(err) {
          if (err) throw err;
          aDb.exec("BEGIN TRANSACTION;\
                    UPDATE page SET layoutw = NULL, dataw = NULL;\
                    UPDATE revision SET map = NULL WHERE oid = ' ';\
                    DELETE from message;\
                    DELETE from clientstate;\
                    COMMIT TRANSACTION;\
                    SELECT layout from page;", function(err, row) {
            if (err) throw err;
            if (!row) return;
            var aLayout = JSON.parse(row.layout);
            for (var a=0; a < aLayout.length; ++a)
              if (aLayout[a].oid && !aOids[aLayout[a].oid]) {
                aMsgHead.filemap.push({oid:aLayout[a].oid, size:0});
                aOids[aLayout[a].oid] = true;
              }
          }, function() {
            aDb.close();
            fFileLoop(0, 0);
          });
        });
      });
    });
    function fFileLoop(fileN, allSize) {
      if (fileN < aMsgHead.filemap.length) {
        fs.readFile(getPath(aMsgHead.filemap[fileN].oid), function(err, buf) {
          if (err && err.errno !== process.ENOENT) throw err;
          if (err) {
            aMsgHead.filemap.splice(fileN, 1);
          } else {
            aMsgHead.filemap[fileN++].size = buf;
            allSize += buf.length;
          }
          fFileLoop(fileN, allSize);
        });
        return;
      }
      fs.unlink(aPath+'.temp', noOpCallback);
      var aAllBuf = new Buffer(allSize);
      for (var a=0, aOff=0; a < aMsgHead.filemap.length; aOff += aMsgHead.filemap[a++].size) {
        aMsgHead.filemap[a].size.copy(aAllBuf, aOff, 0);
        aMsgHead.filemap[a].size = aMsgHead.filemap[a].size.length;
      }
      aMsgHead.filemap[0].oid = aMsgHead.oid;
      aMsgHead.type = 'project';
      var aTo = {};
      aTo[iTo] = 1;
      sServices.post(that.service, aTo, aMsgHead, aAllBuf, iCallback);
    }
  };

  Project.prototype.checkConflict = function(iRevision, oNotify, iCallback, _state) {
    var that = this;
    if (!that.stmt.checkConflict) {
      that.stmt.checkConflict = {
        revision: "SELECT revision.rowid, oid, map, parents, sideline, author, CASE WHEN member.joined IS NULL THEN '3333' ELSE member.joined END AS joined \
                    FROM revision LEFT JOIN member ON author = member.uid WHERE revision.rowid != 1 ORDER BY revision.rowid DESC",
        member: "SELECT joined FROM member WHERE uid = ?",
        diff: "SELECT data FROM diff WHERE revision = ? AND object = ?",
        page: "SELECT data, layout FROM page WHERE oid = ?",
        proj: "SELECT data FROM projects.project WHERE oid = ?",
        state: "SELECT client, state FROM clientstate",
        setdiff: "UPDATE diff SET data = ?3 WHERE revision = ?1 AND object = ?2",
        setpage: "UPDATE page SET data = ?2, layout = ?3 WHERE oid = ?1",
        setproj: "UPDATE projects.project SET data = ?2 WHERE oid = ?1",
        setstate: "UPDATE clientstate SET state = ?2 WHERE client = ?1",
        setrev: "UPDATE revision SET sideline = ?2 WHERE oid = ?1",
        parent: "SELECT oid FROM revision WHERE sideline IS NULL AND author = ?"
      };
      that.db.prepareN(that.stmt.checkConflict, function(err) {
        if (err) throw err;
        that.checkConflict(iRevision, oNotify, iCallback);
      });
      return;
    }
    if (!_state) {
      that.stmt.checkConflict.member.bind(1, iRevision.author);
      that.stmt.checkConflict.member.stepOnce(function(err, author) {
        if (err) throw err;
        that.checkConflict(iRevision, oNotify, iCallback, author ? author.joined : '3333');
      });
      return;
    }
    that.stmt.checkConflict.revision.step(function(err, row) {
      if (err) throw err;
      if (typeof _state === 'string') {
        _state = { conflict:[], chain:{}, parents:{}, ancestors:{}, authorJoined:_state };
        for (var a in iRevision.parents)
          _state.parents[a] = _state.ancestors[a] = iRevision.parents[a];
        fLogConflict(iRevision, { rowid:row ? row.rowid+1 : 2, oid:' ', map:that.revisionMap, parents:that.parentMap, author:sUUId, joined:'3333' }, 'chain');
      }
      if (row) {
        var aOidCounter = +row.oid.slice(row.oid.indexOf('.')+1);
        row.map = JSON.parse(row.map);
        row.parents = JSON.parse(row.parents);
        if (aOidCounter === _state.ancestors[row.author]) {
          _state.ancestors[row.author] = row.parents[row.author];
          row.isParent = true;
        }
        fLogConflict(iRevision, row, 'chain');
        if (iRevision.parents[row.author] === 0 && !(row.author in row.parents) || aOidCounter === iRevision.parents[row.author])
          delete _state.parents[row.author];
      }
      for (var any in _state.parents) break;
      if (any) {
        if (!row) throw new Error('parent not found');
        return that.checkConflict(iRevision, oNotify, iCallback, _state);
      }
      function fLogConflict(main, alt, chain) {
        if (chain) {
          for (var a in alt.parents) {
            if (alt.parents[a] === 0)
              continue;
            var aP = a+'.'+alt.parents[a];
            if (!_state.chain[aP])
              _state.chain[aP] = {};
            _state.chain[aP][alt.oid] = alt;
          }
        }
        if (!alt.sideline && !alt.isParent || alt.sideline && alt.isParent || !chain && main.joined > alt.joined) {
          if (alt.map.touch && main.map.touch)
            return fRecur(true);
          for (var aPg in main.map.page) {
            if (aPg in alt.map.page) {
              if (alt.map.page[aPg].op === '!' && main.map.page[aPg].op === '!')
                return fRecur(true);
              for (var aPt in main.map.page[aPg].part)
                if (aPt in alt.map.page[aPg].part)
                  return fRecur(true);
            }
          }
        }
        return fRecur(false);
        function fRecur(hasConflict) {
          if (hasConflict) {
            if (!alt.sideline || alt.isParent) {
              for (var a=0; a < _state.conflict.length && alt.rowid < _state.conflict[a].rowid; ++a) {}
              _state.conflict.splice(a, 0, alt);
              alt.sideline = true;
            }
            if (!chain && main.joined > alt.joined)
              alt.joined = main.joined;
          }
          if (alt.isParent || !_state.chain[alt.oid])
            return;
          if (!chain)
            for (var a in _state.chain[alt.oid])
              fLogConflict(main, _state.chain[alt.oid][a]);
          if (hasConflict)
            for (var a in _state.chain[alt.oid])
              fLogConflict(alt, _state.chain[alt.oid][a]);
        }
      }
      that.stmt.checkConflict.revision.reset();
      if (_state.conflict.length === 0)
        return iCallback(null, {});
      var aSidelinedCurr = _state.conflict[0].oid === ' ';
      for (var a=_state.conflict.length-1; a >= +aSidelinedCurr; --a)
        if (_state.conflict[a].isParent || _state.conflict[a].joined < _state.authorJoined)
          return iCallback(_state.conflict[a].oid);
      that.stmt.checkConflict.state.results('state', function(err, states) {
        if (err) throw err;
        var aRevN = 0;
        var aModList = { proj:{}, page:{}, part:{} };
        if (aSidelinedCurr)
          that.handle_commitRevision(null, fSideline);
        else
          fSideline();
        function fSideline(newrev) {
          if (newrev) {
            _state.conflict[0].oid = newrev.oid;
            oNotify.push(newrev);
          }
          var aConflict = _state.conflict[aRevN];
          var aObject;
          for (var aPg in aConflict.map.page) {
            for (var aPt in aConflict.map.page[aPg].part) break;
            aObject = aPt || aConflict.map.page[aPg].op !== '.' && aPg;
            if (aPt) {
              delete aConflict.map.page[aPg].part[aPt];
            } else {
              delete aConflict.map.page[aPg];
              for (var a=0; a < states.length; ++a) {
                if (!states[a].state.page[aPg] || !states[a].state.page[aPg][' '])
                  continue;
                delete states[a].state.page[aPg][' '];
                states[a]._update = true;
              }
            }
            if (aObject) {
              if (!aModList[aPt?'part':'page'][aObject])
                aModList[aPt?'part':'page'][aObject] = null;
              break;
            }
          }
          if (!aObject && aConflict.map.touch) {
            delete aConflict.map.touch;
            aObject = that.oid;
            if (!aModList.proj[aObject])
              aModList.proj[aObject] = null;
          }
          if (aObject) {
            that.stmt.checkConflict.diff.bind(1, aConflict.oid);
            that.stmt.checkConflict.diff.bind(2, aObject);
            that.stmt.checkConflict.diff.stepOnce(function(err, diffRow) {
              if (err) throw err;
              if (aObject in aModList.part) {
                var aPath = getPath(aObject);
                if (!diffRow.data) {
                  //. flag file for removal by finishRevision
                  fForwardDiff({errno:process.ENOENT});
                } else if (aSidelinedCurr && aRevN === 0) {
                  dupFile(aPath, aPath+'.temp', fForwardDiff);
                } else {
                  xd.patch(aModList.part[aObject] || aPath, diffRow.data, aPath+'.temp', fForwardDiff);
                }
                function fForwardDiff(err) {
                  if (err && err.errno !== process.ENOENT) throw err;
                  xd.diff(!err && aPath+'.temp', aModList.part[aObject] || (aSidelinedCurr && aRevN === 0 ? aPath+'.w' : aPath), function(err, diff) {
                    if (err) throw err;
                    that.stmt.checkConflict.setdiff.bind(1, aConflict.oid);
                    that.stmt.checkConflict.setdiff.bind(2, aObject);
                    that.stmt.checkConflict.setdiff.bind(3, diff);
                    that.stmt.checkConflict.setdiff.stepOnce(function(err, row) {
                      if (err) throw err;
                      fs.rename(aPath+'.temp', aPath+'.new', function(err) {
                        if (err && err.errno !== process.ENOENT) throw err;
                        if (!err && !aModList.part[aObject])
                          aModList.part[aObject] = aPath+'.new';
                        fSideline();
                      });
                    });
                  });
                }
              } else {
                var aType = aObject in aModList.page ? 'page' : 'proj';
                if (!aModList[aType][aObject]) {
                  that.stmt.checkConflict[aType].bind(1, aObject);
                  that.stmt.checkConflict[aType].stepOnce(function(err, row) {
                    if (err) throw err;
                    if (aType === 'page')
                      row.layout = JSON.parse(row.layout);
                    row.data = JSON.parse(row.data);
                    aModList[aType][aObject] = row;
                    fUpdateData();
                  });
                } else {
                  fUpdateData();
                }
                function fUpdateData() {
                  that.unpatch(aModList[aType][aObject], JSON.parse(diffRow.data));
                  that.stmt.checkConflict['set'+aType].bind(1, aObject);
                  that.stmt.checkConflict['set'+aType].bind(2, JSON.stringify(aModList[aType][aObject].data));
                  if (aType === 'page')
                    that.stmt.checkConflict['set'+aType].bind(3, JSON.stringify(aModList[aType][aObject].layout));
                  that.stmt.checkConflict['set'+aType].stepOnce(function(err, row) {
                    if (err) throw err;
                    fSideline();
                  });
                }
              }
            });
            return;
          }
          that.stmt.checkConflict.setrev.bind(1, aConflict.oid);
          that.stmt.checkConflict.setrev.bind(2, iRevision.oid);
          that.stmt.checkConflict.setrev.stepOnce(function(err, row) {
            if (err) throw err;
            if (that.parentMap[aConflict.author] === +aConflict.oid.slice(aConflict.oid.indexOf('.')+1)) {
              that.stmt.checkConflict.parent.bind(1, aConflict.author);
              that.stmt.checkConflict.parent.stepOnce(function(err, row) {
                if (err) throw err;
                if (row)
                  that.parentMap[aConflict.author] = +row.oid.slice(row.oid.indexOf('.')+1);
                else
                  delete that.parentMap[aConflict.author];
                fNext();
              });
            } else {
              fNext();
            }
            function fNext() {
              oNotify.push({type:'revisionsideline', oid:aConflict.oid});
              if (++aRevN < _state.conflict.length)
                fSideline();
              else
                fSaveState();
              function fSaveState() {
                for (var a=0; a < states.length; ++a) {
                  if (!states[a]._update)
                    continue;
                  delete states[a]._update;
                  that.stmt.checkConflict.setstate.bind(1, states[a].client);
                  that.stmt.checkConflict.setstate.bind(2, JSON.stringify(states[a].state));
                  that.stmt.checkConflict.setstate.stepOnce(function(err, row) {
                    if (err) throw err;
                    fSaveState();
                  });
                  //. notify subscribers whose state changed
                  return;
                }
                iCallback(null, aModList.part);
              }
            }
          });
        }
      });
    });  
  };

  Project.prototype.hasMembers = function(iCallback) {
    var that = this;
    if (!that.stmt.members) {
      that.db.prepare("SELECT uid FROM member WHERE left IS NULL AND uid NOT NULL AND uid != '"+sUUId+"'", function(err, stmt) {
        if (err) throw err;
        that.stmt.members = stmt;
        that.hasMembers(iCallback);
      });
      return;
    }
    that.stmt.members.stepOnce(function(err, row) {
      if (err) throw err;
      iCallback(!!row);
    });
  };

  Project.prototype.postMsg = { msg:true };
  Project.prototype.handle_postMsg = function(iReq) {
    var that = this;
    if (!that.stmt.msgPost) {
      this.db.prepare("INSERT INTO message VALUES ( datetime('now'), ? )", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.msgPost = stmt;
        that.handle_postMsg(iReq);
      });
      return;
    }
    that.stmt.msgPost.bind(1, iReq.msg);
    that.stmt.msgPost.stepOnce(function(err, row) {
      if (err) throw err;
      var aMsg;
      that.db.exec("SELECT * FROM message WHERE rowid = last_insert_rowid()", function(err, row) {
        if (err) throw err;
        if (row) aMsg = row;
      }, function() {
        aMsg.type = 'message';
        sClients.notify(iReq, aMsg, that.oid);
      });
    });
  };

  Project.prototype.getMsgList = {};
  Project.prototype.handle_getMsgList = function(iReq) {
    var that = this;
    if (!that.stmt.msgList) {
      this.db.prepare("SELECT * FROM message ORDER BY date DESC", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.msgList = stmt;
        that.handle_getMsgList(iReq);
      });
      return;
    }
    that.stmt.msgList.results(function(err, array) {
      if (err) throw err;
      sClients.respond(iReq, {list:array});
    });
  };

  Project.prototype.setClientState = { data:true };
  Project.prototype.handle_setClientState = function(iReq) {
    var that = this;
    if (!that.stmt.setState) {
      that.db.prepare("INSERT OR REPLACE INTO clientstate VALUES ( ?, ? )", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.setState = stmt;
        that.handle_setClientState(iReq);
      });
      return;
    }
    that.stmt.setState.bind(1, iReq.client);
    that.stmt.setState.bind(2, JSON.stringify(iReq.data));
    that.stmt.setState.stepOnce(function(stepErr, row) {
      if (stepErr) throw stepErr;
      sClients.respond(iReq, {status:'ok'});
    });
  };

  Project.prototype.setService = { autogen:true, service:true };
  Project.prototype.handle_setService = function(iReq) {
    var that = this;
    that.db.exec("UPDATE projects.project SET service = '"+iReq.service+"' WHERE oid = '"+that.oid+"'", noOpCallback, function() {
      that.service = iReq.service;
      sClients.notify(iReq, {type:'setservice', service:iReq.service}, that.oid);
    });
  };

  Project.prototype.setUseralias = { autogen:true, alias:true };
  Project.prototype.handle_setUseralias = function(iReq) {
    var that = this;
    var aUpdt = { type:'memberAlias', project:that.oid, alias:iReq.alias, uid:sUUId };
    sServices.listPostAll(that.service, that.oid, aUpdt, null, function() {
      that.db.exec("BEGIN TRANSACTION;\
                    INSERT OR IGNORE INTO member VALUES ( '"+sUUId+"', '"+iReq.alias+"', '"+(new Date).toISOString()+"', NULL );\
                    UPDATE member SET alias = '"+iReq.alias+"' WHERE uid = '"+sUUId+"';\
                    COMMIT TRANSACTION;", noOpCallback, function() {
        sClients.notify(iReq, {type:'setuseralias', alias:iReq.alias}, that.oid);
      });
    });
  };

  Project.prototype.addMember = { autogen:true, alias:true };
  Project.prototype.handle_addMember = function(iReq) {
    var that = this;
    if (!that.stmt.addMember) {
      that.db.prepare("INSERT INTO member VALUES ( NULL, ?, ?, NULL )", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.addMember = stmt;
        that.handle_addMember(iReq);
      });
      return;
    }
    if (!that.service)
      return sClients.respond(iReq, {error:'addMember requires an active service'});
    var aUseralias;
    that.db.exec("SELECT alias FROM member WHERE uid = '"+sUUId+"'", function(err, row) {
      if (err) throw err;
      if (row) aUseralias = row.alias;
    }, function() {
      if (!aUseralias || !sServices.hasAlias(that.service, aUseralias))
        return sClients.respond(iReq, {error:'addMember requires a user alias'});
      var aInvite;
      that.db.exec("SELECT service, data FROM projects.project WHERE oid='"+that.oid+"'", function(err, row) {
        if (err) throw err;
        if (row) aInvite = { type:'invite', date:(new Date).toISOString(), toAlias:iReq.alias, fromAlias:aUseralias,
                             oid:that.oid, service:row.service, data:row.data };
      }, function() {
        if (!aInvite.data)
          return sClients.respond(iReq, {error:'addMember requires a project with a revision'});
        sServices.post(aInvite.service, iReq.alias, aInvite, null, function() {
          var aDate = (new Date).toISOString();
          that.stmt.addMember.bind(1, iReq.alias);
          that.stmt.addMember.bind(2, aDate);
          that.stmt.addMember.stepOnce(function(stepErr, row) {
            if (stepErr) throw stepErr;
            sClients.notify(iReq, {type:'memberalias', alias:iReq.alias, uid:null, joined:aDate, left:null}, that.oid);
          });
        });
      });
    });
  };

  Project.prototype.resign = { autogen:true };
  Project.prototype.handle_resign = function(iReq) {
    var that = this;
    var aDel = { type:'memberAlias', project:that.oid, uid:sUUId, resign:true };
    sServices.listEdit(that.service, that.oid, 'remove', sUUId, aDel, null, function() {
      var aRow;
      that.db.exec("UPDATE member SET left = 'pending' WHERE uid = '"+sUUId+"';\
                    SELECT alias, joined, left, uid FROM member WHERE uid = '"+sUUId+"';", function(err, row) {
        if (err) throw err;
        if (row) aRow = row;
      }, function() {
        aRow.type = 'memberalias';
        sClients.notify(iReq, aRow, that.oid);
      });
    });
  };

  Project.prototype.subscribe = {};
  Project.prototype.handle_subscribe = function(iReq) {
    var that = this;
    if (!that.stmt.subscribe) {
      that.stmt.subscribe = {
        hasPage: "SELECT 1 AS haspage FROM page LIMIT 1",
        pageList: "SELECT oid, CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM page",
        memberList: "SELECT alias, joined, left, uid, uid='"+sUUId+"' AS useralias FROM member",
        revisionList: "SELECT * FROM revision WHERE oid != ' ' ORDER BY date",
        getState: "SELECT state FROM clientstate WHERE client = ?",
        getProjectData: "SELECT CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM projects.project WHERE oid = '"+that.oid+"'"
      };
      that.db.prepareN(that.stmt.subscribe, function(err) {
        if (err) throw err;
        that.handle_subscribe(iReq);
      });
      return;
    }
    sClients.project(iReq.client, this.oid);
    that.stmt.subscribe.hasPage.stepOnce(function(err, row) {
      if (err) throw err;
      if (!row)
        that.handle_newPage(null, fResults);
      else
        fResults();
    });
    function fResults() {
      that.stmt.subscribe.pageList.results('data', function(errP, page) {
        that.stmt.subscribe.memberList.results(function(errM, member) {
          that.stmt.subscribe.revisionList.results('map', function(errR, revision) {
            if (errP || errM || errR) throw errP || errM || errR;
            var aResult = { service:that.service, page:page, member:member, revision:revision, state:null, data:null };
            that.stmt.subscribe.getState.bind(1, iReq.client);
            that.stmt.subscribe.getState.stepOnce(function(stepErr, row) {
              if (stepErr) throw stepErr;
              aResult.state = row ? JSON.parse(row.state) : null;
              that.stmt.subscribe.getProjectData.stepOnce(function(err, row) {
                if (err) throw err;
                aResult.data = JSON.parse(row.data);
                sClients.respond(iReq, aResult);
              });
            });
          });
        });
      });
    }
  };

  Project.prototype.write = { autogen:true, data:true };
  Project.prototype.handle_write = function(iReq) {
    var that = this;
    if (!that.stmt.updateData) {
      that.db.prepare("UPDATE projects.project SET dataw = ? WHERE oid = '"+that.oid+"'", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.updateData = stmt;
        that.handle_write(iReq);
      });
      return;
    }
    that.db.exec("BEGIN TRANSACTION", noOpCallback, function() {
      that.stmt.updateData.bind(1, JSON.stringify(iReq.data));
      that.stmt.updateData.stepOnce(function(stepErr, row) {
        if (stepErr) throw stepErr;
        that.revisionMap.touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.stepOnce(function(stepErr, row) {
          if (stepErr) throw stepErr;
          that.db.exec("COMMIT TRANSACTION", noOpCallback, function() {
            sClients.notify(iReq.client, {type:'projectdata', oid:that.oid, data:iReq.data});
            sClients.respond(iReq, {status:'ok'});
          });
        });
      });
    });
  };

  Project.prototype.kNewPageSql = "\
    BEGIN TRANSACTION;\
    "+kIncrOid+";\
    INSERT INTO page VALUES ( ("+kNewOid+"), NULL, '{\"name\":\"Untitled\", \"added\":\"' || datetime('now') || '\"}', NULL, '[]' );\
    SELECT oid, dataw AS data FROM page WHERE rowid = last_insert_rowid();";

  Project.prototype.newPage = { autogen:true };
  Project.prototype.handle_newPage = function(iReq, iCallback) {
    var aPage;
    var that = this;
    that.db.exec(this.kNewPageSql, function(stepErr, row) {
      if (stepErr) throw stepErr;
      if (row) aPage = row;
    }, function() {
      that.revisionMap.page[aPage.oid] = {op:'+', touch:(new Date).toISOString(), part:{}};
      that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
      that.stmt.setRevisionMap.stepOnce(function(stepErr, row) {
        if (stepErr) throw stepErr;
        that.db.exec("COMMIT TRANSACTION", function(err, row) {
          if (err) throw err;
        }, iCallback || function() {
          sClients.page(iReq.client, that.oid, aPage.oid);
          aPage.data = JSON.parse(aPage.data);
          aPage.type = 'page';
          sClients.notify(iReq, aPage, that.oid);
        });
      });
    });
  };

  Project.prototype.subscribePage = { page:true };
  Project.prototype.handle_subscribePage = function(iReq) {
    var that = this;
    if (!that.stmt.subscribePage) {
      that.db.prepare("SELECT oid, CASE WHEN dataw   IS NULL THEN data   ELSE dataw   END AS data,\
                                   CASE WHEN layoutw IS NULL THEN layout ELSE layoutw END AS layout FROM page WHERE oid = ?", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.subscribePage = stmt;
        that.handle_subscribePage(iReq);
      });
      return;
    }
    that.stmt.subscribePage.bind(1, iReq.page);
    that.stmt.subscribePage.stepOnce(function(stepErr, row) {
      if (stepErr) throw stepErr;
      sClients.page(iReq.client, that.oid, iReq.page);
      row.layout = JSON.parse(row.layout);
      row.data = JSON.parse(row.data);
      sClients.respond(iReq, row, 'sequence');
      that._sendParts(row.layout, 0, iReq);
    });
  };

  Project.prototype.writePage = { autogen:true, page:true, data:true };
  Project.prototype.handle_writePage = function(iReq) {
    var that = this;
    if (!that.stmt.writePage) {
      that.db.prepare("UPDATE page SET dataw = CASE WHEN ?1 IS NULL THEN dataw ELSE ?1 END,\
                                     layoutw = CASE WHEN ?2 IS NULL THEN layoutw ELSE ?2 END WHERE oid = ?", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.writePage = stmt;
        that.handle_writePage(iReq);
      });
      return;
    }
    that.db.exec("BEGIN TRANSACTION", noOpCallback, function() {
      that.stmt.writePage.bind(1, JSON.stringify(iReq.data.data));
      that.stmt.writePage.bind(2, JSON.stringify(iReq.data.layout));
      that.stmt.writePage.bind(3, iReq.page);
      that.stmt.writePage.stepOnce(function(stepErr, row) {
        if (stepErr) throw stepErr;
        if (!that.revisionMap.page[iReq.page])
          that.revisionMap.page[iReq.page] = {op:'!', touch:null, part:{}};
        else if (that.revisionMap.page[iReq.page].op === '.')
          that.revisionMap.page[iReq.page].op = '!';
        that.revisionMap.page[iReq.page].touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.stepOnce(function(stepErr, row) {
          if (stepErr) throw stepErr;
          that.db.exec("COMMIT TRANSACTION", noOpCallback, function() {
            iReq.data.type = 'pagelayout';
            sClients.notify(iReq.client, iReq.data, that.oid, !iReq.data.data && iReq.page);
            sClients.respond(iReq, {status:'ok'});
          });
        });
      });
    });
  };

  Project.prototype.readPageRevision = { page:true, revision:true };
  Project.prototype.handle_readPageRevision = function(iReq, _state) {
    var that = this;
    if (!that.stmt.readPageRevision) {
      that.stmt.readPageRevision = {
        getPage: "SELECT data, layout FROM page WHERE oid = ?",
        pageRevision: "SELECT oid, map, sideline, author, parents FROM revision WHERE oid != ' ' ORDER BY ROWID DESC",
        getDiff: "SELECT data FROM diff WHERE revision = ? AND object = ?"
      };
      that.db.prepareN(that.stmt.readPageRevision, function(err) {
        if (err) throw err;
        that.handle_readPageRevision(iReq);
      });
      return;
    }
    var aCachedPg = sRevisionCache+iReq.revision+'_'+iReq.page;
    if (!_state) {
      fs.stat(aCachedPg, function(err, stats) {
        if (err && err.errno !== process.ENOENT) throw err;
        if (!err) {
          fs.readFile(aCachedPg, 'utf8', function(fileErr, data) {
            if (fileErr) throw fileErr;
            var aPg = JSON.parse(data);
            sClients.respond(iReq, aPg, 'sequence');
            that._sendParts(aPg.layout, 0, iReq);
          });
          return;
        }
        that.stmt.readPageRevision.getPage.bind(1, iReq.page);
        that.stmt.readPageRevision.getPage.stepOnce(function(err, row) {
          if (err) throw err;
          that.handle_readPageRevision(iReq, { data:JSON.parse(row.data), layout:JSON.parse(row.layout), revparts:{} });
        });
      });
      return;
    }
    if (_state.sidelined) {
      for (var any in _state.parents) break;
      if (!any) {
        fNext();
        function fNext() {
          if (_state.sidelined.length)
            fPatch('sideline', _state.sidelined.pop(), fNext);
          else
            fCompleteCache(0);
        }
        return;
      }
    }
    that.stmt.readPageRevision.pageRevision.step(function(err, row) {
      if (err) throw err;
      if (row.oid === iReq.revision) {
        if (row.sideline) {
          _state.sidelined = [ row ];
          _state.parents = JSON.parse(row.parents);
          _state.ancestors = JSON.parse(row.parents);
          that.handle_readPageRevision(iReq, _state);
        } else {
          fCompleteCache(0);
        }
        return;
      }
      if (_state.sidelined) {
        row.parents = JSON.parse(row.parents);
        var aOidCount = +row.oid.slice(row.oid.indexOf('.')+1);
        if (aOidCount === _state.ancestors[row.author]) {
          _state.ancestors[row.author] = row.parents[row.author];
          if (row.sideline)
            _state.sidelined.push(row);
          if (aOidCount === _state.parents[row.author])
            delete _state.parents[row.author];
          that.handle_readPageRevision(iReq, _state);
          return;
        }
        if (!(row.author in row.parents))
          delete _state.parents[row.author];
      }
      if (row.sideline) {
        that.handle_readPageRevision(iReq, _state);
        return;
      }
      fPatch(null, row, function() {
        that.handle_readPageRevision(iReq, _state);
      });
    });

    function fPatch(isSideline, row, callback) {
      var aMap = JSON.parse(row.map);
      if (!(iReq.page in aMap.page))
        return callback();
      that.stmt.readPageRevision.getDiff.bind(1, row.oid);
      if (aMap.page[iReq.page].op !== '.') {
        that.stmt.readPageRevision.getDiff.bind(2, iReq.page);
        that.stmt.readPageRevision.getDiff.stepOnce(function(err, diff) {
          if (err) throw err;
          that[isSideline ? 'patch' : 'unpatch'](_state, JSON.parse(diff.data));
          fPtFn();
        });
      } else {
        fPtFn();
      }
      function fPtFn() {
        for (var aPt in aMap.page[iReq.page].part) {
          _state.revparts[aPt] = true;
          var aNewPart = aMap.page[iReq.page].part[aPt].op === '+';
          delete aMap.page[iReq.page].part[aPt];
          that.stmt.readPageRevision.getDiff.bind(2, aPt);
          that.stmt.readPageRevision.getDiff.stepOnce(function(err, row) {
            if (err) throw err;
            var aRevCopy = sRevisionCache+iReq.revision+'_'+aPt;
            if (!row.data) {
              fs.unlink(aRevCopy, function(err) {
                if (err && err.errno !== process.ENOENT) throw err;
                fPtFn();
              });
              return;
            }
            fs.stat(aRevCopy, function(statErr, stats) {
              var aSrc = !statErr ? aRevCopy : isSideline && aNewPart ? null : getPath(aPt);
              xd.patch(aSrc, row.data, aRevCopy+'.temp', function(err) {
                if (err) throw err;
                fs.rename(aRevCopy+'.temp', aRevCopy, function(err) {
                  if (err) throw err;
                  fPtFn();
                });
              });
            });
          });
          return;
        }
        callback();
      }
    }

    function fCompleteCache(idx) {
      for (; idx < _state.layout.length && (!_state.layout[idx].oid || _state.revparts[_state.layout[idx].oid]); ++idx)
        if (_state.layout[idx].oid)
          _state.layout[idx].oid = iReq.revision+'_'+_state.layout[idx].oid;
      if (idx < _state.layout.length) {
        var aOrig = getPath(_state.layout[idx].oid);
        _state.layout[idx].oid = iReq.revision+'_'+_state.layout[idx].oid;
        dupFile(aOrig, sRevisionCache+_state.layout[idx].oid, function(err) {
          if (err && err.errno !== process.ENOENT) throw err;
          fCompleteCache(++idx);
        });
        return;
      }
      that.stmt.readPageRevision.pageRevision.reset();
      var aResponse = { oid:iReq.page, revision:iReq.revision, data:_state.data, layout:_state.layout };
      fs.writeFile(aCachedPg, JSON.stringify(aResponse), 'utf8', function(fileErr) {
        if (fileErr) throw fileErr;
        sClients.respond(iReq, aResponse, 'sequence');
        that._sendParts(_state.layout, 0, iReq);
      });
    }
  };

  Project.prototype.unpatch = function(ioOrig, iDiff) {
    this.patch(ioOrig, iDiff, true);
  };

  Project.prototype.patch = function(ioOrig, iDiff, _undo) {
    var aAdd = iDiff[_undo ? 'del' : 'add'];
    var aDel = iDiff[_undo ? 'add' : 'del'];
    if (aAdd.data)
      ioOrig.data = aAdd.data; // project & page
    if (aAdd.layout) {      // page
      for (var a=0; a < aDel.layout.length; ++a) {
        for (var aI=0; ioOrig.layout[aI].pid !== aDel.layout[a].pid; ++aI) {}
        ioOrig.layout.splice(aI, 1);
      }
      for (var a=0; a < aAdd.layout.length; ++a)
        ioOrig.layout.push(aAdd.layout[a]);
    }
  };

  Project.prototype.kNewPartSql = "\
    BEGIN TRANSACTION;\
    "+kIncrOid+"; "+kNewOid+";\
    "+kIncrOid+"; "+kNewOid+";\
    COMMIT TRANSACTION;";

  Project.prototype.newPart = { autogen:true };
  Project.prototype.handle_newPart = function(iReq) {
    var that = this;
    var aNewOid = {};
    this.db.exec(this.kNewPartSql, function(stepErr, row) {
      if (stepErr) throw stepErr;
      if (row)
        if (aNewOid.a)
          aNewOid.b = row.oid;
        else
          aNewOid.a = row.oid;
    }, function() {
        //. log oids to verify writePart
        sClients.respond(iReq, aNewOid);
    });
  };

  Project.prototype._sendParts = function(iList, iIdx, iReq) {
    while (iIdx < iList.length && (!iList[iIdx].oid || iList[iIdx].outofband))
      ++iIdx;
    if (iIdx >= iList.length) {
      Queue.process(iReq.project);
      return;
    }
    var that = this;
    var aPath = iList[iIdx].oid.indexOf('_') >= 0 ? sRevisionCache+iList[iIdx].oid : getPath(iList[iIdx].oid);
    fs.stat(aPath+'.w', function(statErr, stats) {
      fs.readFile(statErr ? aPath : aPath+'.w', 'utf8', function(fileErr, buffer) {
        if (!fileErr)
          sClients.respond(iReq, {type:'update', id:iReq.id+'+', list:[{type:'part', oid:iList[iIdx].oid, data:buffer}]}, 'sequence');
        that._sendParts(iList, ++iIdx, iReq);
      });
    });
  };

  Project.prototype.writePart = { autogen:true, page:true, part:true, data:true };
  Project.prototype.handle_writePart = function(iReq) {
    var that = this;
    var aPath = makePath(iReq.part);
    if (iReq.data)
      fs.writeFile(aPath+'.w', iReq.data, 'utf8', function(fileErr) {
        if (fileErr) throw fileErr;
        fMap();
      });
    else
      fMap();
    function fMap() {
      fs.stat(aPath, function(statErr, stats) {
        if (!that.revisionMap.page[iReq.page])
          that.revisionMap.page[iReq.page] = {op:'.', touch:null, part:{}};
        if (!that.revisionMap.page[iReq.page].part[iReq.part])
          that.revisionMap.page[iReq.page].part[iReq.part] = {op:statErr ? '+' : '!', touch:null};
        that.revisionMap.page[iReq.page].part[iReq.part].touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.stepOnce(function(stepErr, row) {
          if (stepErr) throw stepErr;
          sClients.notify(iReq.client, {type:'part', oid:iReq.part, data:Buffer.isBuffer(iReq.data) ? null : iReq.data}, that.oid, iReq.page);
          sClients.respond(iReq, {status:'ok'});
        });
      });
    }
  };

  Project.prototype._makeDiffs = function(iRev, iBufList, iDiffList, iCallback) {
    var that = this;
    if (!that.stmt.makeDiffs) {
      that.stmt.makeDiffs = {
        insertDiff: "INSERT INTO diff VALUES ( ?, ?, ? )",
        getPageData: "SELECT data, dataw, layout, layoutw FROM page WHERE oid = ?",
        resetPageData: "UPDATE page SET\
                        data   = CASE WHEN dataw   IS NULL THEN data   ELSE dataw   END, dataw   = NULL,\
                        layout = CASE WHEN layoutw IS NULL THEN layout ELSE layoutw END, layoutw = NULL\
                        WHERE oid = ?"
      };
      that.db.prepareN(that.stmt.makeDiffs, function(err) {
        if (err) throw err;
        that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
      });
      return;
    }
    if (iBufList && !iCallback.count) {
      var aCb = iCallback;
      iCallback = function() { if (--iCallback.count === 0) aCb(); };
      iCallback.count = 1;
    }
    for (var aPg in that.revisionMap.page) {
      if (that.revisionMap.page[aPg].done)
        continue;
      for (var aPt in that.revisionMap.page[aPg].part) {
        if (that.revisionMap.page[aPg].part[aPt].done)
          continue;
        that.revisionMap.page[aPg].part[aPt].done = true;
        var aPath = getPath(aPt);
        fs.stat(aPath, function(statErr, stats) {
          if (iBufList) {
            ++iCallback.count;
            xd.diff(!statErr && aPath, aPath+'.w', function(err, diff) {
              if (err) throw err;
              iBufList.push(diff);
              iDiffList.push({oid:aPt, size:diff.length, type:'part'});
              iCallback();
            });
          }
          if (statErr)
            return fInsert(null);
          xd.diff(aPath+'.w', aPath, function(err, diff) {
            if (err) throw err;
            fInsert(diff);
          });
        });
        function fInsert(diff) {
          that.stmt.makeDiffs.insertDiff.bind(1, aPt);
          that.stmt.makeDiffs.insertDiff.bind(2, iRev);
          that.stmt.makeDiffs.insertDiff.bind(3, diff);
          that.stmt.makeDiffs.insertDiff.stepOnce(function(err, row) {
            if (err) throw err;
            that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
          });
        }
        return;
      }
      that.revisionMap.page[aPg].done = true;
      if (that.revisionMap.page[aPg].op !== '.') {
        that.stmt.makeDiffs.getPageData.bind(1, aPg);
        that.stmt.makeDiffs.getPageData.stepOnce(function(err, row) {
          if (err) throw err;
          var aOrig = { data:JSON.parse(row.data ||'{}'), layout:JSON.parse(row.layout ||'[]') };
          var aWork = { data:JSON.parse(row.dataw||'{}'), layout:JSON.parse(row.layoutw||'[]') };
          if (areEqual(aOrig.data, aWork.data)) {
            delete aOrig.data;
            delete aWork.data;
          }
          for (var a=aWork.layout.length-1; a >= 0; --a) {
            for (var aPt=0; aPt < aOrig.layout.length && aOrig.layout[aPt].pid !== aWork.layout[a].pid; ++aPt) {}
            if (aPt < aOrig.layout.length && areEqual(aOrig.layout[aPt], aWork.layout[a])) {
              aOrig.layout.splice(aPt, 1);
              aWork.layout.splice(a, 1);
            }
          }
          var aDiff = JSON.stringify({add:aWork, del:aOrig});
          if (iBufList) {
            iBufList.push(aDiff);
            iDiffList.push({oid:aPg, size:aDiff.length, type:'page'});
          }
          that.stmt.makeDiffs.insertDiff.bind(1, aPg);
          that.stmt.makeDiffs.insertDiff.bind(2, iRev);
          that.stmt.makeDiffs.insertDiff.bind(3, aDiff);
          that.stmt.makeDiffs.insertDiff.stepOnce(function(err, row) {
            if (err) throw err;
            that.stmt.makeDiffs.resetPageData.bind(1, aPg);
            that.stmt.makeDiffs.resetPageData.stepOnce(function(err, row) {
              if (err) throw err;
              that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
            });
          });
        });
        return;
      }
    }
    if (that.revisionMap.touch) {
      var aDiff;
      that.db.exec("SELECT data, dataw FROM projects.project WHERE oid = '"+that.oid+"'", function(err, row) {
        if (err) throw err;
        if (row) aDiff = JSON.stringify({add:JSON.parse(row.dataw), del:JSON.parse(row.data||'{}')});
      }, function () {
        if (iBufList) {
          iBufList.push(aDiff);
          iDiffList.push({oid:that.oid, size:aDiff.length, type:'proj'});
        }
        that.stmt.makeDiffs.insertDiff.bind(1, that.oid);
        that.stmt.makeDiffs.insertDiff.bind(2, iRev);
        that.stmt.makeDiffs.insertDiff.bind(3, aDiff);
        that.stmt.makeDiffs.insertDiff.stepOnce(function(err, row) {
          if (err) throw err;
          that.db.exec("UPDATE projects.project SET data = dataw, dataw = NULL WHERE oid = '"+that.oid+"'", noOpCallback, iCallback);
        });
      });
    } else {
      iCallback();
    }
  };

  Project.prototype.revisionMapInit = function() {
    return {touch:null, page:{}};
  };
  Project.prototype.revisionMapJson = function(iNoTouch) {
    return JSON.stringify({touch:iNoTouch ? null : (new Date).toISOString(), page:{}});
  };

  Project.prototype.commitRevision = { autogen:true };
  Project.prototype.handle_commitRevision = function(iReq, iNoSendCallback) {
    if (!this.revisionMap.touch) {
      for (var any in this.revisionMap.page) break;
      if (!any)
        return sClients.respond(iReq, {status:'ok'});
    }
    var aSql = "\
      SAVEPOINT commit_revision;\
      "+kIncrOid+";\
      INSERT INTO revision VALUES (\
        "+(iNoSendCallback ? '' : "'!'||")+"("+kNewOid+"), '"+sUUId+"', '"+(new Date).toISOString()+"',\
        (SELECT map FROM revision WHERE oid = ' '),\
        (SELECT parents FROM revision WHERE oid = ' '), NULL );\
      SELECT * FROM revision WHERE rowid = last_insert_rowid();";
    var that = this;
    var aRev;
    that.db.exec(aSql, function(err, row) {
      if (err) throw err;
      if (row) {
        aRev = row;
        aRev.map = JSON.parse(aRev.map);
        aRev.parents = JSON.parse(aRev.parents);
        if (!iNoSendCallback) {
          aRev.oid = aRev.oid.slice(1);
          that.parentMap[sUUId] = +aRev.oid.slice(aRev.oid.indexOf('.')+1);
        }
      }
    }, function () {
      var aBufList = !iNoSendCallback && [];
      aRev.list = !iNoSendCallback && [];
      that._makeDiffs(aRev.oid, aBufList, aRev.list, function() {
        aRev.type = 'revision';
        if (iNoSendCallback)
          return fCommit();
        var aRevData = 0;
        for (var a=0; a < aRev.list.length; ++a)
          aRevData += aRev.list[a].size;
        aRevData = new Buffer(aRevData);
        for (var aOff=0, a=0; a < aBufList.length; aOff += aBufList[a++].length) {
          if (aBufList[a] instanceof Buffer)
            aBufList[a].copy(aRevData, aOff, 0);
          else
            aRevData.write(aBufList[a], aOff);
        }
        aRev.project = that.oid;
        storeFile(sSendDir+aRev.oid, MqClient.packMsg(aRev, aRevData), function(err) {
          if (err) throw err;
          fCommit(aRevData);
        });
      });
    });
    function fCommit(revdata) {
      that.db.exec("UPDATE revision SET map = NULL, parents = '"+JSON.stringify(that.parentMap)+"' WHERE oid = ' ';\
                    RELEASE commit_revision;", noOpCallback, function () {
        if (iNoSendCallback)
          return iNoSendCallback(aRev);
        that._finishRevision(that.db, that.revisionMap, revdata && aRev, revdata, function() {
          that.revisionMap = that.revisionMapInit();
          delete aRev.list;
          sClients.notify(iReq, aRev, that.oid);
        });
      });
    }
  };

  Project.prototype._finishRevision = function(iDb, iMap, iRev, iRevData, iCallback, _done) {
    var that = this;
    if (!_done)
      _done = { pg:{}, pt:{} };
    for (var aPg in iMap.page) {
      if (_done.pg[aPg])
        continue;
      for (var aPt in iMap.page[aPg].part) {
        if (_done.pt[aPt])
          continue;
        var aPath = getPath(aPt);
        if (sAttachments.isOpen(aPt)) {
          if (iMap.page.sideline) {
            sAttachments.invalidate(aPt, function() {
              that._finishRevision(iDb, iMap, iRev, iRevData, iCallback, _done);
            });
            return;
          }
          dupFile(aPath+'.w', aPath, function(err) {
            if (err) throw err;
            that._finishRevision(iDb, iMap, iRev, iRevData, iCallback, _done);
          });
        } else {
          var aCbCount = 1;
          if (iMap.page.sideline) {
            fs.unlink(aPath+'.w', fCallback);
            ++aCbCount;
          }
          fs.rename(aPath+(iMap.page.sideline ? '.new' : '.w'), aPath, fCallback);
          function fCallback(err) {
            if (err && err.errno !== process.ENOENT) throw err;
            if (--aCbCount === 0)
              syncFile(getParent(aPath), function(err) {
                if (err) throw err;
                that._finishRevision(iDb, iMap, iRev, iRevData, iCallback, _done);
              });
          }
        }
        _done.pt[aPt] = true;
        return;
      }
      _done.pg[aPg] = true;
      _done.pt = {};
    }
    if (iRev)
      that.hasMembers(function(any) {
        var aTo = {};
        if (any)
          aTo[that.oid] = 2;
        sServices.post(that.service || 'localhost', aTo, iRev, iRevData, function() { //. use default service name
          fs.unlink(sSendDir+iRev.oid, noOpCallback);
          fUpdate();
        });
      });
    else
      fUpdate();
    function fUpdate() {
      if (iMap.page.sideline) {
        delete iMap.page.sideline;
        var aSetMap = ", map = '"+JSON.stringify(iMap)+"'";
      }
      iDb.exec("UPDATE revision SET oid = substr(oid, 2)"+(aSetMap||'')+" WHERE oid LIKE '!%'", noOpCallback, iCallback);
    }
  };


var sClients = {
  cl: {}
};

  sClients.drop = function(iClient, iProj, iPage) { // invoked by client
    delete (iPage ? this.cl[iClient].project[iProj][iPage] : this.cl[iClient].project[iProj]);
  };

  sClients.client = function(iClient, iConnection) {
    if (iConnection)
      this.cl[iClient] = { connection:iConnection, project:{} };
    else
      delete this.cl[iClient];
  };

  sClients.project = function(iClient, iProj) {
    if (!iClient) // playback
      return;
    if (!this.cl[iClient].project[iProj])
      this.cl[iClient].project[iProj] = {};
    this.cl[iClient].project[iProj].current = true;
  };

  sClients.page = function(iClient, iProj, iPage) {
    if (!iClient) // playback
      return;
    if (!this.cl[iClient].project[iProj][iPage])
      this.cl[iClient].project[iProj][iPage] = {};
    this.cl[iClient].project[iProj][iPage].current = true;
  };

  sClients.notify = function(iReqOrSkip, iData, iProj, iPage) {
    var aMsg = { type:'update', project: (!iProj || iProj.charAt(0) === '#' ? undefined : iProj), list: (iData instanceof Array ? iData : [iData]) };
    var aC = iReqOrSkip && iReqOrSkip.type ? iReqOrSkip.client : iReqOrSkip;
    for (var a in this.cl) {
      if (!iProj || this.cl[a].project[iProj] && (!iPage || this.cl[a].project[iProj][iPage])) {
        if (aC === a)
          if (iReqOrSkip.client)
            aMsg.id = iReqOrSkip.id;
          else
            continue;
        this.cl[a].connection.send(JSON.stringify(aMsg));
        delete aMsg.id;
      }
    }
    if (iReqOrSkip && iReqOrSkip.type) {
      if (iReqOrSkip.callback)
        iReqOrSkip.callback();
      Queue.process(iReqOrSkip.project);
    }
  };

  sClients.respond = function(iReq, iData, iNoContinue) {//. avoid overlap in iData members and response members
    if (iReq.response) {
      iReq.response.writeHead(200, { 'Content-Length':(iData.error || iData.status || '').length });
      iReq.response.end(iData.error || iData.status);
    } else if (iReq.client) {
      if (!iData.id)
        iData.id = iReq.id;
      if (!iData.type)
        iData.type = iReq.type;
      if (iReq.project)
        iData.project = iReq.project;
      if (this.cl[iReq.client])
        this.cl[iReq.client].connection.send(JSON.stringify(iData));
    } else if (iReq.callback) {
      if (iData.error)
        throw new Error(iData.error);
      iReq.callback();
    }
    if (!iNoContinue)
      Queue.process(iReq.project);
  };

// start the app!
main(process.argv);


/* cache mgmt
    client init - server clear cached list and send projects
    client resume - server send any objects marked changed in cached list unless reset
    server reset - client clear cache and init
    client unload - server clear object
*/

