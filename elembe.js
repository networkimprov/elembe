require.paths.unshift('/usr/lib/nodelib');

var sys = require('sys');
var fs = require('fs');
var http = require('http');
var url = require('url');
var child = require('child_process');
var Buffer = require('buffer').Buffer;

var sqlite = require('sqlite');
var io = require('socket.io');
var uuid = require('uuidjs');
var gm = require('gm');
var inotify = require('inotify');
var MqClient = require('mqclient');

var schema = {
  instance: {
    instance: {
      uuid: 'text',
      rowid: 'integer primary key autoincrement, check (uuid IS NULL OR rowid = 1)'
    }
  },
  services: {
    service: {
      host: 'text unique', // domain name
      password: 'text',
      joined: 'text',
      aliases: 'text', // json [ string, ... ]
      comment: 'text',
      newreg: 'integer'
    }
  },
  projects: {
    project: {
      oid: 'text unique',
      service: 'text',
      data: 'text',  // json { name, blurb, created }
      dataw: 'text',
      localData: 'text' // json { lastViewed:datetime } 
    },
    invite: {
      date: 'text',   // iso/utc time
      toAlias: 'text',
      fromAlias: 'text',
      oid: 'text unique',
      service: 'text',
      data: 'text',  // json
      accept: 'text' // iso/utc time
    }
  },
  clients: {
    clientnav: {
      client: 'text unique',    // mac addr
      data: 'text'   // json { ... }
    }
  },
  partmap: {
    partmap: {
      part: 'text',      // oid of object in external file
      page: 'text',      // oid of page in project
      project: 'text'    // oid of project
    }
  }
};

var kIncrOid = "INSERT INTO instance.instance (uuid) VALUES (NULL);\
                DELETE FROM instance.instance WHERE rowid = last_insert_rowid()";
var kNewOid = "SELECT uuid || '.' || last_insert_rowid() AS oid FROM instance.instance";

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

function dbPrepare(iDb, ioSet, iCallback, iAsync) {
  for (var a in ioSet) {
    if (typeof ioSet[a] !== 'string')
      continue;
    iDb.prepare(ioSet[a], function(err, stmt) {
      if (err) return iCallback(err);
      ioSet[a] = stmt;
      dbPrepare(iDb, ioSet, iCallback, 1);
    });
    return;
  }
  if (!iAsync)
    process.nextTick(iCallback);
  else
    iCallback();
}

function dbFinalize(ioSet) {
  for (var a in ioSet) {
    if (typeof ioSet[a].finalize === 'function')
      ioSet[a].finalize();
    else
      dbFinalize(ioSet[a]);
    delete ioSet[a];
  }
}

function dbExec(db, iSql, iRowCallback, iDoneCallback) {
  db.prepare(iSql, function(prepErr, stmt) {
    if (prepErr)
      throw prepErr;
    var stepCall = function(stepErr, row) {
      iRowCallback(stepErr, row);
      if (stepErr) return;
      if (row)
        stmt.step(stepCall);
      else {
        stmt.finalize();
        if (stmt.tail)
          dbExec(db, stmt.tail, iRowCallback, iDoneCallback);
        else if (iDoneCallback)
          iDoneCallback();
      }
    };
    stmt.step(stepCall);
  });
}

function dbResults(iStmt, iOptionalParseColumns, iCallback) {
  var aList = [];
  var iArgs = arguments;
  var iDoneCallback = iArgs[iArgs.length-1];
  var aStepCall = function(err, row) {
    if (err) throw err;
    if (row) {
      for (var a=1; a < iArgs.length-1; ++a)
        row[iArgs[a]] = JSON.parse(row[iArgs[a]]);
      aList.push(row);
      iStmt.step(aStepCall);
    } else {
      iStmt.reset();
      iDoneCallback(aList);
    }
  };
  iStmt.step(aStepCall);
}

function createSchema(iSchema, iFile) {
  var aSql = '';
  for (var aDb in iSchema)
    aSql += "ATTACH '"+(aDb === 'filename' ? iFile : sMainDir+aDb)+"' AS "+aDb+";\n";
  aSql += "BEGIN TRANSACTION;\n";
  for (var aDb in iSchema) {
    for (var aTb in iSchema[aDb]) {
      aSql += "CREATE TABLE IF NOT EXISTS "+aDb+"."+aTb+" (";
      var aComma = false;
      for (var aCl in iSchema[aDb][aTb]) {
        aSql += (aComma ? ',' : '') + aCl +' '+ iSchema[aDb][aTb][aCl];
        aComma = true;
      }
      aSql += ");\n";
    }
  }
  aSql += "COMMIT TRANSACTION;\n";
  return aSql;
}

function makePath(iOid, iSkipMkdir) {
  var aDir = sMainDir + iOid.slice(0, iOid.indexOf('.'));
  if (!iSkipMkdir) {
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
  fs.open(iPath, 'w', 0600, function(err, fd) {
    if (err) return iCallback(err);
    aWrite(iBuf);
    function aWrite(buf) {
      fs.write(fd, buf, 0, buf.length, null, function(err, written) {
        if (err) { fs.close(fd); return iCallback(err); }
        if (written < buf.length)
          return aWrite(buf.slice(written));
        fs.fsync(fd, function(err) {
          fs.close(fd);
          if (err) return iCallback(err);
          syncFile(getParent(iPath), iCallback);
        });
      });
    }
  });
}

function syncFile(iPath, iCallback) {
  fs.open(iPath, 'r', function(err, fd) {
    if (err) return iCallback(err);
    fs.fsync(fd, function(err) {
      fs.close(fd);
      iCallback(err);
    });
  });
}

function xdDiff(iSrc, iDest, iCallback) {
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

function xdPatch(iSrc, iDiff, iDest, iCallback) {
  var aC = child.spawn('xdelta3', iSrc ? ['-d', '-c', '-s', iSrc] : ['-d', '-c']);
  var aErr = 'unknown error';
  aC.stderr.on('data', function(data) { aErr = data.toString() });
  sys.pump(aC.stdout, fs.createWriteStream(iDest), noOpCallback);
  aC.on('exit', function(code) {
    iCallback(code ? new Error('xdPatch failed: '+aErr) : undefined);
  });
  aC.stdin.end(iDiff);
}

function Queue() {
  this.list = {};
  this.firstI = 0;
  this.nextI = 1;
}

Queue.prototype = {
  curr: function() {
    return this.firstI < this.nextI ? this.list[this.firstI] : null;
  } ,

  next: function() {
    if (++this.firstI === this.nextI)
       this.firstI = this.nextI = 0;
  } ,

  post: function(iReq) {
    var aRet = this.firstI === this.nextI;
    this.list[this.nextI++] = iReq;
    return aRet;
  }
}; // Queue

var sMainDir = 'sqltest/';
var sRevisionCache = sMainDir+'#revisioncache/';
var sEditCache = sMainDir+'#editcache/';
var sSendDir = sMainDir+'#outbound/';
var sInbound = sMainDir+'#inbound/';
var sUUId;

var Inotify = inotify.Inotify;

function main() {
  var aAutogen = process.argv.length === 3 && process.argv[2] === 'autogen';
  aUuid = aAutogen ? '#autogen' : uuid.generate();

  if (aAutogen) {
    var aMask = process.umask(0000);
    try {
    fs.mkdirSync(sMainDir, 0711);
    } catch (err) {
      if (err.errno !== process.EEXIST) throw err;
      throw new Error("can't autogen over existing data");
    }
    fs.mkdirSync(sRevisionCache, 0777);
    fs.mkdirSync(sEditCache, 0777);
    fs.mkdirSync(sSendDir, 0711);
    fs.mkdirSync(sInbound, 0777);
    process.umask(aMask);
  } else {
    sAttachments.init();
  }

  var aDb = new sqlite.Database();
  aDb.open(sMainDir+'instance', function (openErr) {
    if (openErr) throw openErr;
    var aSchemaSql = createSchema(schema);
    if (!aAutogen)
      aSchemaSql += "INSERT OR IGNORE INTO instance (uuid) VALUES ('"+aUuid+"'); SELECT uuid FROM instance;";
    dbExec(aDb, aSchemaSql, function(err, row) {
      if (err) throw err;
      if (row) sUUId = row.uuid;
    }, function() {
      aDb.close();
      sProjects.init(function() {
        if (aAutogen) {
          sProjects.autogen(require('./autogen'), function() {
            console.log('autogen complete');
            sProjects.finalize();
          });
          return;
        }
        sServices.start();
        aServer = http.createServer(httpRequest);
        aServer.listen(8000);
        var aSocket = io.listen(aServer);
        aSocket.on('connection', function(conn) {
          var aClientId = conn.request.headers.cookie.slice(conn.request.headers.cookie.indexOf('=')+1);
          sClientCache.client(aClientId, conn);
          var aOn = true;
          conn.on('message', function(msg) {
            if (!aOn) {
              console.log('message received on closed connection');
              return;
            }
            var aReq = JSON.parse(msg);
            if (aReq.constructor === Array)
              aReq = JSON.parse(aReq[0]);
            aReq.connection = conn;
            aReq.client = aClientId;
            sProjects.queueRequest(aReq);
          });
          conn.on('disconnect', function() {
            aOn = false;
            sAttachments.close(aClientId);
            sClientCache.client(aClientId, null);
          });
        });
      });
    });
  });
}

var sFileMap = {
  '/':'client/_suae_.html',
  '/socket-io.js':'socket.io/socket.io.js',
  '/test':'dbtest.html',
  '/part':''
};
var sTypeMap = { js:'text/javascript', css:'text/css', html:'text/html' };

function httpRequest(req, res) {
  var aUrl = url.parse(req.url, true), aFile = sFileMap[aUrl.pathname];
  if (aFile === '') {
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
        sProjects.queueRequest({type:'writePart', client:null, project:aUrl.query.project, page:aUrl.query.page, part:aUrl.query.oid, data:aBuf, response:res});
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
            fs.readFile(aFile, function(err, data) {
              if (err) throw err;
              res.writeHead(200, {'Content-Type':'image/'+type, 'Cache-Control':'no-store, no-cache'});
              res.end(data);
            });
          });
        });
      });
    }
  } else {
    if (!aFile)
      aFile = 'client'+aUrl.pathname;
    fs.readFile(aFile, 'utf8', function(err, data) {
      if (err) {
        if (err.errno !== process.ENOENT) throw err;
        res.writeHead(404, {'Content-Type':'text/plain'});
        res.end('Invalid Resource');
        return;
      }
      var aHeaders = { 'Content-Type': sTypeMap[aFile.slice(aFile.lastIndexOf('.')+1)] };
      if (!req.headers.cookie || req.headers.cookie.indexOf('anvlclient=') < 0)
        aHeaders['Set-Cookie'] = 'anvlclient='+uuid.generate()+'; expires=31-Oct-3333 01:01:01 GMT; path=/';
      res.writeHead(200, aHeaders);
      res.end(data, 'utf8');
    });
  }
}

var MqClient = require('mqclient');

var sServices = {
  db: null,
  s: {},

  start: function() {
    var that = this;
    that.db = new sqlite.Database();
    that.db.open(sMainDir+'services', function(openErr) {
      if (openErr) throw openErr;
      dbExec(that.db, "SELECT * FROM service", function(err, row) {
        if (err) throw err;
        if (row)
          that._create(row, function(svc) {
            that._connect(svc.host);
            sClientCache.notify(null, {type:'services', list:that.list(svc.host)});
          });
      }, noOpCallback);
    });
  } ,

  end: function() {
    //. queue disconnect if conn in use
    for (var a in this.s) {
      if (this.s[a].status !== 'offline' && this.s[a].status !== '?') {
        this.s[a].status = 'signing off';
        sClientCache.notify(null, {type:'services', list:this.list(a)});
        this.s[a].conn.close();
      }
    }
  } ,

  _create: function(iRow, iCallback) {
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
    iRow.conn.on('registered', function(aliases) {
      if (aliases !== undefined)
        iRow.aliases = aliases;
      var aJoined = '';
      if (iRow.joined === 'no') {
        iRow.joined = (new Date).toISOString();
        aJoined = ",joined='"+iRow.joined+"'";
        iRow.conn.login(sUUId, iRow.password);
      }
      iRow.newreg = 0;
      dbExec(sServices.db, "UPDATE service SET newreg=0, aliases='"+iRow.aliases+"'"+aJoined+" WHERE host='"+iRow.host+"'", noOpCallback, function() {
        sClientCache.notify(null, {type:'services', list:sServices.list(iRow.host)});
      });
    });
    iRow.conn.on('info', function(msg) {
      if (msg === 'ok login') {
        iRow.status = 'online';
        sClientCache.notify(null, {type:'services', list:sServices.list(iRow.host)});
        if (iRow.newreg)
          iRow.conn.register(sUUId, '', iRow.aliases);
        sServices._sendNext(iRow.host);
      } else if (/^reg fail/.test(msg)) {
        iRow.conn.login(sUUId, iRow.password);
      }
    });
    iRow.conn.on('quit', function(msg) {
      if (iRow.timer)
        clearTimeout(iRow.timer);
      iRow.status = 'quit: '+msg;
      sClientCache.notify(null, {type:'services', list:sServices.list(iRow.host)});
      console.log('service quit: '+iRow.host+' '+msg);
    });
    iRow.conn.on('deliver', function(id, from, msg, etc) {
      var aData = typeof msg === 'undefined' ? null : msg;
      var aReq = {type:etc.project ? 'projectImport' : 'importt', client:null, project:etc.project, from:from, jso:etc, data:aData, callback:function() { iRow.conn.ack(id, 'ok') } };
      sProjects.queueRequest(aReq);
    });
    iRow.conn.on('ack', function(id, type) {
      if (!iRow.queue.length || id !== iRow.queue[0])
        return;
      if (iRow.timer)
        clearTimeout(iRow.timer);
      var aCallbacks = 1;
      if (iRow.msgHead.etc && iRow.msgHead.etc.type === 'invite') {
        if (type !== 'ok') {
          ++aCallbacks;
          sProjects.queueRequest({type:'postMsg', client:null, project:iRow.msgHead.etc.oid, msg:'Invited user '+iRow.msgHead.alias+' is unknown', callback:aOk});
        }
        sProjects.queueRequest({type:'projectImport', client:null, project:iRow.msgHead.etc.oid, from:sUUId, data:null, callback:aOk,
          jso:{type:'memberAlias', alias:iRow.msgHead.alias, invite:type === 'ok' ? 'accept' : 'invalid'}});
        return;
      }
      aOk();
      function aOk() {
        if (--aCallbacks > 0)
          return;
        iRow.msgHead = null;
        iRow.queue.shift();
        sServices._sendNext(iRow.host);
        fs.unlink(sSendDir+iRow.host+'/'+id, noOpCallback);
      }
    });
    iRow.conn.on('close', function() {
      iRow.status = 'offline';
      if (iRow.timer) {
        clearTimeout(iRow.timer);
        iRow.timer = null;
      }
      sClientCache.notify(null, {type:'services', list:sServices.list(iRow.host)});
    });
    iCallback(iRow);
  } ,

  _connect: function(iHost) {
    var aS = this.s[iHost];
    aS.status = 'trying';
    var aAddr = iHost.split(':');
    aS.conn.connect(aAddr[0], +aAddr[1] || 80, function() {
      if (aS.joined === 'no')
        aS.conn.register(sUUId, aS.password, aS.aliases);
      else
        aS.conn.login(sUUId, aS.password);
    });
  } ,

  _sendNext: function(iHost) {
    if (!this.s[iHost].queue.length)
      return;
    var aId = this.s[iHost].queue[0];
    fs.readFile(sSendDir+iHost+'/'+aId, function(err, data) {
      if (err) throw err;
      sServices.s[iHost].msgHead = MqClient.unpackMsg(data);
      delete sServices.s[iHost].msgHead._buf;
      sServices.s[iHost].conn.send(data);
      sServices.s[iHost].timer = setTimeout(sServices._timeout, 20*1000, iHost);
    });
  } ,

  _timeout: function(iHost) {
    sServices.s[iHost].timer = null;
    sServices._sendNext(iHost);
  } ,

  touch: function(iHost, iAliases, iComment, iReq) {
    var that = this;
    if (!(iHost in this.s)) {
      var aPass = uuid.generate();
      dbExec(that.db, "INSERT INTO service VALUES ('"+iHost+"', '"+aPass+"', 'no', NULL, NULL, 2)", noOpCallback, function() {
        that._create({ host:iHost, password:aPass, joined:'no', aliases:null, comment:null, newreg:2 }, function(svc) {
          that.touch(iHost, iAliases, iComment, iReq);
        });
      });
      return;
    }
    if (!that.stmtSave) {
      that.db.prepare("UPDATE service SET newreg=?, aliases=?, comment=? WHERE host = ?", function(err, stmt) {
        if (err) throw err;
        that.stmtSave = stmt;
        that.touch(iHost, iAliases, iComment, iReq);
      });
      return;
    }
    that.stmtSave.bind(1, this.s[iHost].newreg = +(this.s[iHost].newreg !== 2));
    that.stmtSave.bind(2, this.s[iHost].aliases = iAliases);
    that.stmtSave.bind(3, this.s[iHost].comment = iComment);
    that.stmtSave.bind(4, this.s[iHost].host);
    that.stmtSave.step(function(err, row) {
      if (err) throw err;
      that.stmtSave.reset();
      if (that.s[iHost].status === 'offline')
        that._connect(iHost);
      else if (that.s[iHost].status === 'online')
        that.s[iHost].conn.register(sUUId, '', that.s[iHost].aliases);
      sClientCache.notify(iReq, {type:'services', list:that.list(iHost)});
    });
  } ,

  list: function(iHost) {
    var aSvc = {};
    for (var a in this.s) {
      if (iHost && iHost !== a)
        continue;
      var aS = this.s[a];
      aSvc[a] = { host:aS.host, joined:aS.joined, aliases:aS.aliases, comment:aS.comment, status:aS.status };
    }
    return aSvc;
  } ,

  hasAlias: function(iHost, iStr) {
    var aAls = this.s[iHost].aliases;
    if (!aAls)
      return false;
    var aI = aAls.indexOf(iStr);
    if (aI < 0 || aI > 0 && aAls.charAt(aI-1) !== ' ' || aI+iStr.length < aAls.length && aAls.charAt(aI+iStr.length) !== ' ')
      return false;
    return true;
  } ,

  listEdit: function(iHost, iList, iOp, iMember, iEtc, iMsg, iCallback) {
    var aHead = { op:'listEdit', to:iList, type:iOp, member:iMember, etc:iEtc };
    this._queue(iHost, aHead, iMsg, iCallback);
  } ,

  listPost: function(iHost, iList, iEtc, iMsg, iCallback, iAll) {
    var aHead = { op:'post', to:{}, etc:iEtc };
    aHead.to[iList] = iAll || 2;
    this._queue(iHost, aHead, iMsg, iCallback);
  } ,

  listPostAll: function(iHost, iList, iEtc, iMsg, iCallback) {
    this.listPost(iHost, iList, iEtc, iMsg, iCallback, 3);
  } ,

  post: function(iHost, iTo, iEtc, iMsg, iCallback) {
    var aHead = { op:(typeof iTo === 'string' ? 'ping' : 'post'), etc:iEtc };
    if (aHead.op === 'post') {
      for (var any in iTo) break;
      if (!any) {
        process.nextTick(iCallback);
        return;
      }
    }
    aHead[aHead.op === 'ping' ? 'alias' : 'to'] = iTo;
    this._queue(iHost, aHead, iMsg, iCallback);
  } ,

  _queue: function(iHost, iHead, iMsg, iCallback) {
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
  }

}; // sServices

var sAttachments = {
  open: {},
  notify: null,

  init: function() {
    var that = this;
    that.notify = new Inotify();
    that.notify.addWatch({path:sEditCache, watch_for:Inotify.IN_CREATE|Inotify.IN_MOVED_TO, callback: function(event) {
      if (event.mask & Inotify.IN_IGNORED)
        return;
      var aDot = event.name.lastIndexOf('.');
      var aOid = aDot >= 0 ? event.name.slice(0, aDot) : event.name;
      if (!aOid || !that.open[aOid])
        return;
      var aId = that.open[aOid].id;
      that.open[aOid].id = that.notify.addWatch({path:sEditCache+event.name, watch_for:Inotify.IN_MODIFY, callback:that.open[aOid].onWrite});
      if (aId !== null) {
        that.notify.removeWatch(aId);
        var aPath = getPath(aOid);
        fs.unlink(aPath+'.w', function(err) {
          if (err) throw err;
          fs.link(sEditCache+event.name, aPath+'.w', noOpCallback);
        });
        that.open[aOid].onWrite({mask:Inotify.IN_MODIFY});
      }
    }});
    fs.readdir(sEditCache, function(err, dir) {
      if (err) throw err;
      var aCheck = function(a) {
        for (var aSeg; a < dir.length && (aSeg = dir[a].split('.')).length !== 3; ++a) {}
        if (a >= dir.length)
          return;
        fs.unlink(sEditCache+dir[a], function(err) {
          if (err) throw err;
          var aPath = getPath(aSeg[0]+'.'+aSeg[1]);
          fs.stat(aPath+'.w', function(err, work) {
            if (err)
              return aCheck(++a);
            fs.stat(aPath, function(err, main) {
              if (err || work.mtime.valueOf() !== main.mtime.valueOf())
                return aCheck(++a);
              fs.unlink(aPath+'.w', function(err) {
                if (err) throw err;
                aCheck(++a);
              });
            });
          });
        });
      };
      aCheck(0);
    });
  } ,

  ready: function(iClient, iProject, iPage, iOid, iDocType, iCallback) {
    if (iOid.indexOf('_') >= 0) {
      var aDocPath = sRevisionCache + iOid + iDocType;
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
    var aLink = function() {
      var aDocPath = sEditCache + iOid + iDocType;
      if (!that.open[iOid])
        that.open[iOid] = { docpath:{}, client:{}, id:null, onWrite: function(event) {
          if (event.mask & Inotify.IN_IGNORED)
            return;
          sProjects.queueRequest({type:'writePart', client:null, project:iProject, page:iPage, part:iOid, data:null});
        }};
      that.open[iOid].docpath[aDocPath] = true;
      that.open[iOid].client[iClient] = true;
      fs.link(aPath+'.w', aDocPath, function(err) {
        if (err && err.errno !== process.EEXIST) throw err;
        iCallback(aDocPath.replace(/\//g, '\\'));
      });
    };
    fs.stat(aPath+'.w', function(err, stats) {
      if (err)
        dupFile(aPath, aPath+'.w', function(err) {
          if (err) throw err;
          aLink();
        });
      else
        aLink();
    });
  } ,

  close: function(iClient) {
    for (var aOid in this.open) {
      if (!this.open[aOid].client[iClient])
        continue;
      delete this.open[aOid].client[iClient];
      var aActive = false;
      for (aActive in this.open[aOid].client) break;
      if (!aActive) {
        this.notify.removeWatch(this.open[aOid].id);
        for (var aL in this.open[aOid].docpath)
          fs.unlink(aL, noOpCallback);
        (function() {
          var aPath = getPath(aOid);
          fs.stat(aPath+'.w', function(err, work) {
            if (err) return;
            fs.stat(aPath, function(err, main) {
              if (err || work.mtime.valueOf() !== main.mtime.valueOf()) return;
              fs.unlink(aPath+'.w', noOpCallback);
            });
          });
        })();
        delete this.open[aOid];
      }
    }
  }

}; // sAttachments

var sProjects = {
  db: null,
  queue: new Queue,
  newSql: "\
    BEGIN TRANSACTION;\
    "+kIncrOid+";\
    INSERT INTO project VALUES ( ("+kNewOid+"), '', NULL, '{\"name\":\"Untitled\", \"blurb\":\"something\", \"created\":\"' || datetime('now') || '\"}', '{}' );\
    SELECT oid, dataw AS data, service, 1 AS installed FROM project WHERE rowid = last_insert_rowid();\
    COMMIT TRANSACTION;",
  pj: { },
  stmt: {},

  init: function(iStart) {
    var that = this;
    that.db = new sqlite.Database();
    that.db.open(sMainDir+'projects', function(openErr) {
      if (openErr) throw openErr;
      dbExec(that.db, "ATTACH '"+sMainDir+"instance' AS instance; ATTACH '"+sMainDir+"clients' AS clients;", noOpCallback, function() {
        that.queue.next();
        iStart();
      });
    });
  } ,

  finalize: function() {
    dbFinalize(this.stmt);
    this.db.close();
  } ,

  getClientNav: {},
  handle_getClientNav: function(iReq) {
    var that = this;
    if (!that.stmt.getClientNav) {
      that.db.prepare("SELECT data FROM clients.clientNav WHERE client = ?", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.getClientNav = stmt;
        that.handle_getClientNav(iReq);
      });
      return;
    }
    that.stmt.getClientNav.bind(1, iReq.client);
    that.stmt.getClientNav.step(function(stepErr, row) {
      if (stepErr) throw stepErr;
      that.stmt.getClientNav.reset();
      if (row)
        row.data = JSON.parse(row.data);
      sRespond(iReq, row || {data:{sort:'name', history: {n:1, len:1, i: [{proj:'#autogen.01000', page:'#autogen.01010'}]}}});
    });
  } ,

  setClientNav: { data:true },
  handle_setClientNav: function(iReq) {
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
    that.stmt.setClientNav.step(function(err, row) {
      if (err) throw err;
      that.stmt.setClientNav.reset();
      sRespond(iReq, {status:'ok'});
    });
  } ,

  autogen: function(iJso, iCallback, iN) {
    if (typeof iN === 'undefined')
      iN = 0;
    if (iN === iJso.length)
      return iCallback();
    dbExec(sProjects.db, "INSERT INTO project (oid, data, localData) VALUES ( '"+iJso[iN].project+"', '"+JSON.stringify(iJso[iN].data)+"', '{}' )", noOpCallback, function() {
      var aPath = makePath(iJso[iN].project);
      var aDb = new sqlite.Database();
      aDb.open(aPath, function(err) {
        if (err) throw err;
        var aSql = createSchema(Project.prototype.schema, aPath) + "BEGIN TRANSACTION;";
        dbExec(aDb, aSql, noOpCallback, function() {
          function aDataLoop(dataArray, dataN) {
            if (dataN === dataArray.length) {
              dbExec(aDb, "COMMIT TRANSACTION", noOpCallback, function() {
                aDb.close();
                sProjects.autogen(iJso, iCallback, ++iN);
              });
              return;
            }
            switch(dataArray[dataN].type) {
            case 'page':
              dbExec(aDb, "INSERT INTO page (oid, data, layout) VALUES \
                ('"+dataArray[dataN].oid+"', '"+JSON.stringify(dataArray[dataN].data)+"', '"+JSON.stringify(dataArray[dataN].layout)+"')"
                , noOpCallback, function() {
                aDataLoop(dataArray, ++dataN);
              });
              return;
            case 'part':
              fs.writeFile(makePath(dataArray[dataN].oid), dataArray[dataN].data, 'utf8', function(err) {
                if (err) throw err;
                aDataLoop(dataArray, ++dataN);
              });
              return;
            default:
              throw new Error('unknown autogen type: '+dataArray[dataN].type);
            }
          }
          aDataLoop(iJso[iN].list, 0);
        });
      });
    });
  } ,

  importt: { from:true, jso:true, data:true },
  handle_importt: function(iReq) {
    // this function must defend against attack
    // anyone on the service can send a message here with the user's alias
    var that = this;
    switch(iReq.jso.type) {
    case 'invite':
      if (!that.stmt.importInvite) {
        that.stmt.importInvite = {
          select: "SELECT accept FROM invite WHERE oid = ?",
          insert: "INSERT OR REPLACE INTO invite VALUES ( ?, ?, ?, ?, ?, ?, NULL )"
        };
        dbPrepare(that.db, that.stmt.importInvite, function(err) {
          if (err) throw err;
          that.handle_importt(iReq);
        });
        return;
      }
      that.stmt.importInvite.select.bind(1, iReq.jso.oid);
      that.stmt.importInvite.select.step(function(err, row) {
        if (err) throw err;
        that.stmt.importInvite.select.reset();
        if (row && row.accept) {
          sRespond(iReq, {});
          return;
        }
        that.stmt.importInvite.insert.bind(1, iReq.jso.date);
        that.stmt.importInvite.insert.bind(2, iReq.jso.toAlias);
        that.stmt.importInvite.insert.bind(3, iReq.jso.fromAlias);
        that.stmt.importInvite.insert.bind(4, iReq.jso.oid);
        that.stmt.importInvite.insert.bind(5, iReq.jso.service);
        that.stmt.importInvite.insert.bind(6, iReq.jso.data);
        that.stmt.importInvite.insert.step(function(err, row) {
          if (err) throw err;
          that.stmt.importInvite.insert.reset();
          iReq.jso.data = JSON.parse(iReq.jso.data);
          sClientCache.notify(iReq, iReq.jso);
        });
      });
      return;

    case 'project':
      if (!that.stmt.importProject) {
        that.stmt.importProject = {
          selectInvite:  "SELECT accept FROM invite  WHERE oid = ?",
          selectProject: "SELECT oid    FROM project WHERE oid = ?",
          insert: "INSERT INTO project VALUES ( ?, ?, ?, NULL, NULL )"
        };
        dbPrepare(that.db, that.stmt.importProject, function(err) {
          if (err) throw err;
          that.handle_importt(iReq);
        });
        return;
      }
      if (!iReq.data || !(iReq.jso.filemap instanceof Array))
        return aQuit();
      var aOff = 0, aFiles = iReq.jso.filemap;
      that.stmt.importProject.selectInvite.bind(1, aFiles[0].oid);
      that.stmt.importProject.selectInvite.step(function(err, row) {
        if (err) throw err;
        that.stmt.importProject.selectInvite.reset();
        if (!row || !row.accept)
          return aQuit();
        that.stmt.importProject.selectProject.bind(1, aFiles[0].oid);
        that.stmt.importProject.selectProject.step(function(err, row) {
          if (err) throw err;
          that.stmt.importProject.selectProject.reset();
          if (row)
            return aQuit();
          aFileLoop(0);
        });
      });
      function aQuit() {
        sRespond(iReq, {});
      }
      function aFileLoop(fileN) {
        if (fileN < aFiles.length) {
          fs.writeFile(makePath(aFiles[fileN].oid), iReq.data.slice(aOff, aOff+aFiles[fileN].size), function(err) {
            if (err) throw err;
            aOff += aFiles[fileN].size;
            aFileLoop(++fileN);
          });
          return;
        }
        that.stmt.importProject.insert.bind(1, iReq.jso.oid);
        that.stmt.importProject.insert.bind(2, iReq.jso.service);
        that.stmt.importProject.insert.bind(3, iReq.jso.data);
        that.stmt.importProject.insert.step(function(err, row) {
          if (err) throw err;
          that.stmt.importProject.insert.reset();
          delete iReq.jso.filemap;
          iReq.jso.data = JSON.parse(iReq.jso.data);
          sClientCache.notify(iReq, iReq.jso);
        });
      }
      return;

    default:
      console.log('unknown import type: '+iReq.jso.type);
      sRespond(iReq, {});
    }
  } ,

  setInstalled: function(iOid, iCallback) {
    dbExec(this.db, "UPDATE project SET localData = '{}' WHERE oid = '"+iOid+"'", noOpCallback, iCallback);
  } ,

  getList: {},
  handle_getList: function(iReq) {
    var that = this;
    if (!that.stmt.getList) {
      that.db.prepare("SELECT oid, service, CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM project", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.getList = stmt;
        that.handle_getList(iReq);
      });
      return;
    }
    dbResults(that.stmt.getList, 'data', function(array) {
      sRespond(iReq, {list:array});
    });
  } ,

  getInvites: {},
  handle_getInvites: function(iReq) {
    var that = this;
    if (!that.stmt.getInvites) {
      that.db.prepare("SELECT * FROM invite", function(err, stmt) {
        if (err) throw err;
        that.stmt.getInvites = stmt;
        that.handle_getInvites(iReq);
      });
      return;
    }
    dbResults(that.stmt.getInvites, 'data', function(array) {
      sRespond(iReq, {list:array});
    });
  } ,

  acceptInvite: { oid:true, service:true, to:true, alias:true },
  handle_acceptInvite: function(iReq) {
    var that = this;
    if (!that.stmt.acceptInvite) {
      that.db.prepare("UPDATE invite SET accept = ? WHERE oid = ?", function(err, stmt) {
        if (err) throw err;
        that.stmt.acceptInvite = stmt;
        that.handle_acceptInvite(iReq);
      });
      return;
    }
    sServices.post(iReq.service, iReq.to, {type:'acceptInvite', project:iReq.oid, uid:sUUId, alias:iReq.alias}, null, function() {
      var aDate = (new Date).toISOString();
      that.stmt.acceptInvite.bind(1, aDate);
      that.stmt.acceptInvite.bind(2, iReq.oid);
      that.stmt.acceptInvite.step(function(err, row) {
        if (err) throw err;
        that.stmt.acceptInvite.reset();
        sClientCache.notify(iReq, {type:'acceptinvite', oid:iReq.oid, accept:aDate});
      });
    });
  } ,

  newProject: {},
  handle_newProject: function(iReq) {
    var aProj;
    dbExec(this.db, this.newSql, function(err, row) {
      if (err) throw err;
      if (row) aProj = row;
    }, function() {
      sProjects.pj[aProj.oid] = new Project(aProj, function () {
        sClientCache.project(iReq.client, aProj.oid);
        aProj.data = JSON.parse(aProj.data);
        delete aProj.service;
        aProj.type = 'project';
        sClientCache.notify(iReq, aProj);
      });
    });
  } ,

  readyAttachment: { uri:true, doctype:true },
  handle_readyAttachment: function(iReq) {
    var aUri = url.parse(iReq.uri, true);
    sAttachments.ready(iReq.client, aUri.query.project, aUri.query.page, aUri.query.oid, iReq.doctype, function(path) {
      sRespond(iReq, { path:path });
    });
  } ,

  subscribeServices: {},
  handle_subscribeServices: function(iReq) {
    sRespond(iReq, {data:sServices.list()});
  } ,

  touchService: { host:true, aliases:true, comment:true },
  handle_touchService: function(iReq) {
    sServices.touch(iReq.host, iReq.aliases, iReq.comment, iReq);
  } ,

  lookup: function(iOid, iCallback) {
    var that = this;
    if (!that.stmt.lookup) {
      that.db.prepare("SELECT oid, service, localData NOT NULL AS installed FROM project WHERE oid = ?", function(err, stmt) {
        if (err) throw err;
        that.stmt.lookup = stmt;
        that.db.prepare("SELECT accept FROM invite WHERE oid = ?", function(err, stmt) {
          if (err) throw err;
          that.stmt.lookupInvite = stmt;
          that.lookup(iOid, iCallback);
        });
      });
      return;
    }
    that.stmt.lookup.bind(1, iOid);
    that.stmt.lookup.step(function(err, row) {
      if (err) throw err;
      that.stmt.lookup.reset();
      if (row)
        return iCallback(row);
      that.stmt.lookupInvite.bind(1, iOid);
      that.stmt.lookupInvite.step(function(err, row) {
        if (err) throw err;
        that.stmt.lookupInvite.reset();
        iCallback(row && row.accept ? 'invite' : null);
      });
    });
  } ,

  queueRequest: function(iReq) {
    if (!iReq.project || !this.pj[iReq.project]) {
      if (this.queue.post(iReq))
        this.processQueue(null, true);
    } else {
      if (this.pj[iReq.project].queue.post(iReq))
        this.processQueue(iReq.project, true);
    }
  } ,

  processQueue: function(iProject, iUseCurr) {
    var aQ = iProject ? this.pj[iProject].queue : this.queue;
    if (!iUseCurr)
      aQ.next();
    var aReq = aQ.curr();
    if (!aReq)
      return;
    if (aReq.project && !this.pj[aReq.project]) {
      this.lookup(aReq.project, function(data) {
        if (data === 'invite') {
          var aBuf = MqClient.packMsg({type:aReq.type, client:null, project:aReq.project, from:aReq.from, jso:aReq.jso}, aReq.data);
          storeFile(sInbound+aReq.project+'_'+Date.now(), aBuf, function(err) {
            if (err) throw err;
            sRespond(aReq, {}, true);
          });
        } else if (data) {
          sProjects.pj[aReq.project] = new Project(data, function() {
            if (data.installed)
              return aLastReq();
            fs.readdir(sInbound, function(err, array) {
              if (err) throw err;
              array.sort();
              var aIterDel, aIterN = 0;
              aIter();
              function aIter() {
                if (aIterDel)
                  fs.unlink(sInbound+aIterDel, noOpCallback);
                while (aIterN < array.length && array[aIterN].slice(0, array[aIterN].lastIndexOf('_')) !== aReq.project) ++aIterN;
                if (aIterN < array.length) {
                  aIterDel = array[aIterN];
                  fs.readFile(sInbound+array[aIterN++], function(err, buffer) {
                    if (err) throw err;
                    var aR = MqClient.unpackMsg(buffer);
                    aR.callback = aIter;
                    aR.data = aR._buf;
                    delete aR._buf;
                    sProjects.pj[aReq.project].queue.post(aR);
                    sProjects.processQueue(aReq.project, true);
                  });
                  return;
                }
                sProjects.setInstalled(aReq.project, aLastReq);
              }
            });
            function aLastReq() {
              sProjects.pj[aReq.project].queue.post(aReq);
              sProjects.processQueue(aReq.project, true);
            }
          });
        } else
          sRespond(aReq, {error:'Request against invalid Project oid'}, true);
        sProjects.processQueue();
      });
      return;
    }
    try {
    if (!aReq.hasOwnProperty('client'))
      throw 'client';
    var aHandler = 'handle_'+aReq.type;
    if (aHandler in this) {
      for (a in this[aReq.type])
        if (!aReq.hasOwnProperty(a))
          throw a;
      this[aHandler](aReq);
    } else {
      if (!aReq.hasOwnProperty('project'))
        throw 'project';
      if (aHandler in this.pj[aReq.project]) {
        for (a in this.pj[aReq.project][aReq.type])
          if (a === 'autogen' ? /^#autogen/.test(aReq.project) : !aReq.hasOwnProperty(a))
            throw a;
        this.pj[aReq.project][aHandler](aReq);
      } else {
        throw 'unknown Project request '+aReq.type;
      }
    }
    } catch (aErr) {
      if (typeof aErr === 'object')
        throw aErr;
      sRespond(aReq, {error: aReq.type + (aErr === 'autogen' ? ' illegal for autogen project' : ' request missing parameter '+aErr)});
    }
  } ,

  unloadProject: function(iName) {
    this.pj[iName].finalize();
    delete this.pj[iName];
  }

} // sProjects

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
    var aSchemaSql = createSchema(that.schema, aPath);
    aSchemaSql += "SELECT 1 AS haspage FROM page LIMIT 1;\
      SELECT oid, map FROM revision WHERE oid LIKE '!%';";
    var aHasPage, aRevPending;
    dbExec(that.db, aSchemaSql, function(err, row) {
      if (err) throw err;
      if (row) {
        if (row.haspage)
          aHasPage = true;
        else
          aRevPending = row;
      }
    }, function () {
      if (/^#autogen/.test(iRecord.oid)) {
        that.queue.next();
        iCallback();
        return;
      }
      that.db.prepare("UPDATE revision SET map = ? WHERE oid = ' '", function(prepErr, stmt) {
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
            that._finishRevision(that.db, JSON.parse(aRevPending.map), aRevMsg, aRevBuf, aDoneCall);
          });
        } else {
          dbExec(that.db, "INSERT OR IGNORE INTO revision (oid, map, parents) VALUES (' ', '"+that.revisionMapJson()+"', '{}')", noOpCallback, aDoneCall);
        }
        function aDoneCall() {
          dbExec(that.db, "SELECT map, parents FROM revision WHERE oid = ' '", function(err, row) {
            if (err) throw err;
            if (row) {
              that.revisionMap = row.map ? JSON.parse(row.map) : that.revisionMapInit;
              that.parentMap = JSON.parse(row.parents);
            }
          }, function() {
            that.queue.next();
            if (aHasPage)
              iCallback();
            else
              that.handle_newPage(null, iCallback);
          });
        }
      });
    });
  });
}

Project.prototype = {

  finalize: function() {
    for (var a in this.stmt)
      this.stmt[a].finalize();
    this.db.close();
  } ,

  schema: {
    instance: {},
    projects: {},
    filename: {
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
        data: 'blob'
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
  } ,

  projectImport: { autogen:true, from:true, jso:true, data:true },
  handle_projectImport: function(iReq) {
    var that = this;
    switch(iReq.jso.type) {

    case 'memberAlias':
      var aMa = iReq.jso;
      aUidstr = aMa.uid ? "'"+aMa.uid+"'" : 'NULL';
      var aRow;
      dbExec(that.db, "SELECT uid FROM member WHERE uid = "+aUidstr+" OR alias = '"+aMa.alias+"'", function(err, row) {
        if (err) throw err;
        if (row) aRow = row;
      }, function() {
        var aSql;
        if (aMa.invite === 'invalid')
          aSql = "INSERT OR REPLACE INTO member VALUES (NULL, '"+aMa.alias+"', 'invalid', 'invalid')";
        else if (!aRow || (!aRow.uid && aMa.uid))
          aSql = "INSERT OR REPLACE INTO member VALUES ("+aUidstr+",'"+aMa.alias+"','"+(new Date).toISOString()+"', NULL)";
        else if (aRow.uid && aMa.alias)
          aSql = "UPDATE member SET alias = '"+aMa.alias+"' WHERE uid = "+aUidstr;
        else if (aRow.uid && aMa.resign)
          aSql = "UPDATE member SET left = '"+(new Date).toISOString()+"' WHERE alias = '"+aMa.alias+"'";
        else
          return aCircInvite();
        aSql += ";SELECT uid, alias, joined, left FROM member WHERE alias = '"+aMa.alias+"';";
        var aNotify;
        dbExec(that.db, aSql, function(err, row) {
          if (err) throw err;
          if (row) {
            row.type = aMa.uid === sUUId ? 'setuseralias' : 'memberalias';
            aNotify = function() { sClientCache.notify(iReq, row, that.oid) };
          }
        }, aCircInvite);
        function aCircInvite() {
          if (!aNotify) aNotify = function() { sRespond(iReq, {}) };
          if (aMa.invite && aMa.invite !== 'invalid')
            sServices.listPost(that.service, that.oid, { type:'memberAlias', project:that.oid, alias:aMa.alias }, null, aNotify);
          else if (iReq.from === sUUId && aMa.uid && aMa.uid !== sUUId)
            that.sendProject(aMa.uid, aNotify);
          else
            aNotify();
        }
      });
      return;

    case 'acceptInvite':
      var aMember;
      dbExec(that.db, "SELECT uid, left FROM member WHERE alias = '"+iReq.jso.alias+"'", function(err, row) {
        if (err) throw err;
        if (row) aMember = row;
      }, function() {
        if (!aMember || aMember.left || aMember.uid && aMember.uid !== iReq.jso.uid) {
          console.log('got acceptInvite for invalid member: '+sys.inspect(aMember))
          sRespond(iReq, {});
          return; //. log error
        }
        sServices.listEdit(that.service, that.oid, 'add', iReq.from, {type:'memberAlias', project:that.oid, uid:iReq.from, alias:iReq.jso.alias}, null, function() {
          sRespond(iReq, {});
        });
      });
      return;

    case 'revision':
      if (!that.stmt.revisionDiff) {
        var aOk;
        dbExec(that.db, "SELECT 1 AS hasmem FROM member WHERE uid = '"+iReq.from+"';\
                         SELECT 1 AS hasrev FROM revision WHERE oid = '"+iReq.jso.oid+"';", function(err, row) {
          if (err) throw err;
          if (row) aOk = row.hasmem ? true : false;
        }, function() {
          if (!aOk) {
            sRespond(iReq, {});
            return;
          }
          that.db.prepare("INSERT INTO diff VALUES ( ?, '"+iReq.jso.oid+"', ? )", function(err, stmt) {
            if (err) throw err;
            that.stmt.revisionDiff = stmt;
            that.handle_projectImport(iReq);
          });
        });
        return;
      }
      var aNotify = [];
      dbExec(that.db, "BEGIN TRANSACTION", noOpCallback, function() {
        for (var a in that.parentMap)
          if (!(a in iReq.jso.parents))
            iReq.jso.parents[a] = 0;
        that.checkConflict(iReq.jso, function(sideline, partlist) {
console.log(partlist);
          if (partlist)
            iReq.jso.map.page.sideline = {part:partlist};
          dbExec(that.db, "INSERT INTO revision VALUES (\
                       '"+(sideline ? '' : '!')+iReq.jso.oid+"', \
                       '"+iReq.jso.author+"', \
                       '"+iReq.jso.date+"', \
                       '"+JSON.stringify(iReq.jso.map)+"', \
                       '"+JSON.stringify(iReq.jso.parents)+"', \
                       "+(sideline ? "'"+sideline+"'" : "NULL")+")", noOpCallback, aIter);
        });
      });
      function aIter(iterN, iterO) {
        if (!iterN) iterN = iterO = 0;
        if (iterN < iReq.jso.list.length) {
          var aStart = iterO;
          iterO += iReq.jso.list[iterN].size;
          var aDiff = iReq.jso.list[iterN].type === 'part' ? iReq.data.slice(aStart, iterO) : iReq.data.toString('ascii', aStart, iterO);
          if (!iReq.jso.map.page.sideline)
            return aSetDiff(aDiff);
          switch(iReq.jso.list[iterN].type) {
          case 'proj':
            var aData = JSON.parse(aDiff).add;
            dbExec(that.db, "UPDATE projects.project SET data = '"+JSON.stringify(aData)+"' WHERE oid = '"+that.oid+"';", noOpCallback, function() {
              sClientCache.notify(null, {type:'projectdata', oid:that.oid, data:aData});
              aSetDiff(aDiff);
            });
            break;
          case 'page':
            var aOrig;
            dbExec(that.db, "SELECT data, layout FROM page WHERE oid = '"+iReq.jso.list[iterN].oid+"'", function(err, row) {
              if (err) throw err;
              if (row) {
                aOrig = row;
                aOrig.data = JSON.parse(aOrig.data);
                aOrig.layout = JSON.parse(aOrig.layout);
              }
            }, function() {
              if (!aOrig) aOrig = { data:{}, layout:[] };
              that.patch(aOrig, JSON.parse(aDiff));
              dbExec(that.db, "INSERT OR REPLACE INTO page VALUES \
                               ( '"+iReq.jso.list[iterN].oid+"', '"+JSON.stringify(aOrig.data)+"', NULL, '"+JSON.stringify(aOrig.layout)+"', NULL )", noOpCallback, function() {
                aNotify.push({type:'page', oid:iReq.jso.list[iterN].oid, data:aOrig.data});
                aSetDiff(aDiff);
              });
            });
            break;
          case 'part':
            var aPath = iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || makePath(iReq.jso.list[iterN].oid);
            if (iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid])
              aApplyDiff(false);
            else
              fs.stat(aPath, aApplyDiff);
            function aApplyDiff(noPath) {
              xdPatch(!noPath && aPath, aDiff, aPath+'.temp', function(err) {
                if (err) throw err;
                fs.rename(aPath+'.temp', iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || aPath+'.new', function(err) {
                  if (err) throw err;
                  if (noPath)
                    return aSetDiff(null);
                  xdDiff(iReq.jso.map.page.sideline.part[iReq.jso.list[iterN].oid] || aPath+'.new', aPath, function(err, diff) {
                    if (err) throw err;
                    aSetDiff(diff);
                  });
                });
              });
            }
            break;
          default:
            throw new Error('revision has unsupported type '+iReq.jso.list[iterN].type);
          }
          function aSetDiff(diff) {
            that.stmt.revisionDiff.bind(1, iReq.jso.list[iterN].oid);
            that.stmt.revisionDiff.bind(2, diff);
            that.stmt.revisionDiff.step(function(err, row) {
              if (err) throw err;
              that.stmt.revisionDiff.reset();
              aIter(++iterN, iterO);
            });
          }
          return;
        }
        that.stmt.revisionDiff.finalize();
        delete that.stmt.revisionDiff;
        that.parentMap[iReq.jso.author] = +iReq.jso.oid.slice(iReq.jso.oid.indexOf('.')+1);
        delete iReq.jso.list;
        aNotify.push(iReq.jso);
        dbExec(that.db, "UPDATE revision SET parents = '"+JSON.stringify(that.parentMap)+"' WHERE oid = ' ';\
                         COMMIT TRANSACTION;", noOpCallback, function() {
          if (iReq.jso.map.page.sideline)
            that._finishRevision(that.db, iReq.jso.map, null, null, aDone);
          else
            aDone();
          function aDone() {
            sClientCache.notify(iReq, aNotify, that.oid);
          }
        });
      }
      return;
    default:
      throw new Error('unknown import type: '+iReq.jso.type);
    }
  } ,

  sendProject: function(iTo, iCallback) {
    var that = this;
    var aMsgHead;
    dbExec(this.db, "SELECT oid, service, data FROM projects.project WHERE oid = '"+this.oid+"';", function(err, row) {
      if (err) throw err;
      if (row) aMsgHead = row;
    }, function() {
      aMsgHead.filemap = [{oid:aMsgHead.oid+'.temp', size:0}];
      var aOids = {};
      var aPath = getPath(aMsgHead.oid);
      dupFile(aPath, aPath+'.temp', function(err) {
        if (err) throw err;
        var aDb = new sqlite.Database();
        aDb.open(aPath+'.temp', function(err) {
          if (err) throw err;
          dbExec(aDb, "BEGIN TRANSACTION;\
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
            var aAllSize = 0;
            aFileLoop(0);
            function aFileLoop(fileN) {
              if (fileN < aMsgHead.filemap.length) {
                fs.readFile(getPath(aMsgHead.filemap[fileN].oid), function(err, buf) {
                  if (err && err.errno !== process.ENOENT) throw err;
                  if (err) {
                    aMsgHead.filemap.splice(fileN, 1);
                  } else {
                    aMsgHead.filemap[fileN++].size = buf;
                    aAllSize += buf.length;
                  }
                  aFileLoop(fileN);
                });
                return;
              }
              fs.unlink(aPath+'.temp', noOpCallback);
              var aAllBuf = new Buffer(aAllSize);
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
          });
        });
      });
    });
  } ,

  checkConflict: function(iRevision, iCallback, iConflict, iChain) {
    var that = this;
    if (!that.stmt.checkConflict) {
      that.stmt.checkConflict = {
        revision: "SELECT rowid, oid, map, parents, sideline, author FROM revision ORDER BY rowid DESC",
        member: "SELECT joined FROM member WHERE uid = ?",
        diff: "SELECT data FROM diff WHERE revision = ? AND object = ?",
        page: "SELECT data, layout FROM page WHERE oid = ?",
        proj: "SELECT data FROM projects.project WHERE oid = ?",
        state: "SELECT client, state FROM clientstate",
        setdiff: "UPDATE diff SET data = ?3 WHERE revision = ?1 AND object = ?2",
        setpage: "UPDATE page SET data = ?2, layout = ?3 WHERE oid = ?1",
        setproj: "UPDATE projects.project SET data = ?2 WHERE oid = ?1",
        setstate: "UPDATE clientstate SET state = ?2 WHERE client = ?1",
        setrev: "UPDATE revision SET sideline = ?2 WHERE oid = ?1"
      };
      dbPrepare(that.db, that.stmt.checkConflict, function(err) {
        if (err) throw err;
        that.checkConflict(iRevision, iCallback);
      });
      return;
    }
    that.stmt.checkConflict.revision.step(function(err, row) {
      if (err) throw err;console.log( iRevision.parents);
      if (row.oid === ' ') throw new Error('parent not found');
      if (!iConflict) {
        iConflict = [];
        iChain = {};
        iRevision._parents = {};
        aLogConflict(iRevision, { rowid:row.rowid+1, oid:' ', map:that.revisionMap, parents:that.parentMap, author:sUUId }, 'chain');
      }
      var aOidCounter = +row.oid.slice(row.oid.indexOf('.')+1);
      if (aOidCounter > iRevision.parents[row.author]) {
        row.map = JSON.parse(row.map);
        row.parents = JSON.parse(row.parents);
        aLogConflict(iRevision, row, 'chain');
        if (iRevision.parents[row.author] === 0 && !(row.author in row.parents))
          aOidCounter = 0;
      }
      if (aOidCounter === iRevision.parents[row.author]) {
        iRevision._parents[row.author] = iRevision.parents[row.author];
        delete iRevision.parents[row.author];
        for (var any in iRevision.parents) break;
        if (!any) {
          iRevision.parents = iRevision._parents;
          delete iRevision._parents;
        }
      }
      if (iRevision._parents)
        return that.checkConflict(iRevision, iCallback, iConflict, iChain);
      function aLogConflict(main, alt, chain) {
        if (chain) {
          for (var a in alt.parents) {
            var aP = a+'.'+alt.parents[a];
            if (!iChain[aP])
              iChain[aP] = {};
            iChain[aP][alt.oid] = alt;
          }
        }
        if (!alt.sideline) {
          if (alt.map.touch && main.map.touch)
            return aRecur(true);
          for (var aPg in main.map.page) {
            if (aPg in alt.map.page) {
              if (alt.map.page[aPg].op === '!' && main.map.page[aPg].op === '!')
                return aRecur(true);
              for (var aPt in main.map.page[aPg].part)
                if (aPt in alt.map.page[aPg].part)
                  return aRecur(true);
            }
          }
        }
        aRecur();
        function aRecur(hasConflict) {
          if (hasConflict) {
            for (var a=0; a < iConflict.length && alt.rowid < iConflict[a].rowid; ++a) {}
            iConflict.splice(a, 0, alt);
            alt.sideline = true;
          }
          if (!iChain[alt.oid])
            return;
          if (!chain)
            for (var a in iChain[alt.oid])
              aLogConflict(main, iChain[alt.oid][a]);
          if (hasConflict)
            for (var a in iChain[alt.oid])
              aLogConflict(alt, iChain[alt.oid][a]);
        }
      }
      that.stmt.checkConflict.revision.reset();
      if (iConflict.length === 0)
        return iCallback(null, {});
      iConflict.push({author:iRevision.author});
      aCheckPermission();
      function aCheckPermission() {
        for (var a=0; a < iConflict.length; ++a) {
          if (iConflict[a].joined)
            continue;
          that.stmt.checkConflict.member.bind(1, iConflict[a].author);
          that.stmt.checkConflict.member.step(function(err, row) {
            if (err) throw err;
            that.stmt.checkConflict.member.reset();
            iConflict[a].joined = row.joined;
            aCheckPermission();
          });
          return;
        }
        var aAuthorJoined = iConflict.pop().joined;
        var aSidelinedCurr = iConflict[0].oid === ' ';
        if (!aSidelinedCurr || iConflict.length > 1)
          for (var a=iConflict.length-1; a >= 0; --a)
            if (aAuthorJoined > iConflict[a].joined)
              return iCallback(iConflict[a].oid);
        dbResults(that.stmt.checkConflict.state, 'state', function(states) {
          var aRevN = 0;
          var aModList = { proj:{}, page:{}, part:{} };
          if (aSidelinedCurr)
            that.handle_commitRevision(null, aSideline);
          else
            aSideline();
          function aSideline(newrev) {
            if (newrev)
              iConflict[0].oid = newrev.oid;
            var aObject;
console.log(iConflict[aRevN], iConflict[aRevN].map);
            for (var aPg in iConflict[aRevN].map.page) {
              for (var aPt in iConflict[aRevN].map.page[aPg].part) break;
              aObject = aPt || iConflict[aRevN].map.page[aPg].op !== '.' && aPg;
              if (aPt) {
                delete iConflict[aRevN].map.page[aPg].part[aPt];
              } else {
                delete iConflict[aRevN].map.page[aPg];
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
            if (!aObject && iConflict[aRevN].map.touch) {
              delete iConflict[aRevN].map.touch;
              aObject = that.oid;
              if (!aModList.proj[aObject])
                aModList.proj[aObject] = null;
            }
            if (aObject) {
    console.log(aObject);
              that.stmt.checkConflict.diff.bind(1, iConflict[aRevN].oid);
              that.stmt.checkConflict.diff.bind(2, aObject);
              that.stmt.checkConflict.diff.step(function(err, diffRow) {
                if (err) throw err;
                that.stmt.checkConflict.diff.reset();
                if (aObject in aModList.part) {
                  var aPath = getPath(aObject);
                  if (!diffRow.data) {
                    //. flag file for removal by finishRevision
                    aForwardDiff({errno:process.ENOENT});
                  } else if (aSidelinedCurr && aRevN === 0) {
                    dupFile(aPath, aPath+'.temp', aForwardDiff);
                  } else {
                    xdPatch(aModList.part[aObject] || aPath, diffRow.data, aPath+'.temp', aForwardDiff);
                  }
                  function aForwardDiff(err) {
                    if (err && err.errno !== process.ENOENT) throw err;
                    xdDiff(!err && aPath+'.temp', aModList.part[aObject] || (aSidelinedCurr && aRevN === 0 ? aPath+'.w' : aPath), function(err, diff) {
                      if (err) throw err;
                      that.stmt.checkConflict.setdiff.bind(1, iConflict[aRevN].oid);
                      that.stmt.checkConflict.setdiff.bind(2, aObject);
                      that.stmt.checkConflict.setdiff.bind(3, diff);
                      that.stmt.checkConflict.setdiff.step(function(err, row) {
                        if (err) throw err;
                        that.stmt.checkConflict.setdiff.reset();
                        fs.rename(aPath+'.temp', aPath+'.new', function(err) {
                          if (err && err.errno !== process.ENOENT) throw err;
                          if (!err && !aModList.part[aObject])
                            aModList.part[aObject] = aPath+'.new';
                          aSideline();
                        });
                      });
                    });
                  }
                } else {
                  var aType = aObject in aModList.page ? 'page' : 'proj';
                  if (!aModList[aType][aObject]) {
                    that.stmt.checkConflict[aType].bind(1, aObject);
                    that.stmt.checkConflict[aType].step(function(err, row) {
                      if (err) throw err;
                      that.stmt.checkConflict[aType].reset();
                      if (aType === 'page')
                        row.layout = JSON.parse(row.layout);
                      row.data = JSON.parse(row.data);
                      aModList[aType][aObject] = row;
                      aUpdateData();
                    });
                  } else {
                    aUpdateData();
                  }
                  function aUpdateData() {
                    that.unpatch(aModList[aType][aObject], JSON.parse(diffRow.data));
                    that.stmt.checkConflict['set'+aType].bind(1, aObject);
                    that.stmt.checkConflict['set'+aType].bind(2, JSON.stringify(aModList[aType][aObject].data));
                    if (aType === 'page')
                      that.stmt.checkConflict['set'+aType].bind(3, JSON.stringify(aModList[aType][aObject].layout));
                    that.stmt.checkConflict['set'+aType].step(function(err, row) {
                      if (err) throw err;
                      that.stmt.checkConflict['set'+aType].reset();
                      aSideline();
                    });
                  }
                }
              });
              return;
            }
            that.stmt.checkConflict.setrev.bind(1, iConflict[aRevN].oid);
            that.stmt.checkConflict.setrev.bind(2, iRevision.oid);
            that.stmt.checkConflict.setrev.step(function(err, row) {
              if (err) throw err;
              that.stmt.checkConflict.setrev.reset();
              if (++aRevN < iConflict.length)
                aSideline();
              else
                aSaveState();
              function aSaveState() {
                for (var a=0; a < states.length; ++a) {
                  if (!states[a]._update)
                    continue;
                  delete states[a]._update;
                  that.stmt.checkConflict.setstate.bind(1, states[a].client);
                  that.stmt.checkConflict.setstate.bind(2, JSON.stringify(states[a].state));
                  that.stmt.checkConflict.setstate.step(function(err, row) {
                    if (err) throw err;
                    that.stmt.checkConflict.setstate.reset();
                    aSaveState();
                  });
                  //. notify subscribers whose state changed
                  return;
                }
                iCallback(null, aModList.part);
              }
            });
          }
        });
      }
    });  
  } ,

  getMembers: function(iAppendArgs, iCallback) {
    var that = this;
    var argv = arguments;
    if (!that.stmt.members) {
      that.db.prepare("SELECT uid FROM member WHERE left IS NULL AND uid NOT NULL AND uid != '"+sUUId+"'", function(err, stmt) {
        if (err) throw err;
        that.stmt.members = stmt;
        that.getMembers.apply(that, argv);
      });
      return;
    }
    dbResults(that.stmt.members, function(array) {
      var aToList = {};
      for (var a=0; a < array.length; ++a)
        aToList[array[a].uid] = true;
      for (var a=0; a < argv.length-1; ++a)
        if (argv[a])
          aToList[argv[a]] = true;
      argv[argv.length-1](aToList);
    });
  } ,

  postMsg: { msg:true },
  handle_postMsg: function(iReq) {
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
    that.stmt.msgPost.step(function(err, row) {
      if (err) throw err;
      that.stmt.msgPost.reset();
      var aMsg;
      dbExec(that.db, "SELECT * FROM message WHERE rowid = last_insert_rowid()", function(err, row) {
        if (err) throw err;
        if (row) aMsg = row;
      }, function() {
        aMsg.type = 'message';
        sClientCache.notify(iReq, aMsg, that.oid);
      });
    });
  } ,

  getMsgList: {},
  handle_getMsgList: function(iReq) {
    var that = this;
    if (!that.stmt.msgList) {
      this.db.prepare("SELECT * FROM message ORDER BY date DESC", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.msgList = stmt;
        that.handle_getMsgList(iReq);
      });
      return;
    }
    dbResults(that.stmt.msgList, function(array) {
      sRespond(iReq, {list:array});
    });
  } ,

  setClientState: { data:true },
  handle_setClientState: function(iReq) {
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
    that.stmt.setState.step(function(stepErr, row) {
      if (stepErr) throw stepErr;
      that.stmt.setState.reset();
      sRespond(iReq, {status:'ok'});
    });
  } ,

  setService: { autogen:true, service:true },
  handle_setService: function(iReq) {
    var that = this;
    dbExec(that.db, "UPDATE projects.project SET service = '"+iReq.service+"' WHERE oid = '"+that.oid+"'", noOpCallback, function() {
      that.service = iReq.service;
      sClientCache.notify(iReq, {type:'setservice', service:iReq.service}, that.oid);
    });
  } ,

  setUseralias: { autogen:true, alias:true },
  handle_setUseralias: function(iReq) {
    var that = this;
    var aUpdt = { type:'memberAlias', project:that.oid, alias:iReq.alias, uid:sUUId };
    sServices.listPostAll(that.service, that.oid, aUpdt, null, function() {
      dbExec(that.db, "BEGIN TRANSACTION;\
                       INSERT OR IGNORE INTO member VALUES ( '"+sUUId+"', '"+iReq.alias+"', '"+(new Date).toISOString()+"', NULL );\
                       UPDATE member SET alias = '"+iReq.alias+"' WHERE uid = '"+sUUId+"';\
                       COMMIT TRANSACTION;", noOpCallback, function() {
        sClientCache.notify(iReq, {type:'setuseralias', alias:iReq.alias}, that.oid);
      });
    });
  } ,

  addMember: { autogen:true, alias:true },
  handle_addMember: function(iReq) {
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
      return sRespond(iReq, {error:'addMember requires an active service'});
    var aUseralias;
    dbExec(that.db, "SELECT alias FROM member WHERE uid = '"+sUUId+"'", function(err, row) {
      if (err) throw err;
      if (row) aUseralias = row.alias;
    }, function() {
      if (!aUseralias || !sServices.hasAlias(that.service, aUseralias))
        return sRespond(iReq, {error:'addMember requires a user alias'});
      var aInvite;
      dbExec(that.db, "SELECT service, data FROM projects.project WHERE oid='"+that.oid+"'", function(err, row) {
        if (err) throw err;
        if (row) aInvite = { type:'invite', date:(new Date).toISOString(), toAlias:iReq.alias, fromAlias:aUseralias,
                             oid:that.oid, service:row.service, data:row.data };
      }, function() {
        if (!aInvite.data)
          return sRespond(iReq, {error:'addMember requires a project with a revision'});
        sServices.post(aInvite.service, iReq.alias, aInvite, null, function() {
          var aDate = (new Date).toISOString();
          that.stmt.addMember.bind(1, iReq.alias);
          that.stmt.addMember.bind(2, aDate);
          that.stmt.addMember.step(function(stepErr, row) {
            if (stepErr) throw stepErr;
            that.stmt.addMember.reset();
            sClientCache.notify(iReq, {type:'memberalias', alias:iReq.alias, uid:null, joined:aDate, left:null}, that.oid);
          });
        });
      });
    });
  } ,

  resign: { autogen:true },
  handle_resign: function(iReq) {
    var that = this;
    var aDel = { type:'memberAlias', project:that.oid, uid:sUUId, resign:true };
    sServices.listEdit(that.service, that.oid, 'remove', sUUId, aDel, null, function() {
      var aRow;
      dbExec(that.db, "UPDATE member SET left = 'pending' WHERE uid = '"+sUUId+"';\
                       SELECT alias, joined, left, uid FROM member WHERE uid = '"+sUUId+"';", function(err, row) {
        if (err) throw err;
        if (row) aRow = row;
      }, function() {
        aRow.type = 'memberalias';
        sClientCache.notify(iReq, aRow, that.oid);
      });
    });
  } ,

  subscribe: {},
  handle_subscribe: function(iReq) {
    var that = this;
    if (!that.stmt.pageList) {
      that.db.prepare("SELECT oid, CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM page", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.pageList = stmt;
        that.db.prepare("SELECT alias, joined, left, uid, uid='"+sUUId+"' AS useralias FROM member", function(prepErr, stmt) {
          if (prepErr) throw prepErr
          that.stmt.memberList = stmt;
          that.db.prepare("SELECT * FROM revision WHERE oid != ' ' ORDER BY date", function(prepErr, stmt) {
            if (prepErr) throw prepErr;
            that.stmt.revisionList = stmt;
            that.db.prepare("SELECT state FROM clientstate WHERE client = ?", function(prepErr, stmt) {
              if (prepErr) throw prepErr;
              that.stmt.getState = stmt;
              that.db.prepare("SELECT CASE WHEN dataw IS NULL THEN data ELSE dataw END AS data FROM projects.project WHERE oid = '"+that.oid+"'", function(prepErr, stmt) {
                if (prepErr) throw prepErr;
                that.stmt.getProjectData = stmt;
                that.handle_subscribe(iReq);
              });
            });
          });
        });
      });
      return;
    }
    var aResult = { service:that.service };
    dbResults(that.stmt.pageList, 'data', function(array) {
      aResult.page = array;
      dbResults(that.stmt.memberList, function(array) {
        aResult.member = array;
        dbResults(that.stmt.revisionList, 'map', function(array) {
          aResult.revision = array;
          that.stmt.getState.bind(1, iReq.client);
          that.stmt.getState.step(function(stepErr, row) {
            if (stepErr) throw stepErr;
            that.stmt.getState.reset();
            aResult.state = row ? JSON.parse(row.state) : null;
            that.stmt.getProjectData.step(function(err, row) {
              if (err) throw err;
              that.stmt.getProjectData.reset();
              aResult.data = JSON.parse(row.data);
              sRespond(iReq, aResult);
            });
          });
        });
      });
    });
    sClientCache.project(iReq.client, this.oid);
  } ,

  write: { autogen:true, data:true },
  handle_write: function(iReq) {
    var that = this;
    if (!that.stmt.updateData) {
      that.db.prepare("UPDATE projects.project SET dataw = ? WHERE oid = '"+that.oid+"'", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.updateData = stmt;
        that.handle_write(iReq);
      });
      return;
    }
    dbExec(that.db, "BEGIN TRANSACTION", noOpCallback, function() {
      that.stmt.updateData.bind(1, JSON.stringify(iReq.data));
      that.stmt.updateData.step(function(stepErr, row) {
        if (stepErr) throw stepErr;
        that.stmt.updateData.reset();
        that.revisionMap.touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.step(function(stepErr, row) {
          if (stepErr) throw stepErr;
          that.stmt.setRevisionMap.reset();
          dbExec(that.db, "COMMIT TRANSACTION", noOpCallback, function() {
            sClientCache.notify(iReq.client, {type:'projectdata', oid:that.oid, data:iReq.data});
            sRespond(iReq, {status:'ok'});
          });
        });
      });
    });
  } ,

  sqlNewPage: "\
    BEGIN TRANSACTION;\
    "+kIncrOid+";\
    INSERT INTO page VALUES ( ("+kNewOid+"), NULL, '{\"name\":\"Untitled\", \"added\":\"' || datetime('now') || '\"}', NULL, '[]' );\
    SELECT oid, dataw AS data FROM page WHERE rowid = last_insert_rowid();" ,

  newPage: { autogen:true },
  handle_newPage: function(iReq, iCallback) {
    var aPage;
    var that = this;
    dbExec(this.db, this.sqlNewPage, function(stepErr, row) {
      if (stepErr) throw stepErr;
      if (row)
        aPage = row;
    }, function() {
      that.revisionMap.page[aPage.oid] = {op:'+', touch:(new Date).toISOString(), part:{}};
      that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
      that.stmt.setRevisionMap.step(function(stepErr, row) {
        if (stepErr) throw stepErr;
        that.stmt.setRevisionMap.reset();
        dbExec(that.db, "COMMIT TRANSACTION", function(err, row) {
          if (err) throw err;
        }, iCallback || function() {
          sClientCache.page(iReq.client, that.oid, aPage.oid);
          aPage.data = JSON.parse(aPage.data);
          aPage.type = 'page';
          sClientCache.notify(iReq, aPage, that.oid);
        });
      });
    });
  } ,

  subscribePage: { page:true },
  handle_subscribePage: function(iReq) {
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
    that.stmt.subscribePage.step(function(stepErr, row) {
      if (stepErr) throw stepErr;
      that.stmt.subscribePage.reset();
      sClientCache.page(iReq.client, that.oid, iReq.page);
      row.layout = JSON.parse(row.layout);
      row.data = JSON.parse(row.data);
      sRespond(iReq, row, true);
      that._sendParts(row.layout, 0, iReq);
    });
  } ,

  writePage: { autogen:true, page:true, data:true },
  handle_writePage: function(iReq) {
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
    dbExec(that.db, "BEGIN TRANSACTION", noOpCallback, function() {
      that.stmt.writePage.bind(1, JSON.stringify(iReq.data.data));
      that.stmt.writePage.bind(2, JSON.stringify(iReq.data.layout));
      that.stmt.writePage.bind(3, iReq.page);
      that.stmt.writePage.step(function(stepErr, row) {
        if (stepErr) throw stepErr;
        that.stmt.writePage.reset();
        if (!that.revisionMap.page[iReq.page])
          that.revisionMap.page[iReq.page] = {op:'!', touch:null, part:{}};
        else if (that.revisionMap.page[iReq.page].op === '.')
          that.revisionMap.page[iReq.page].op = '!';
        that.revisionMap.page[iReq.page].touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.step(function(stepErr, row) {
          if (stepErr) throw stepErr;
          that.stmt.setRevisionMap.reset();
          dbExec(that.db, "COMMIT TRANSACTION", noOpCallback, function() {
            iReq.data.type = 'pagedata';
            sClientCache.notify(iReq.client, iReq.data, that.oid, !iReq.data.data && iReq.page);
            sRespond(iReq, {status:'ok'});
          });
        });
      });
    });
  } ,

  readPageRevision: { page:true, revision:true },
  handle_readPageRevision: function(iReq, iData) {
    var that = this;
    if (!that.stmt.getPage) {
      that.db.prepare("SELECT data, layout FROM page WHERE oid = ?", function(prepErr, stmt) {
        if (prepErr) throw prepErr;
        that.stmt.getPage = stmt;
        that.db.prepare("SELECT oid, map FROM revision WHERE oid != ' ' ORDER BY ROWID DESC", function(prepErr, stmt) {
          if (prepErr) throw prepErr;
          that.stmt.pageRevision = stmt;
          that.db.prepare("SELECT data FROM diff WHERE revision = ? AND object = ?", function(prepErr, stmt) {
            if (prepErr) throw prepErr;
            that.stmt.getDiff = stmt;
            that.handle_readPageRevision(iReq);
          });
        });
      });
      return;
    }
    var aCachedPg = sRevisionCache+iReq.revision+'_'+iReq.page;
    if (!iData) {
      fs.stat(aCachedPg, function(err, stats) {
        if (err && err.errno !== process.ENOENT) throw err;
        if (!err) {
          fs.readFile(aCachedPg, 'utf8', function(fileErr, data) {
            if (fileErr) throw fileErr;
            var aPg = JSON.parse(data);
            sRespond(iReq, aPg, true);
            that._sendParts(aPg.layout, 0, iReq);
          });
          return;
        }
        that.stmt.getPage.bind(1, iReq.page);
        that.stmt.getPage.step(function(err, row) {
          if (err) throw err;
          that.stmt.getPage.reset();
          that.handle_readPageRevision(iReq, { data:JSON.parse(row.data), layout:JSON.parse(row.layout), revparts:{} });
        });
      });
      return;
    }
    that.stmt.pageRevision.step(function(err, row) {
      if (err) throw err;
      if (row.oid === iReq.revision) {
        that.stmt.pageRevision.reset();
        aCompleteCache(0);
        function aCompleteCache(idx) {
          for (; idx < iData.layout.length && (!iData.layout[idx].oid || iData.revparts[iData.layout[idx].oid]); ++idx)
            if (iData.layout[idx].oid)
              iData.layout[idx].oid = iReq.revision+'_'+iData.layout[idx].oid;
          if (idx < iData.layout.length) {
            var aOrig = getPath(iData.layout[idx].oid);
            iData.layout[idx].oid = iReq.revision+'_'+iData.layout[idx].oid;
            dupFile(aOrig, sRevisionCache+iData.layout[idx].oid, function(err) {
              if (err && err.errno !== process.ENOENT) throw err;
              aCompleteCache(++idx);
            });
            return;
          }
          delete iData.revparts;
          iData.oid = iReq.page;
          iData.revision = iReq.revision;
          fs.writeFile(aCachedPg, JSON.stringify(iData), 'utf8', function(fileErr) {
            if (fileErr) throw fileErr;
            sRespond(iReq, iData, true);
            that._sendParts(iData.layout, 0, iReq);
          });
        }
        return;
      }
      var aMap = JSON.parse(row.map);
      for (var aPg in aMap.page)
        if (aPg === iReq.page)
          break;
      if (aPg !== iReq.page) {
        that.handle_readPageRevision(iReq, iData);
        return;
      }
      that.stmt.getDiff.bind(1, row.oid);
      if (aMap.page[iReq.page].op !== '.') {
        that.stmt.getDiff.bind(2, iReq.page);
        that.stmt.getDiff.step(function(err, row) {
          if (err) throw err;
          that.stmt.getDiff.reset();
          that.unpatch(iData, JSON.parse(row.data));
          aPtFn();
        });
      } else {
        aPtFn();
      }
      function aPtFn() {
        for (var aPt in aMap.page[iReq.page].part) {
          iData.revparts[aPt] = true;
          delete aMap.page[iReq.page].part[aPt];
          that.stmt.getDiff.bind(2, aPt);
          that.stmt.getDiff.step(function(err, row) {
            if (err) throw err;
            that.stmt.getDiff.reset();
            var aRevCopy = sRevisionCache+iReq.revision+'_'+aPt;
            if (!row.data) {
              fs.unlink(aRevCopy, function(err) {
                if (err && err.errno !== process.ENOENT) throw err;
                aPtFn();
              });
              return;
            }
            fs.stat(aRevCopy, function(statErr, stats) {
              var aC = child.spawn('xdelta3', ['-d', '-c', '-s', statErr ? getPath(aPt) : aRevCopy]);
              aC.stdin.end(row.data);
              sys.pump(aC.stdout, fs.createWriteStream(aRevCopy+'.temp'), noOpCallback);
              aC.on('exit', function(code) {
                if (code) throw 'xdelta3 exit with code '+code;
                fs.rename(aRevCopy+'.temp', aRevCopy, function(err) {
                  if (err) throw err;
                  aPtFn();
                });
              });
            });
          });
          return;
        }
        that.handle_readPageRevision(iReq, iData);
      }
    });
  } ,

  unpatch: function(iOrig, iDiff) {
    this.patch(iOrig, iDiff, true);
  } ,

  patch: function(iOrig, iDiff, iUndo) {
    var aAdd = iDiff[iUndo ? 'del' : 'add'];
    var aDel = iDiff[iUndo ? 'add' : 'del'];
    if (aAdd.data)
      iOrig.data = aAdd.data; // project & page
    if (aAdd.layout) {      // page
      for (var a=0; a < aDel.layout.length; ++a) {
        for (var aI=0; iOrig.layout[aI].pid !== aDel.layout[a].pid; ++aI) {}
        iOrig.layout.splice(aI, 1);
      }
      for (var a=0; a < aAdd.layout.length; ++a)
        iOrig.layout.push(aAdd.layout[a]);
    }
  } ,

  sqlNewPart: "\
    BEGIN TRANSACTION;\
    "+kIncrOid+"; "+kNewOid+";\
    "+kIncrOid+"; "+kNewOid+";\
    COMMIT TRANSACTION;",

  newPart: { autogen:true },
  handle_newPart: function(iReq) {
    var that = this;
    var aNewOid = {};
    dbExec(this.db, this.sqlNewPart, function(stepErr, row) {
      if (stepErr) throw stepErr;
      if (row)
        if (aNewOid.a)
          aNewOid.b = row.oid;
        else
          aNewOid.a = row.oid;
    }, function() {
        //. log oids to verify writePart
        sRespond(iReq, aNewOid);
    });
  } ,

  _sendParts: function(iList, iIdx, iReq) {
    while (iIdx < iList.length && (!iList[iIdx].oid || iList[iIdx].outofband))
      ++iIdx;
    if (iIdx >= iList.length) {
      sProjects.processQueue(iReq.project);
      return;
    }
    var that = this;
    var aPath = iList[iIdx].oid.indexOf('_') >= 0 ? sRevisionCache+iList[iIdx].oid : getPath(iList[iIdx].oid);
    fs.stat(aPath+'.w', function(statErr, stats) {
      fs.readFile(statErr ? aPath : aPath+'.w', 'utf8', function(fileErr, buffer) {
        if (!fileErr)
          sRespond(iReq, {type:'update', id:iReq.id+'+', list:[{type:'part', oid:iList[iIdx].oid, data:buffer}]}, true);
        that._sendParts(iList, ++iIdx, iReq);
      });
    });
  } ,

  writePart: { autogen:true, page:true, part:true, data:true },
  handle_writePart: function(iReq) {
    var that = this;
    var aPath = makePath(iReq.part);
    var aMap = function() {
      fs.stat(aPath, function(statErr, stats) {
        if (!that.revisionMap.page[iReq.page])
          that.revisionMap.page[iReq.page] = {op:'.', touch:null, part:{}};
        if (!that.revisionMap.page[iReq.page].part[iReq.part])
          that.revisionMap.page[iReq.page].part[iReq.part] = {op:statErr ? '+' : '!', touch:null};
        that.revisionMap.page[iReq.page].part[iReq.part].touch = (new Date).toISOString();
        that.stmt.setRevisionMap.bind(1, JSON.stringify(that.revisionMap));
        that.stmt.setRevisionMap.step(function(stepErr, row) {
          if (stepErr) throw stepErr;
          that.stmt.setRevisionMap.reset();
          sClientCache.notify(iReq.client, {type:'part', oid:iReq.part, data:Buffer.isBuffer(iReq.data) ? null : iReq.data}, that.oid, iReq.page);
          sRespond(iReq, {status:'ok'});
        });
      });
    };
    if (iReq.data)
      fs.writeFile(aPath+'.w', iReq.data, 'utf8', function(fileErr) {
        if (fileErr) throw fileErr;
        aMap();
      });
    else
      aMap();
  } ,

  _makeDiffs: function(iRev, iBufList, iDiffList, iCallback) {
    var that = this;
    if (!that.stmt.insertDiff) {
      that.db.prepare("INSERT INTO diff VALUES ( ?, ?, ? )", function(err, stmt) {
        if (err) throw err;
        that.stmt.insertDiff = stmt;
        that.db.prepare("SELECT data, dataw, layout, layoutw FROM page WHERE oid = ?", function(err, stmt) {
          if (err) throw err;
          that.stmt.getPageData = stmt;
          that.db.prepare("UPDATE page SET\
                           data   = CASE WHEN dataw   IS NULL THEN data   ELSE dataw   END, dataw   = NULL,\
                           layout = CASE WHEN layoutw IS NULL THEN layout ELSE layoutw END, layoutw = NULL\
                           WHERE oid = ?", function(err, stmt) {
            if (err) throw err;
            that.stmt.resetPageData = stmt;
            that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
          });
        });
      });
      return;
    }
    if (iBufList && !iCallback.count) {
      var aFn = iCallback;
      iCallback = function() { if (--iCallback.count === 0) aFn(); };
      iCallback.count = 1;
    }
    for (var aPg in that.revisionMap.page) {
      if (that.revisionMap.page[aPg].done)
        continue;
      for (var aPt in that.revisionMap.page[aPg].part) {
        if (that.revisionMap.page[aPg].part[aPt].done)
          continue;
        var aPath = getPath(aPt, true);
        fs.stat(aPath, function(statErr, stats) {
          if (iBufList) {
            ++iCallback.count;
            xdDiff(!statErr && aPath, aPath+'.w', function(err, diff) {
              if (err) throw err;
              iBufList.push(diff);
              iDiffList.push({oid:aPt, size:diff.length, type:'part'});
              iCallback();
            });
          }
          if (statErr)
            return aInsert(null);
          xdDiff(aPath+'.w', aPath, function(err, diff) {
            if (err) throw err;
            aInsert(diff);
          });
          function aInsert(diff) {
            that.stmt.insertDiff.bind(1, aPt);
            that.stmt.insertDiff.bind(2, iRev);
            that.stmt.insertDiff.bind(3, diff);
            that.stmt.insertDiff.step(function(err, row) {
              if (err) throw err;
              that.stmt.insertDiff.reset();
              that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
            });
          }
        });
        that.revisionMap.page[aPg].part[aPt].done = true;
        return;
      }
      that.revisionMap.page[aPg].done = true;
      if (that.revisionMap.page[aPg].op !== '.') {
        that.stmt.getPageData.bind(1, aPg);
        that.stmt.getPageData.step(function(err, row) {
          if (err) throw err;
          that.stmt.getPageData.reset();
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
          that.stmt.insertDiff.bind(1, aPg);
          that.stmt.insertDiff.bind(2, iRev);
          that.stmt.insertDiff.bind(3, aDiff);
          that.stmt.insertDiff.step(function(err, row) {
            if (err) throw err;
            that.stmt.insertDiff.reset();
            that.stmt.resetPageData.bind(1, aPg);
            that.stmt.resetPageData.step(function(err, row) {
              if (err) throw err;
              that.stmt.resetPageData.reset();
              that._makeDiffs(iRev, iBufList, iDiffList, iCallback);
            });
          });
        });
        return;
      }
    }
    if (that.revisionMap.touch) {
      var aDiff;
      dbExec(that.db, "SELECT data, dataw FROM projects.project WHERE oid = '"+that.oid+"'", function(err, row) {
        if (err) throw err;
        if (row) aDiff = JSON.stringify({add:JSON.parse(row.dataw), del:JSON.parse(row.data||'{}')});
      }, function () {
        if (iBufList) {
          iBufList.push(aDiff);
          iDiffList.push({oid:that.oid, size:aDiff.length, type:'proj'});
        }
        that.stmt.insertDiff.bind(1, that.oid);
        that.stmt.insertDiff.bind(2, iRev);
        that.stmt.insertDiff.bind(3, aDiff);
        that.stmt.insertDiff.step(function(err, row) {
          if (err) throw err;
          that.stmt.insertDiff.reset();
          dbExec(that.db, "UPDATE projects.project SET data = dataw, dataw = NULL WHERE oid = '"+that.oid+"'", noOpCallback, iCallback);
        });
      });
    } else {
      iCallback();
    }
  } ,

  revisionMapInit: {touch:null, page:{}},
  revisionMapJson: function() {
    return JSON.stringify({touch:(new Date).toISOString(), page:{}});
  } ,

  commitRevision: { autogen:true },
  handle_commitRevision: function(iReq, iNoSendCallback) {
    if (!this.revisionMap.touch) {
      for (var any in this.revisionMap.page) break;
      if (!any)
        return sRespond(iReq, {status:'ok'});
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
    dbExec(that.db, aSql, function(err, row) {
      if (err) throw err;
      if (row) {
        aRev = row;
        aRev.oid = aRev.oid.slice(1);
        aRev.map = JSON.parse(aRev.map);
        aRev.parents = JSON.parse(aRev.parents);
        that.parentMap[sUUId] = +aRev.oid.slice(aRev.oid.indexOf('.')+1);
      }
    }, function () {
      if (iNoSendCallback)
        aFinish({});
      else
        that.getMembers(null, aFinish);
      function aFinish(list) {
        for (var aAny in list) break;
        var aBufList = aAny && [];
        aRev.list = aAny && [];
        that._makeDiffs(aRev.oid, aBufList, aRev.list, function() {
          aRev.type = 'revision';
          if (!aAny)
            return aCommit();
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
            aCommit(aRev, aRevData);
          });
        });
        function aCommit(rev, revdata) {
          dbExec(that.db, "UPDATE revision SET map = NULL, parents = '"+JSON.stringify(that.parentMap)+"' WHERE oid = ' ';\
                           RELEASE commit_revision;", noOpCallback, function () {
            if (iNoSendCallback)
              return iNoSendCallback(aRev);
            that._finishRevision(that.db, that.revisionMap, rev, revdata, function() {
              that.revisionMap = that.revisionMapInit;
              delete aRev.list;
              sClientCache.notify(iReq, aRev, that.oid);
            });
          });
        }
      }
    });
  } ,

  _finishRevision: function (iDb, iMap, iRev, iRevData, iCallback) {
    var that = this;
    if (iMap.page.sideline) {
      var aSide = iMap.page.sideline
      delete iMap.page.sideline;
      var aSetMap = ", map = '"+JSON.stringify(iMap)+"'";
      iMap.page.sideline = aSide;
    }
    var aExt = iMap.page.sideline ? '.new' : '.w';
    for (var aPg in iMap.page) {
      for (var aPt in iMap.page[aPg].part) {
        var aPath = getPath(aPt);
        if (sAttachments.open[aPt]) {
          dupFile(aPath+aExt, aPath, function(err) {
            if (err) throw err;
            that._finishRevision(iDb, iMap, iRev, iRevData, iCallback);
          });
        } else {
          var aCbCount = aPg === 'sideline' ? 2 : 1;
          if (aPg === 'sideline')
            fs.unlink(aPath+'.w', aCallback);
          fs.rename(aPath+aExt, aPath, aCallback);
          function aCallback(err) {
            if (err && err.errno !== process.ENOENT) throw err;
            if (--aCbCount === 0)
              syncFile(getParent(aPath), function(err) {
                if (err) throw err;
                that._finishRevision(iDb, iMap, iRev, iRevData, iCallback);
              });
          }
        }
        delete iMap.page[aPg].part[aPt];
        return;
      }
      delete iMap.page[aPg];
    }
    if (iRev)
      sServices.listPost(that.service, that.oid, iRev, iRevData, function() {
        fs.unlink(sSendDir+iRev.oid, noOpCallback);
        aUpdate();
      });
    else
      aUpdate();
    function aUpdate() {
      dbExec(iDb, "UPDATE revision SET oid = substr(oid, 2)"+(aSetMap||'')+" WHERE oid LIKE '!%'", noOpCallback, iCallback);
    }
  }

}; // Project.prototype

var sClientCache = {
  cl: {},

  drop: function(iClient, iProj, iPage) { // invoked by client
    delete (iPage ? this.cl[iClient].project[iProj][iPage] : this.cl[iClient].project[iProj]);
  } ,

  client: function(iClient, iConnection) {
    if (iConnection)
      this.cl[iClient] = { connection:iConnection, project:{} };
    else
      delete this.cl[iClient];
  } ,

  project: function(iClient, iProj) {
    if (!this.cl[iClient].project[iProj])
      this.cl[iClient].project[iProj] = {};
    this.cl[iClient].project[iProj].current = true;
  } ,

  page: function(iClient, iProj, iPage) {
    if (!this.cl[iClient].project[iProj][iPage])
      this.cl[iClient].project[iProj][iPage] = {};
    this.cl[iClient].project[iProj][iPage].current = true;
  } ,

  notify: function(iReqOrSkip, iData, iProj, iPage) {
    var aMsg = { type:'update', project:iProj, list: (iData instanceof Array ? iData : [iData]) };
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
      sProjects.processQueue(iReqOrSkip.project);
    }
  }

}; // sClientCache

function sRespond(iReq, iData, iNoCheck) {//. avoid overlap in iData members and response members
  if (iReq.response) {
    iReq.response.writeHead(200);
    iReq.response.end(iData.error || iData.status);
  } else if (iReq.connection) {
    if (!iData.id)
      iData.id = iReq.id;
    if (!iData.type)
      iData.type = iReq.type;
    if (iReq.project)
      iData.project = iReq.project;
    iReq.connection.send(JSON.stringify(iData));
  } else if (iReq.callback) {
    if (iData.error)
      throw new Error(iData.error);
    iReq.callback();
  }
  if (!iNoCheck)
    sProjects.processQueue(iReq.project);
}

// main
main();


/* cache mgmt
    client init - server clear cached list and send projects
    client resume - server send any objects marked changed in cached list unless reset
    server reset - client clear cache and init
    client unload - server clear object
*/

