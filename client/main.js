


var suae = {
  pMgr: null,
  pgEdit: null,
  paletteMgr: null,
  menus: null,

  apps: { },
  pendingParts: { },

  scrollbar: null,
  dragHandler: null,

  socket: null,
  requestId: 0,
  requestTimer: null,
  requestCount: 0,
  requestPending: { },
  clientId: document.cookie.slice(document.cookie.indexOf('anvlclient=')+11, 36+11),

  touched: {},
  touchTimer: null,

  services: null,
  invites: {},
  invitesLoaded: false,

  log: '',

  hrefOid: function(iHref) { return iHref.slice(iHref.indexOf(':')+1); } ,

  registerApp: function(iApp) {
    if (!iApp.kAppName)
      throw 'registerApp(): invalid app name';
    if (this.apps[iApp.kAppName])
      throw 'registerApp(): '+iApp.kAppName+' already registered';

    try {
    iApp.init();
    } catch (aEr) {
      throw iApp.kAppName +'.init(): '+ aEr;
    }

    this.apps[iApp.kAppName] = iApp;

    var aPg, aPt;
    for (aPg in this.pendingParts)
      for (aPt in this.pendingParts[aPg])
        if (this.pendingParts[aPg][aPt] === iApp.kAppName) {
          suae.pMgr.placePartById(aPg, aPt);
          delete this.pendingParts[aPg][aPt];
        }
  } ,

  lookupApp: function(iName) {
    return this.apps[iName] ? this.apps[iName] : null;
  } ,

  loadAppForPart: function(iName, iPgOid, iPtOid) {
    if (this.apps[iName])
      throw 'loadAppForPart(): App '+iName+' already loaded';

    if (!this.pendingParts[iPgOid])
      this.pendingParts[iPgOid] = { };
    this.pendingParts[iPgOid][iPtOid] = iName;

    if (document.getElementById('suaeapp.'+iName))
      return;
    var aEl = document.createElement('script');
    aEl.id = 'suaeapp.'+iName;
    aEl.type = 'text/javascript';
    aEl.src = iName+'.js';
    document.getElementsByTagName('head')[0].appendChild(aEl);
  } ,

  touch: function(iJso, iData) {
    var aId;
    switch (iJso.type) {
    case 'setClientNav':
      aId = '#clientNav';
      break;
    case 'setClientState':
      aId = iJso.project+'.state';
      break;
    case 'write':
      aId = iJso.project;
      break;
    case 'writePage':
      aId = iJso.page;
      break;
    case 'writePart':
      if (typeof iData !== 'string')
        throw 'touch(): Part object requires data parameter';
      suae.pMgr.pj[iJso.project].part[iJso.part].data = iJso.data = iData;
      aId = iJso.part;
      break;
    default:
      throw 'touch(): Input is not a writeable object';
    }
    if (!this.touched[aId])
      this.touched[aId] = iJso;
    if (!this.touchTimer)
      this.touchTimer = setTimeout(this._saveTouched, 30000, null);
  } ,

  touchFlush: function(iCallback) {
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this._saveTouched(iCallback);
    } else if (iCallback)
      iCallback();
  } ,

  _saveTouched: function(iCallback) {
    suae.touchTimer = null;
    var aCount = 0;
    var aDone = function(jso) {
      if (--aCount === 0 && iCallback)
        iCallback();
      if (jso.status !== 'ok')
        throw 'saveTouchCall(): unexpected response to write request';
    };
    for (var a in suae.touched) {
      if (!suae.touched[a])
        continue;
      ++aCount;
      suae.request(suae.touched[a], aDone);
      suae.touched[a] = null;
    }
  } ,

  areEqual: function(iA, iB) {
    if (iA.constructor !== iB.constructor)
      return false;
    var aMemberCount = 0;
    for (var a in iA) {
      if (!iA.hasOwnProperty(a))
        continue;
      if (typeof iA[a] === 'object' && typeof iB[a] === 'object' ? !this.areEqual(iA[a], iB[a]) : iA[a] !== iB[a])
        return false;
      ++aMemberCount;
    }
    for (var a in iB)
      if (iB.hasOwnProperty(a))
        --aMemberCount;
    return aMemberCount ? false : true;
  } ,

  request: function(iJso, iCallback) {
    iJso.id = ++this.requestId;
    this.requestPending[this.requestId] = iCallback;
    this.socket.send(JSON.stringify(iJso));
    if (this.requestTimer)
      clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(this._onTimeout, 6000);
    ++this.requestCount;
  } ,

  _onMessage: function(iMsg) {
    try {
    var aJso = JSON.parse(iMsg);
    } catch (err) {
      return;
    }
    if (aJso.error)
      throw aJso.error;
    if (aJso.type === 'update')
      suae.pMgr.update(aJso);
    var aCall = suae.requestPending[aJso.id];
    if (aCall) {
      if (--suae.requestCount === 0) {
        clearTimeout(suae.requestTimer);
        suae.requestTimer = null;
      }
      delete suae.requestPending[aJso.id];
      aCall(aJso);
    }
  } ,

  _onTimeout: function() {
    alert('server not responding');
  } ,

  _onDisconnect: function() {
    suae.socket.connect(); //. dim screen and let user reconnect
  } ,

  start: function () {
    document.addEventListener('keydown', function(iEvt) { if (iEvt.keyCode === 27) iEvt.preventDefault(); }, true);

    this.paletteMgr.init();

    for (var a in suae.menus)
      suae.menus[a] = suae.paletteMgr.embed(suae.menus[a], document.getElementById('suaemenu.'+a), suae.pMgr);

    io.setPath("/socket.io/");
    this.socket = new io.Socket(location.hostname, {port:location.port, transports:['xhr-multipart']});
    this.socket.on('message', this._onMessage);
    this.socket.on('disconnect', this._onDisconnect);
    this.socket.connect();

    this.pMgr.init();
    window.onbeforeunload = function() {
      suae.touchFlush();
    };
  }
};

suae.Index = function(iTxtSrc, iSpec) {
  for (var a in iSpec)
    iSpec[a] = { order:iSpec[a].charAt(0), type:iSpec[a].slice(1), o:[] };
  this.textsource = iTxtSrc;
  this.text = {};
  this.sort = iSpec;
};

suae.Index.prototype = {

  add: function(iId, iJso) {
    for (var aI in this.sort) {
      if (!(aI in iJso))
        throw new Error('Index.add(): input missing member '+aI);
      var aNum = this.sort[aI].type === 'num';
      var aUp = this.sort[aI].order === '+';
      var aKey = iJso[aI];
      aKey = aNum ? +aKey : aKey === null ? '' : aKey.toLocaleLowerCase();
      for (var aO=0; aO < this.sort[aI].o.length; ++aO) {
        var aNextKey = this.sort[aI].o[aO].key;
        if (aNum)
          aNextKey = +aNextKey;
        if (aUp ? aKey < aNextKey : aKey >= aNextKey)
          break;
      }
      //. eventually do a binary search
      var aX = {id:iId, key:aKey};
      if (aO < this.sort[aI].o.length)
        this.sort[aI].o.splice(aO, 0, aX);
      else
        this.sort[aI].o.push(aX);
    }
    if (!(this.textsource in iJso))
      throw new Error('Index.add(): input missing member '+this.textsource);
    this.text[iId] = iJso[this.textsource];
  } ,

  remove: function(iId) {
    for (var aI in this.sort)
      for (var aO=0; aO < this.sort[aI].o.length; ++aO)
        if (this.sort[aI].o[aO].id === iId)
          this.sort[aI].o.splice(aO--, 1);
    delete this.text[iId];
  } ,

  find: function(iSort, iId) {
    for (var aO=0; aO < this.sort[iSort].o.length && this.sort[iSort].o[aO].id !== iId; ++aO) {}
    return aO < this.sort[iSort].o.length ? {pos:aO, key:this.sort[iSort].o[aO].key, text:this.text[iId]} : null;
  } ,

  getList: function(iSort) {
    return this.sort[iSort].o;
  }

};

suae.menus = {
  tools: '\
    <div class="palgrid" name="tool" style="position:static;" cellclass="palgridrow" cellstyle="width:7em; height:16px;">\
      <div value="textEdit">Text</div>\
      <div value="imageEdit_">Image</div>\
      <div value="attachEdit_">Attachment</div>\
      <div value="noteEdit">Note/Chat</div>\
      <div value="paletteEdit">Palette</div>\
      <div value="myEdit">Example</div>\
    </div>' ,
  layout: '\
    <size h="140px"></size>\
    <div class="palbutton" name="knobs" style="position:static; width:7em; height:16px;">Hide Knobs</div>' ,
  page: '\
    <div class="palmenu" name="pgsort" cellstyle="height:16px;" style="position:static; width:4em; height:16px;">\
      <div value="name">named</div>\
      <div value="added">added</div>\
    </div>\
    <div class="palbutton" name="pagenew" style="top:4px; right:5px; height:16px;">new</div>\
    <div class="palpanel" name="pages" style="position:static; margin-top:15px; width:100%; border-width:0;">\
      <div class="palsubpanel" name="pagename">\
        <div class="palgrid" name="pagenamelist" style="position:static; cursor:pointer;" cellclass="palgridrow" cellstyle="width:7em; height:16px;">\
          <div value="oid">page</div></div>\
      </div><div class="palsubpanel" name="pageadded">\
        <div class="palgrid" name="pageaddedlist" style="position:static; cursor:pointer;" cellclass="palgridrow" cellstyle="width:7em; height:16px;">\
          <div value="oid">page</div></div>\
      </div></div>' ,
  circ: '\
    <div class="palbutton" name="send" style="position:static; height: 16px; width: 7em;">x revision</div>\
    <div class="palpanel" name="service" style="border-style: none; overflow:visible; top: 33px; left: 6px; width: 8em; height: 26px;">\
      <div class="palsubpanel" name="havesvc">\
        <div class="palmenu" name="svc" cellstyle="min-width:3em; height:16px;" style="top: 0pt; left: 1px; height: 16px; width: 7em;">\
          <div value="tbd">Select Service</div></div></div>\
      <div class="palsubpanel" name="needsvc">\
        <div class="palhtml" name="svclink" style="top: 0pt; left: 5px;">\
          <div value="one"><a href="suae:signup" onclick="suae.pMgr.goProj(\'#autogen.00000\', \'#autogen.00020\'); return false">Signup</a></div></div></div>\
    </div>\
    <div class="palmenu" name="svcalias" cellstyle="min-width:3em; height:16px;" style="top:66px; left:8px; height:16px; width:7em;">\
      <div value=" ">Select Alias</div></div></div>\
    <div class="paltext" name="newmember" style="top:99px; left: 8px; width: 8em;">Add Member</div>\
    <div class="palhtml" name="members" style="position: static; margin-top: 90px; width: 100%;">\
      <div value="one"><a href="suae:try" onclick="suae.pMgr.goProj(\'#users\'); return false">One Link</a></div>\
    </div>' ,
  proj: '\
    <div class="palbutton" name="revhistory" style="position:static; height: 16px; width: 7em;">Rev. History </div>\
    <div class="palbutton" name="names" style="position:static; height:16px; width:7em; margin: 2px 0;">Titles</div>\
    <div class="pallabel" name="publish" style="position:static">Publishing   </div>\
    <div class="pallabel" name="publicz" style="position:static">Publicize    </div>\
    <div class="palbutton" name="msglog" style="position:static; height:16px; width:7em;">Message Log</div>' ,
  help: '\
    <div class="pallabel" name="popups" style="position:static">Popup Docs  </div>\
    <div class="pallabel" name="tutors" style="position:static">Tutorials   </div>\
    <div class="pallabel" name="usrfor" style="position:static">User Forum  </div>\
    <div class="pallabel" name="supprt" style="position:static">Get Support </div>' ,
  suae: '\
    <div class="palbutton" name="x" style="position:static; float:right; height:1em; width:1em">&#x00d7;</div>\
    <div class="palbutton" name="x" style="position:static; float:right; height:1em; width:1em">&#x25a1;</div>\
    <div class="palbutton" name="x" style="position:static; float:right; height:1em; width:1em">&#x2212;</div>\
    <div class="pallabel" name="x" style="position:static; margin:36px 0 0 0;">Settings </div>\
    <div class="palbutton" name="cleardb" style="position:static; margin:4px 0 0 0;">Clear DB</div>' ,
  nav: '\
    <size w="100%" h="70px"></size>\
    <div class="palbutton" name="pjback" style="top:3px; left:3px; width:25px; height:25px; font-size:150%; -moz-border-radius:40% 0 0 40%;">&lt;</div>\
      <div class="palbutton" name="pjforw" style="top:8px; left:36px; width:15px; height:15px; -moz-border-radius:0 40% 40% 0;">&gt;</div>\
    <div class="palmenu" name="pjsort" cellstyle="height:16px;" style="top: 41px; left: 3px; width: 5em; height: 16px;">\
      <div value="name">named</div>\
      <div value="created">created</div>\
    </div>\
    <div class="palbutton" name="pjnew" style="top: 41px; left: 132px; height: 16px; width: 2.5em;">new</div>\
    <div class="palpanel" name="navbar" style="top:70px; left:0; width:100%; border-width:0; font-size:111%;">\
      <div class="palsubpanel" name="navname">\
        <div class="palgrid" name="navnamelist" style="position:static;" cellclass="palgridrow" tag="navbaritem"><div value="nil">nil</div></div>\
      </div><div class="palsubpanel" name="navcreated">\
        <div class="palgrid" name="navcreatedlist" style="position:static;" cellclass="palgridrow" tag="navbaritem"><div value="nil">nil</div></div>\
      </div></div>' ,
  welcome: '\
    <div class="palpanel" name="startpanel" style="position:static; border-style:none;">\
    <div class="palsubpanel" name="startinterrupt">\
      <div class="pallabel" name="interrupttext" style="position:static">Sync in Progress. You can cancel to access your data, but must start the sync over.</div>\
      <div class="palbutton" name="interrupt" style="position:static; margin-top:1em; width:40%;">Cancel</div>\
    </div><div class="palsubpanel" name="startwelcome">\
      <div class="pallabel" name="text" style="position:static; float:left; width:55%; margin-bottom:2em;">\
        <b>Welcome to Elembe.</b><br/><br/>\
        If you\'re a first-time user, choose Start Fresh.<br/><br/>\
        To link this unit to an existing one, choose Link to Existing.</div>\
      <div class="palbutton" name="fresh" style="position:static; float:right; width:40%; margin-top:2em;">Start Fresh</div>\
      <div class="palbutton" name="link"  style="position:static; float:right; width:40%; margin-top:1em;">Link to Existing</div>\
      <div class="palpanel" name="welcomepanel" style="position:static; clear:both; padding:1em; border-style:none;">\
        <div class="palsubpanel" name="welcomefresh">\
          <div class="pallabel"  name="freshgen"   style="position:static; text-align:center;">Generating Database...</div>\
        </div><div class="palsubpanel" name="welcomelink">\
          <div class="pallabel"  name="linkhostl"   style="position:static; width:40%; float:left;">Hostname</div>\
          <div class="paltext"   name="linkhost"    style="position:static; width:50%;"></div>\
          <div class="pallabel"  name="linkssidl"   style="position:static; width:40%; float:left;">SSID</div>\
          <div class="paltext"   name="linkssid"    style="position:static; width:50%; margin-top:0.5em;"></div>\
          <div class="pallabel"  name="linkkeyl"    style="position:static; width:40%; float:left;">Password</div>\
          <div class="paltext"   name="linkkey"     style="position:static; width:50%; margin-top:0.5em;"></div>\
          <div class="pallabel"  name="linkmessage" style="position:static; width:25%; float:left; margin-top:1em; padding:0.2em; border: 1px solid #aaa;">&nbsp;</div>\
          <div class="palbutton" name="linkgo"      style="position:static; width:35%; float:left; margin:1em;">Retrieve Database</div>\
          <div class="palbutton" name="linkstop"    style="position:static; width:20%; float:left; margin:1em;">Cancel</div>\
        </div></div>\
    </div></div>'
};

suae.pMgr = {
  navState: null,
  navUpdate: { type:'setClientNav', data:null },
  projIndex: null,
  userIndex: null,

  pj: { },      // projects list
  pjCurr: null,  // user-selected project

  menuTmpl: null,    // node template for page menu

  kUserOnclick: "suae.pMgr.goUser(suae.hrefOid(this.href)); return false;",

  kRevPanelSpec: '<size w="250px" h="600px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">Revision History</div>\
    <div class="palhtml" name="revcurr" style="top:25px; left:5px;">\
      <div value="link"><a href="suae:current" onclick="suae.pMgr.markRevision(null); suae.pMgr.goRev(suae.pMgr.pjCurr.curr, null); return false;">Current</a></div></div>\
    <div class="palscroll" style="top:50px; left:0; width:96%; height:550px;">\
      <div class="palhtml" name="revlist" order="-"></div></div>',

  kMsgPanelSpec: '<size w="300px" h="600px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">Message History</div>\
    <div class="palhtml" name="msglist" order="-" style="position:static; margin:25px 5px 0;"></div>\
    <div class="palbutton" name="msglistPrevBtn" style="position:static; width:100px; margin:10px 5px 0 auto;">Previous</div>\
    <div class="palhtml" name="msglistPrev" style="position:static; margin:10px 5px"></div>',

  kNamesPalSpec: '<size w="250px" h="210px"></size>\
    <div class="pallabel" name="title" style="top: 10px; left: 10px;">Page Name</div>\
    <div class="pallabel" name="pgname" style="top: 35px; left: 25px;">pagename</div>\
    <div class="paltext" name="pgtext" style="top: 65px; left: 25px; width: 195px;"></div>\
    <div class="pallabel" name="auto1" style="top: 110px; left: 10px;">Project Name</div>\
    <div class="pallabel" name="pjname" style="top: 135px; left: 25px;">projectname</div>\
    <div class="paltext" name="pjtext" style="top: 165px; left: 25px; width: 195px;"></div>' ,

  init: function() {
    var that = this;
    suae.request({type:'getClientNav'}, function(jso) {
      if (jso.screen === 'welcome') {
        suae.menus.welcome.showPanel('startwelcome');
        suae.menus.welcome.enable('linkstop', jso.state !== 'new');
        if (jso.state !== 'new') {
          suae.menus.welcome.showPanel(jso.state === 'autogen' ? 'welcomefresh' : 'welcomelink');
          if (jso.state !== 'autogen') {
            that.linkhost = jso.host.host;
            suae.menus.welcome.setValue('linkhost', jso.host.host);
            suae.menus.welcome.setValue('linkssid', jso.host.ssid);
            suae.menus.welcome.setValue('linkkey', jso.host.password);
            if (jso.state === 'syncPause')
              suae.menus.welcome.setValue('linkgo', 'Resume Retrieval');
            else
              suae.menus.welcome.enable('linkgo', false);
          }
        }
        return;
      } else if (jso.screen === 'interrupt') {
        suae.menus.welcome.showPanel('startinterrupt');
        return;
      }

      that.pgInit();
      suae.menus.welcome = null; //. other cleanup necessary?
      that.projIndex = new suae.Index('name', {name:'+str', created:'-str'});
      that.menuTmpl = suae.menus.page.getWidgetByName('pages');
      //.this.userIndex = suae.read('userindex');

      that.navState = that.navUpdate.data = jso.data;

      suae.request({type:'getList'}, function(jso) {
        for (var a=0; a < jso.list.length; ++a)
          that.projIndex.add(jso.list[a].oid, jso.list[a].data);
        for (var aI in that.projIndex.sort) {
          var aName = 'nav'+ aI +'list';
          suae.menus.nav.listDelete(aName, null);
          var aList = that.projIndex.getList(aI);
          for (var aP=0; aP < aList.length; ++aP)
            suae.menus.nav.listSet(aName, aList[aP].id, that.projIndex.text[aList[aP].id]);
        }
        suae.menus.nav.showPanel('nav'+ that.navState.sort);
        suae.menus.nav.setValue('pjsort', that.navState.sort);

        suae.request({type:'subscribeServices'}, function(jso) {
          suae.services = jso.data;
          var aHave = false;
          for (var a in suae.services) {
            if (suae.services[a].joined === 'no')
              continue;
            suae.menus.circ.listSet('svc', a, a);
            aHave = true;
          }
          suae.menus.circ.showPanel(aHave ? 'havesvc' : 'needsvc');

          that.goHistory(that.navState.history.n -1);
        });
      });
    });
  } ,

  update: function(iJso) {
    if (iJso.project && !this.pj[iJso.project])
      return;
    for (var a=0; a < iJso.list.length; ++a) {
      switch (iJso.list[a].type) {
      case 'autogen':
        this.init();
        break;
      case 'linkprogress':
        suae.menus.welcome.setValue('linkmessage', iJso.list[a].ratio ? (iJso.list[a].ratio*100).toFixed(2)+'%' : iJso.list[a].message);
        if (iJso.list[a].message === 'complete') {
          this.init();
          break;
        }
        var aDisconn = iJso.list[a].message === 'disconnected';
        var aBusy    = iJso.list[a].message === 'host busy';
        var aExpire  = iJso.list[a].message === 'session expired';
        var aCancel  = iJso.list[a].message === 'canceling';
        suae.menus.welcome.enable('linkgo', aDisconn || aBusy);
        suae.menus.welcome.enable('linkstop', !aBusy && !aCancel);
        if (aDisconn || aBusy)
          suae.menus.welcome.setValue('linkgo', aDisconn ? 'Resume Retrieval' : 'Retrieve Database');
        break;
      case 'restart':
        suae.touchFlush(function() {
          location.reload();
        });
        break;
      case 'services':
        for (var aS in iJso.list[a].list) {
          var aNewAlias = !(aS in suae.services) || suae.services[aS].aliases !== iJso.list[a].list[aS].aliases;
          suae.services[aS] = iJso.list[a].list[aS];
          if (suae.services[aS].joined !== 'no') {
            suae.menus.circ.showPanel('havesvc');
            suae.menus.circ.listSet('svc', aS, aS);
          }
          if (this.pjCurr.service === aS && aNewAlias)
            this.enableMember(true);
        }
        var aApp = suae.lookupApp('serviceEdit');
        if (aApp)
          aApp.update(iJso.list[a].list);
        break;
      case 'setservice':
        this.pj[iJso.project].service = iJso.list[a].service;
        if (this.pjCurr.oid === iJso.project)
          this.enableMember(true);
        break;
      case 'setuseralias':
        this.pj[iJso.project].useralias = iJso.list[a].alias;
        if (this.pjCurr.oid === iJso.project)
          this.enableMember(true, true);
        break;
      case 'invite':
        delete iJso.list[a].type;
        suae.invites[iJso.list[a].oid] = iJso.list[a];
        var aApp = suae.lookupApp('inviteEdit');
        if (aApp)
          aApp.update(iJso.list[a]);
        break;
      case 'acceptinvite':
        suae.invites[iJso.list[a].oid].accept = iJso.list[a].accept;
        var aApp = suae.lookupApp('inviteEdit');
        if (aApp)
          aApp.update();
        break;
      case 'project':
        this.updateNavPanels(iJso.list[a]);
        break;
      case 'projectdata':
        this.updateNavPanels(iJso.list[a], true);
        if (this.pj[iJso.list[a].oid]) {
          this.pj[iJso.list[a].oid].update.data = iJso.list[a].data;
          if (this.pjCurr.oid === iJso.list[a].oid)
            this.pjCurr.namesPal.setValue('pjname', this.pjCurr.update.data.name);
        }
        break;
      case 'page':
        this.updatePagePanels(iJso.project, iJso.list[a]);
        break;
      case 'pagelayout':
        if (iJso.list[a].data)
          this.updatePagePanels(iJso.project, iJso.list[a], true);
        if (iJso.list[a].layout) {
          var aPage = this.pj[iJso.project].page[iJso.list[a].oid];
          if (aPage)
            this.updateLayout(aPage, iJso.list[a].layout);
        }
        break;
      case 'part':
        if (!this.pj[iJso.project].part[iJso.list[a].oid])
          this.pj[iJso.project].part[iJso.list[a].oid] = { data:null, instance:{} };
        this.pj[iJso.project].part[iJso.list[a].oid].data = iJso.list[a].data;
        for (var aPt in this.pj[iJso.project].part[iJso.list[a].oid].instance) {
          var aApp = this.pj[iJso.project].part[iJso.list[a].oid].instance[aPt];
          var aId = aPt.split('|');
          try {
          aApp.update(aId[0], aId[1], this.pj[iJso.project].part[iJso.list[a].oid].data);
          } catch (aEr) {
            this.postMsg('App error: '+aApp.kAppName+'.update() '+aEr);
          }
        }
        break;
      case 'memberalias':
        var aAlias = this.pj[iJso.project].userindex.find('uid', iJso.list[a].alias) && iJso.list[a].alias;
        this.pj[iJso.project].userindex.remove(aAlias || iJso.list[a].uid);
        this.pj[iJso.project].confirmedMembers += iJso.list[a].left ? -1 : +('uid' in iJso.list[a] && aAlias !== null);
        this.pj[iJso.project].userindex.add(iJso.list[a].uid || iJso.list[a].alias, iJso.list[a]);
        if (this.pjCurr === this.pj[iJso.project]) {
          if (aAlias || iJso.list[a].uid)
            suae.menus.circ.listDelete('members', aAlias || iJso.list[a].uid);
          this.listMember(iJso.list[a].uid || iJso.list[a].alias);
          suae.menus.circ.setValue('send', this.pjCurr.confirmedMembers > 1 ? 'send revision' : 'file revision');
          suae.menus.circ.enable('svc', this.pjCurr.userindex.getList('alias').length === 0);
        }
        break;
      case 'revision'://. need state for rev
        this.addRevision(this.pj[iJso.project], iJso.list[a]);
        var aRevMap = iJso.list[a].map;
        break;
      case 'revisionsideline':
        this.sidelineRevision(this.pj[iJso.project], iJso.list[a].oid);
        break;
      case 'message':
        var aMsg = '<div class="msgpanelitem">'+ iJso.list[a].html +'<span class="msgpaneldate">@'+ iJso.list[a].date +'</span></div>';
        this.pj[iJso.project].msgPanel.listSet('msglist', this.pj[iJso.project].msgPanelNext++, aMsg);
        break;
      default:
        alert('unknown update type: '+iJso.list[a].type);
      }
    }
    if (aRevMap) {
      for (var a in aRevMap.page)
        suae.pMgr.revisePage(this.pj[iJso.project], a);
    }
  } ,

  touchState: function(iJso) {
    var aState = this.pjCurr.stateUpdate.data;
    switch (iJso.type) {
    case 'projstate':
      break;
    case 'page':
      if (!aState.page[iJso.oid])
        aState.page[iJso.oid] = {};
      if (aState.page[iJso.oid][iJso.rev] !== iJso) {
        if (aState.page[iJso.oid][iJso.rev])
          iJso.part = aState.page[iJso.oid][iJso.rev].part;
        aState.page[iJso.oid][iJso.rev] = iJso;
      }
      break;
    case 'part':
      var aRev = this.pjCurr.currRev || ' ';
      if (!aState.page[this.pjCurr.curr])
        aState.page[this.pjCurr.curr] = {};
      if (!aState.page[this.pjCurr.curr][aRev])
        aState.page[this.pjCurr.curr][aRev] = {type:'page', oid:this.pjCurr.curr, rev:aRev, focus:null, scroll:{}, part:{}};
      if (!aState.page[this.pjCurr.curr][aRev].part[iJso.oid])
        aState.page[this.pjCurr.curr][aRev].part[iJso.oid] = iJso;
      break;
    default:
      throw 'touchState(): Unknown tag name "'+ iJso.type +'"';
    }
    suae.touch(this.pjCurr.stateUpdate);
  } ,

  newProj: function() {
    var that = this;
    suae.request({type:'newProject'}, function(update) {
      that.goProj(update.list[0].oid);
    });
  } ,

  updateNavPanels: function(iJso, iReplace) {
    this.updatePagePanels(null, iJso, iReplace);
  } ,

  updatePagePanels: function(iProjOid, iJso, iReplace) {
    var aIdx = !iProjOid ? this.projIndex : this.pj[iProjOid].pageindex;
    var aId = iJso.oid || iJso.project;
    if (iReplace)
      aIdx.remove(aId);
    aIdx.add(aId, iJso.data);
    var aSet = iProjOid ? 'page' : 'nav';
    var aPal = !iProjOid || iProjOid === this.pjCurr.oid ? suae.menus[aSet] : this.pj[iProjOid].altPalette;
    if (aPal !== suae.menus[aSet])
      aPal.appendWidget(this.pj[iProjOid].menu);
    for (var aI in aIdx.sort) {
      var aName = aSet + aI +'list';
      aPal.listSet(aName, aId, iJso.data.name);
      aPal.listMove(aName, aId, aIdx.find(aI, aId).pos);
    }
  } ,

  getMsgList: function() {
    var aProj = this.pjCurr;
    aProj.msgPanel.enable('msglistPrevBtn', false);
    suae.request({type:'getMsgList', project:aProj.oid}, function(jso) {
      for (var a=aProj.msgPanelNext; a < jso.list.length; ++a)
        aProj.msgPanel.listSet('msglistPrev', a.toString(),
          '<div class="msgpanelitem">'+ jso.list[a].html +'<span class="msgpaneldate">@'+ jso.list[a].date +'</span></div>');
    });
  } ,

  postMsg: function(iText) {
    var aProj = this.pjCurr, that = this;
    suae.request({type:'postMsg', project:this.pjCurr.oid, msg:iText}, function(jso) {
      if (that.pjCurr === aProj)
        aProj.msgPanel.show();
    });
  } ,

  markRevision: function(iDiv) {
    if (this.pjCurr.revLink) {
      this.pjCurr.revLink.style.backgroundColor = null;
      this.pjCurr.revLink.parentNode.style.borderWidth = null;
      this.pjCurr.revLink.parentNode.style.padding = null;
    }
    if (iDiv) {
      iDiv.style.backgroundColor = '#ddf';
      iDiv.parentNode.style.borderWidth = '3px';
      iDiv.parentNode.style.padding = '1px';
    }
    this.pjCurr.revLink = iDiv;
  } ,

  sidelineRevision: function(iProj, iRevId) {
    var aEl = iProj.revPanel.listGet('revlist', iRevId);
    if (aEl)
      aEl.setAttribute('tag', 'sideline');
  } ,

  addRevision: function(iProj, iRev) {
    var aHtml = '<div class="revpanelrev"'+ (iRev.sideline ? ' tag="sideline"' : '') +'>'+ iRev.date;

    for (var aPg in iRev.map.page) {
      var aClik = "suae.pMgr.markRevision(this.parentNode); suae.pMgr.goRev('"+ aPg +"','"+ iRev.oid +"'); return false;";
      aHtml += '<div><a href="suae:'+ iRev.oid +'" onclick="'+ aClik +'">'+ iProj.pageindex.find('name', aPg).text
        +'</a> @ '+ iRev.map.page[aPg].touch;

      for (var aPt in iRev.map.page[aPg].part) {
        aHtml += '<div style="margin-left:2em">'+ iRev.map.page[aPg].part[aPt].op +' '+ iRev.map.page[aPg].part[aPt].class
          +' @ '+ iRev.map.page[aPg].part[aPt].touch +'</div>';
      }
      aHtml += '</div>'
    }
    aHtml += '</div>'
    iProj.revPanel.listSet('revlist', iRev.oid, aHtml);
  } ,

  goProj: function(iOid, iPage) {
    if (this.pjCurr === this.pj[iOid]) {
      if (iPage)
        this.goPage(iPage, true);
      return;
    }

    if (!this.pj[iOid]) {
      this.pj[iOid] = {
        oid: null,
        service: null,
        useralias: null,
        confirmedMembers: 0,
        update: {type:'write', project:iOid, data:null},
        stateUpdate: {type:'setClientState', project:iOid, data:null},
        curr: null,
        currRev: null,
        userindex: new suae.Index('alias', {alias:'+str', joined:'-str', left:'-str', uid:'+str'}),
        pageindex: new suae.Index('name', {name:'+str', added:'-str'}),
        menu: this.menuTmpl.cloneNode(true),
        altPalette: suae.paletteMgr.create('', 0, 0, this),
        revPanel: suae.paletteMgr.create(this.kRevPanelSpec, 250, 600, this),
        msgPanel: suae.paletteMgr.create(this.kMsgPanelSpec, 5, 5, this),
        msgPanelNext: 0,
        namesPal: suae.paletteMgr.create(this.kNamesPalSpec, 40, 300, this),
        page: {},
        part: {},
        lastAccess: new Date
      };
      this.loading = iOid;
      var that = this;
      suae.request({type:'subscribe', project:iOid}, function(jso) {
        that.pj[iOid].oid = iOid;
        that.pj[iOid].service = jso.service;
        that.pj[iOid].update.data = jso.data;
        for (var a=0; a < jso.page.length; ++a)
          that.pj[iOid].pageindex.add(jso.page[a].oid, jso.page[a].data);
        for (var a=0; a < jso.member.length; ++a) {
          that.pj[iOid].confirmedMembers += jso.member[a].uid ? 1 : 0;
          if (jso.member[a].useralias)
            that.pj[iOid].useralias = jso.member[a].alias;
          else
            that.pj[iOid].userindex.add(jso.member[a].alias, jso.member[a]);
        }
        for (var a=0; a < jso.revision.length; ++a)
          that.addRevision(that.pj[iOid], jso.revision[a]);
        var aIi = that.pj[iOid].pageindex.getList('name');
        that.pj[iOid].stateUpdate.data = jso.state || {type:'projstate', select:{sort:'name', page:aIi.length ? aIi[0].id : ''}, page:{}};
        if (that.loading === iOid)
          that.goProj(iOid, iPage);
      });
      return;
    }
    if (!this.pj[iOid].oid) {
      this.loading = iOid;
      return;
    }

    this.loading = null;
    this.pjCurr = this.pj[iOid];

    suae.menus.nav.setValue('nav'+ this.navState.sort +'list', iOid);

    suae.menus.page.removeWidget('pages');
    suae.menus.page.appendWidget(this.pjCurr.menu);
    if (this.pjCurr.curr === null) {
      this.pjCurr.curr = this.pjCurr.stateUpdate.data.select.page;
      for (var aI in this.pjCurr.pageindex.sort) {
        var aListN = 'page'+ aI +'list';
        suae.menus.page.listDelete(aListN, null);
        var aList = this.pjCurr.pageindex.getList(aI);
        for (var aO=0; aO < aList.length; ++aO)
          suae.menus.page.listSet(aListN, aList[aO].id, this.pjCurr.pageindex.text[aList[aO].id]);
      }
      suae.menus.page.setValue('pgsort', this.pjCurr.stateUpdate.data.select.sort);
      suae.menus.page.showPanel('page'+ this.pjCurr.stateUpdate.data.select.sort);
    }
    var aEditable = ! /^#autogen/.test(this.pjCurr.oid);
    var aList = this.pjCurr.userindex.getList('joined');
    suae.menus.circ.setValue('send', this.pjCurr.confirmedMembers > 1 ? 'send revision' : 'file revision');
    suae.menus.circ.setValue('svc', aEditable ? this.pjCurr.service || 'tbd' : null);
    suae.menus.circ.enable('svc', aEditable && aList.length === 0);
    this.enableMember(aEditable);
    suae.menus.circ.listDelete('members', null);
    for (var a=0; a < aList.length; ++a)
      this.listMember(aList[a].id);

    this.enableEdit(aEditable && !this.pjCurr.currRev);

    suae.menus.proj.enable('revhistory', aEditable);
    suae.menus.proj.enable('names', aEditable);

    if (this.pjCurr.currRev)
      this.pjCurr.revPanel.show();

    var aPage = iPage || this.pjCurr.curr;
    this.pjCurr.curr = null;  // so goPage takes our order
    this.goPage(aPage, !!iPage);
  } ,

  enableMember: function(iState, iMemOnly) {
    if (!iMemOnly) {
      suae.menus.circ.listDelete('svcalias', null);
      if (iState && this.pjCurr.service) {
        var aList = suae.services[this.pjCurr.service].aliases.split(' ');
        for (var a=0; a < aList.length; ++a) {
          suae.menus.circ.listSet('svcalias', aList[a], aList[a]);
          var aUseralias = aUseralias || aList[a] === this.pjCurr.useralias;
        }
      }
      suae.menus.circ.enable('svcalias', aList && aList.length);
    }
    suae.menus.circ.setValue('svcalias', iMemOnly || aUseralias ? this.pjCurr.useralias : null);
    suae.menus.circ.setValue('newmember', iMemOnly || aUseralias ? 'Add Member' : '');
    suae.menus.circ.enable('newmember', iMemOnly || aUseralias);
  } ,

  enableEdit: function(iState) {
    suae.menus.circ.enable('send', iState);
    suae.menus.page.enable('pagenew', iState);
    suae.menus.tools.enable('tool', iState);

    var aList = document.styleSheets[0].cssRules;
    for (var a=0; a < aList.length; ++a)
      if (aList[a].selectorText === '.partknob') {
        aList[a].style.display = iState ? null : 'none';
        break;
      }
  } ,

  newPage: function() {
    var that = this;
    var aProj = this.pjCurr;
    suae.request({type:'newPage', project:aProj.oid}, function(jso) {
      if (that.pjCurr === aProj)
        that.goPage(jso.list[0].oid);
    });
  } ,

  goPage: function(iOid, iNoHistory) {
    if (this.pjCurr.curr === iOid)
      return;
    if (!iNoHistory) {
      var aN = this.navState.history.n;
      var aI = {proj:this.pjCurr.oid, page:iOid};
      if (aN === this.navState.history.i.length)
        this.navState.history.i.push(aI);
      else
        this.navState.history.i[aN] = aI;
      this.navState.history.n = ++aN;
      this.navState.history.len = aN;
      suae.touch(this.navUpdate);
      suae.menus.nav.enable('pjback', aN > 1);
      suae.menus.nav.enable('pjforw', false);
    }
    suae.paletteMgr.closeAllExcept(this.pjCurr.revPanel);
    this.pjCurr.namesPal.setValue('pjname', this.pjCurr.update.data.name);
    this.pjCurr.namesPal.setValue('pgname', this.pjCurr.pageindex.find('name', iOid).text);
    this.pjCurr.curr = iOid;
    suae.menus.page.setValue('page'+ this.pjCurr.stateUpdate.data.select.sort +'list', iOid);
    this.pjCurr.stateUpdate.data.select.page = iOid;
    this.touchState(this.pjCurr.stateUpdate.data);
    var aState = this.pjCurr.stateUpdate.data.page[iOid];
    this.loadPage(iOid, this.pjCurr, aState && aState[this.pjCurr.currRev || ' '], this.pjCurr.currRev);
  } ,

  goHistory: function(iN) {
    this.goProj(this.navState.history.i[iN].proj, this.navState.history.i[iN].page);
    this.navState.history.n = ++iN;
    suae.touch(this.navUpdate);
    suae.menus.nav.enable('pjback', iN > 1);
    suae.menus.nav.enable('pjforw', iN < this.navState.history.len);
  } ,

  goRev: function(iPage, iRev) {
    if (this.pjCurr.curr !== iPage) {
      this.pjCurr.currRev = iRev;
      this.enableEdit(iRev === null);
      return this.goPage(iPage);
    }
    if (this.pjCurr.currRev === iRev)
      return;
    this.pjCurr.currRev = iRev;
    this.enableEdit(iRev === null);
    suae.paletteMgr.closeAllExcept(this.pjCurr.revPanel);
    var aState = this.pjCurr.stateUpdate.data.page[this.pjCurr.curr];
    this.loadPage(this.pjCurr.curr, this.pjCurr, aState && aState[iRev], iRev);
  } ,

  /*goUser: function(iUid) {
    if (this.pj['#users'] && this.pj['#users'] !== this.pjCurr)
      this.pj['#users'].curr = iUid;
    this.goProj('#users');
    this.goPage(iUid);
  } ,

  newUserPage: function(iUid) {
    var aPt = suae.store({type:'part', xml:'<h3>Profile for '+ iUid +'</h3>'});
    var aPg = suae.readOrStore({type:'page', oid:iUid,
      data:{ name:iUid, added:dateFormat('isoUtcDateTime'), project:{oid:'#users', index:'userindex'} },
      layout:[ {class:'htmlEdit', pid:suae.newOid(), name:aPt, style:'top:30px; left:30px; width:300px; height:100px;'} ]});
    this.updatePagePanels('#users', 'userindex', aPg);
    if (suae.indexFind(this.pjCurr.userindex, iUid))
      this.listUser(iUid);
  } ,*/

  listMember: function(iUid) {
    var aStyle = '';
    if (!this.pjCurr.userindex.find('uid', iUid).key) aStyle += 'font-style:italic;';
    if (this.pjCurr.userindex.find('left', iUid).key) aStyle += 'text-decoration:line-through;';
    var aHtml = '<span style="'+ aStyle +'">'+ this.pjCurr.userindex.text[iUid] +'</span>';
    if (null)//suae.indexFind(this.userIndex, iUid)
      aHtml = '<a href="suae:'+ iUid +'" onclick="'+ this.kUserOnclick +'">'+ aHtml +'</a>';
    suae.menus.circ.listSet('members', iUid, aHtml);
  } ,

  paletteEvent: function(iPal, iName, iValue) {
    switch (iName) {
    case 'fresh':
      iPal.showPanel('welcomefresh');
      suae.request({type:'autogen'}, function(){});
      break;
    case 'link':
      iPal.showPanel('welcomelink');
      break;
    case 'linkhost':
      this.linkhost = iValue;
      break;
    case 'linkgo':
      if (this.linkhost)
        suae.request({type:'syncFrom', op:'go', ssid:'', password:'', host:this.linkhost}, function(){});
      break;
    case 'linkstop':
      suae.request({type:'syncFrom', op:'stop', ssid:null, password:null, host:null}, function(){});
      break;
    case 'interrupt':
      suae.request({type:'interrupt'}, function(){});
      break;
    case 'tool':
      this.selectEditor(iValue);
      break;
    case 'knobs':
      break;
    case 'pgsort':
      suae.menus.page.showPanel('page'+iValue);
      this.pjCurr.stateUpdate.data.select.sort = iValue;
      this.touchState(this.pjCurr.stateUpdate.data);
      suae.menus.page.setValue('page'+ iValue +'list', this.pjCurr.curr);
      break;
    case 'pagenamelist':
    case 'pageaddedlist':
      this.goPage(iValue);
      break;
    case 'pagenew':
      this.newPage();
      break;
    case 'send':
      var that = this, aProj = this.pjCurr;
      suae.touchFlush(function() {
        suae.request({type:'commitRevision', project:aProj.oid}, function(jso) {
          if (that.pjCurr === aProj)
            that.pjCurr.revPanel.show();
        });
      });
      break;
    case 'names':
      this.pjCurr.namesPal.show();
      break;
    case 'pjtext':
      this.pjCurr.update.data.name = iValue;
      suae.touch(this.pjCurr.update);
      this.pjCurr.namesPal.setValue('pjname', iValue);
      this.updateNavPanels(this.pjCurr.update, true);
      break;
    case 'pgtext':
      var aPage = this.pjCurr.page[this.pjCurr.curr];
      aPage.update.data.data.name = iValue;
      suae.touch(aPage.update);
      this.pjCurr.namesPal.setValue('pgname', iValue);
      this.updatePagePanels(this.pjCurr.oid, aPage.update.data, true);
      break;
    case 'revhistory':
      this.pjCurr.revPanel.show();
      break;
    case 'msglog':
      this.pjCurr.msgPanel.show();
      break;
    case 'msglistPrevBtn':
      this.getMsgList();
      break;
    case 'svc':
      var aUpdt = { type:'setService', project:this.pjCurr.oid, service: iValue === 'tbd' ? '' : iValue };
      suae.request(aUpdt, function() { });
      break;
    case 'svcalias':
      suae.request({type:'setUseralias', project:this.pjCurr.oid, alias:iValue}, function(){});
      break;
    case 'newmember':
      var aDespaced = iValue.replace(/ /g, '');
      suae.menus.circ.setValue('newmember', iValue === aDespaced ? 'Add Member' : aDespaced);
      if (iValue === aDespaced && !this.pjCurr.userindex.find('alias', iValue))
        suae.request({type:'addMember', project:this.pjCurr.oid, alias:iValue}, function() { });
      break;
    case 'pjsort':
      suae.menus.nav.showPanel('nav'+iValue);
      this.navState.sort = iValue;
      suae.touch(this.navUpdate);
      suae.menus.nav.setValue('nav'+ iValue +'list', this.pjCurr.oid);
      break;
    case 'navnamelist':
    case 'navcreatedlist':
      this.goProj(iValue);
      break;
    case 'pjback':
      this.goHistory(this.navState.history.n -2);
      break;
    case 'pjforw':
      this.goHistory(this.navState.history.n);
      break;
    case 'pjnew':
      this.newProj();
      break;
    default:
      throw 'pMgr.paletteEvent(): widget '+iName+' not known';
    }
  } ,

  htmlFactory: document.createElement('div'),

  kScreenHtml: '<div class="screen"\
    ><div class="screenclip"\
      ><div class="screendata" name="pageId" style="top:0; left:0;"\
        ><div class="dragbox" style=""></div></div></div></div>' ,

  kPartHtml: '<div class="part" pid="partId" style=""\
    ><div class="partframe"></div\
    ><div class="partknob" name="tl" style="top:   -8px; left: -8px;"></div\
    ><div class="partknob" name="t"  style="top:   -8px; left:  8px;"></div\
    ><div class="partknob" name="l"  style="top:    8px; left: -8px;"></div\
    ><div class="partknob" name="wh" style="bottom:-8px; right:-8px;"></div\
    ><div class="partknob" name="h"  style="bottom:-8px; right: 8px;"></div\
    ><div class="partknob" name="w"  style="bottom: 8px; right:-8px;"></div></div>' ,

  kGroupHtml: '<div class="groupknobs" name="groupId" style="position:absolute; top:-20px; left:-20px;"\
    ><div class="partknob" name="gtl" style="top:0;   left:0;   background-color:#d0d;"></div\
    ><div class="partknob" name="gt"  style="top:0;   left:9px; background-color:#d0d;"></div\
    ><div class="partknob" name="gl"  style="top:9px; left:0;   background-color:#d0d;"></div></div>' ,

  scrPane: null,  // page object for screens
  currEditor: '', // content editor name
  evtFn: null,
  dragknob: null,
  dragPage: null,
  dragger: null,

  pgInit: function() {
    this.scrPane = document.getElementById('screenpane');
    this.scrPane.innerHTML = this.kScreenHtml;

    this.dragger = suae.dragHandler.factory();
    this.dragger.start(this.scrPane, this, true);

    var that = this;
    this.evtFn = function(e) { that.event(e); };
  } ,

  _Page: function(iPgId, iState) {
    this.pgid = iPgId;
    this.screen = null;
    this.dragbox = null;
    this.scroll = null;
    this.topZ = 0;
    this.update = null;
    this.layout = null;
    this.div = { };
    this.state = iState;
    this.group = { };
  } ,

  loadPage: function(iOid, iProj, iState, iRevId) {
    this.pjCurr.lastAccess = new Date;

    this.selectEditor('');
    this.scrPane.removeChild(this.scrPane.firstChild);

    var aPgId = iRevId ? iRevId+'_'+iOid : iOid;
    if (!iProj.page[aPgId])
      iProj.page[aPgId] = new this._Page(aPgId, iState || {type:'page', oid:iOid, rev:iRevId||' ', focus:null, scroll:{v:0, h:0}, part:{}});
    var aPage = iProj.page[aPgId];

    if (!aPage.layout || aPage.loadCount) {
      var that = this;
      if (!aPage.screen) {
        this.htmlFactory.innerHTML = this.kScreenHtml;
        aPage.screen = this.htmlFactory.firstChild;
        aPage.screen.firstChild.firstChild.pgid = aPgId;
        aPage.screen.addEventListener('DOMMouseScroll', this.evtFn, false);

        aPage.dragbox = aPage.screen.firstChild.firstChild.firstChild;

        aPage.scroll = suae.scrollbar.factory();
        aPage.scroll.setup(aPage.screen, suae.scrollbar.eLeft, this.scrPane.offsetHeight, function(v, h){that.scroll(aPage, v, h);});
        aPage.scroll.objSetLen(4000);
        aPage.scroll.objSetPos(-aPage.state.scroll.v);
      }
      this.scrPane.appendChild(aPage.screen);

      var aPlaceParts = function() {
        for (var a=0; a < aPage.layout.length; ++a)
          that.placePart(aPage, aPage.layout[a]);
        aPage.scroll.objSetLen(4000);
      };

      if (aPage.layout) {
        aPlaceParts();
      } else {
        var aReq = {type:iRevId?'readPageRevision':'subscribePage', project:iProj.oid, page:iOid, revision:iRevId};
        suae.request(aReq, function(jso) {
          aPage.update = iRevId ? null : {type:'writePage', project:iProj.oid, page:iOid, data:jso};
          aPage.layout = jso.layout;
          aPage.loadCount = aPage.layout.length;

          if (aPage.screen.parentNode)
            aPlaceParts();
        });
      }
    } else {
      this.scrPane.appendChild(aPage.screen);
      for (var a=0; a < aPage.layout.length; ++a) {
        var aApp = suae.lookupApp(aPage.layout[a].class);
        try {
        var aFn;
        aApp[aFn='view'](aPage.pgid, aPage.layout[a].pid);
        if (aPage.state.focus === aPage.layout[a].pid)
          aApp[aFn='focus'](aPage.pgid, aPage.layout[a].pid, false);
        } catch (aEr) {
          this.postMsg('App error: '+aPage.layout[a].class+'.'+aFn+'(): '+aEr);
        }
      }
    }
  } ,

  updateLayout: function(iPage, iLayout) {
    for (var a=0; a < iLayout.length; ++a) {
      for (var aPt=0; aPt < iPage.layout.length && iPage.layout[aPt].pid !== iLayout[a].pid; ++aPt) {}
      if (aPt < iPage.layout.length) {
        if (!suae.areEqual(iPage.layout[aPt], iLayout[a])) {
          for (var aEl=iPage.screen.firstChild.firstChild.firstChild; aEl.id !== iLayout[a].pid; aEl=aEl.nextSibling) {}
          aEl.setAttribute('style', iLayout[a].style);
        }
        iPage.layout.splice(aPt, 1);
      } else {
        ++iPage.loadCount;
        if (iPage.screen.parentNode)
          this.placePart(iPage, iLayout[a]);
      }
    }
    for (var a=0; a < iPage.layout.length; ++a) {
      for (var aEl=iPage.screen.firstChild.firstChild.firstChild; aEl.id !== iPage.layout[a].pid; aEl=aEl.nextSibling) {}
      aEl.parentNode.removeChild(aEl);
      var aApp = suae.lookupApp(iPage.layout[a].class);
      try {
      aApp.close(iPage.pgid, iPage.layout[a].pid);
      } catch (err) {
        this.postMsg('App error: '+iPage.layout[a].class+'.close(): '+err);
      }
      //. if (iPage.layout[a].oid) delete project.part[iPage.layout[a].oid].instance[iPage.pgid+'|'+iPage.layout[a].pid];
    }
    iPage.update.data.layout = iPage.layout = iLayout;
  } ,

  revisePage: function(iProj, iOid) {
    if (!iProj.page[iOid])
      return;
    var aPrev = iProj.page[iOid];
    iProj.page[iOid] = new this._Page(iOid, aPrev.state);
    if (aPrev.rev) {
      iProj.page[iOid].rev = aPrev.rev;
      delete aPrev.rev;
    }
    if (this.pjCurr.curr === iOid && this.pjCurr.currRev === null)
      this.loadPage(iOid, iProj);
    this.releasePage(iProj, aPrev); //. should move this copy to the .rev list
  } ,

  releasePage: function(iProj, iPage) {
    for (var a=0; a < iPage.layout.length; ++a) {
      delete iProj.part[iPage.layout[a].oid].instance[iPage.layout[a].pid];
      for (var aI in iProj.part[iPage.layout[a].oid].instance) { break; }
      if (!aI)
        delete iProj.part[iPage.layout[a].oid];
      var aApp = suae.lookupApp(iPage.layout[a].class);
      try {
      aApp.close(iPage.pgid, iPage.layout[a].pid);
      } catch (aEr) {
        this.postMsg('App error: '+aApp.kAppName+'.close() '+aEr);
      }
    }
  } ,

  addContent: function(iType, iPage) {
    var that = this;
    suae.request({type:'newPart', project:this.pjCurr.oid}, function(jso) {
      iPage.layout.push({class:iType, pid:jso.a, oid:jso.b, outofband:/_$/.test(iType), style:iPage.dragbox.getAttribute('style'), metadata:{}});
      suae.touch(iPage.update);
      ++iPage.topZ;

      iPage.state.focus = jso.a;
      that.touchState(iPage.state);

      ++iPage.loadCount;
      if (iPage.screen.parentNode)
        that.placePart(iPage, iPage.layout[iPage.layout.length-1]);
    });
  } ,

  placePart: function(iPage, iPartJso) {
    if (document.getElementById(iPartJso.pid))
      return;
    var aApp = suae.lookupApp(iPartJso.class);
    if (!aApp) {
      suae.loadAppForPart(iPartJso.class, iPage.pgid, iPartJso.pid);
      return;
    }
    this.htmlFactory.innerHTML = this.kPartHtml;
    var aDiv = this.htmlFactory.firstChild;
    aDiv.id = aDiv.pid = iPartJso.pid;
    aDiv.setAttribute('style', iPartJso.style);
    iPage.screen.firstChild.firstChild.appendChild(aDiv);

    var aReq = iPartJso.outofband ? '/part?oid='+iPartJso.oid+'&project='+this.pjCurr.oid+'&page='+iPage.pgid :
      iPage.pgid.indexOf('_') >= 0 || !iPartJso.oid ? null : {type:'writePart', project:this.pjCurr.oid, page:iPage.pgid, part:iPartJso.oid, data:null};
    try {
    aApp.open(iPage.pgid, iPartJso.pid, aDiv.firstChild, iPage.state.part[iPartJso.pid] || {type:'part', oid:iPartJso.pid}, aReq, iPartJso.metadata);
    } catch (aEr) {
      this.postMsg('App error: '+aApp.kAppName+'.open() '+aEr);
    }

    if (+ aDiv.style.zIndex > iPage.topZ)
      iPage.topZ = + aDiv.style.zIndex;

    if (iPartJso.group)
      this.placeGroup(iPage, iPartJso.group, aDiv);

    if (iPage.state.focus === iPartJso.pid) {
      try {
      aApp.focus(iPage.pgid, iPartJso.pid, false);
      } catch (aEr) {
        this.postMsg('App error: '+aApp.kAppName+'.focus() '+aEr);
      }
    }

    --iPage.loadCount;

    if (!iPartJso.oid)
      return;
    if (!this.pjCurr.part[iPartJso.oid])
      this.pjCurr.part[iPartJso.oid] = { data:iPartJso.outofband?true:null, instance:{} };
    this.pjCurr.part[iPartJso.oid].instance[iPage.pgid+'|'+iPartJso.pid] = aApp;
    if (this.pjCurr.part[iPartJso.oid].data) {
      try {
      aApp.update(iPage.pgid, iPartJso.pid, this.pjCurr.part[iPartJso.oid].data);
      } catch (aEr) {
        this.postMsg('App error: '+aApp.kAppName+'.update() '+aEr);
      }
    }
  } ,

  placePartById: function(iPgId, iPtId) {
    if (!this.pjCurr.page[iPgId])
      return;
    for (var a=0; this.pjCurr.page[iPgId].layout[a].pid !== iPtId; ++a) {}
    this.placePart(this.pjCurr.page[iPgId], this.pjCurr.page[iPgId].layout[a]);
  } ,

  setPartMetadata: function(iPgId, iPtId, iMetadata) {
    var aLyt = this.pjCurr.page[iPgId].layout;
    for (var a=0; a < aLyt.length && aLyt[a].pid !== iPtId; ++a) {}
    aLyt[a].metadata = iMetadata;
    suae.touch(this.pjCurr.page[iPgId].update);
  } ,

  focusEvent: function(iPart, iInPart) {
    var aPage = this.pjCurr.page[iPart.parentNode.pgid];
    aPage.state.focus = iPart.pid;
    this.touchState(aPage.state);
    for (var a=0; aPage.layout[a].pid !== iPart.pid; ++a) {}
    var aApp = suae.lookupApp(aPage.layout[a].class);
    try {
    aApp.focus(aPage.pgid, iPart.pid, iInPart);
    } catch (aEr) {
      this.postMsg('App error: '+aApp.kAppName+'.focus() '+aEr);
    }
  } ,

  sizePart: function(iDiv, iWidth, iHeight, iNoSave) {
    if (iDiv.parentNode.className !== 'part')
      throw 'pgEdit.sizePart(): element is not a part';
    if (iWidth !== '')
      iDiv.parentNode.style.width = iWidth;
    if (iHeight !== '')
      iDiv.parentNode.style.height = iHeight;
    if (!iNoSave)
      this.setDimensions(iDiv.parentNode);
  } ,

  placeGroup: function(iPage, iGroup, iPartDiv) {
    this.htmlFactory.innerHTML = this.kGroupHtml;
    var aKnobs = this.htmlFactory.firstChild;
    aKnobs.groupid = iPartDiv.parentNode.pgid +'|'+ iGroup;
    iPartDiv.appendChild(aKnobs);

    if (!iPage.group[iGroup])
      iPage.group[iGroup] = { color: '', divs: [ ] };
    iPage.group[iGroup].divs.push(iPartDiv);
  } ,

  selectEditor: function(iId) {
    if (this.currEditor === iId)
      return;
    this.currEditor = iId;
    if (iId === '')
      suae.menus.tools.setValue('tool', '');
    for (var aS=this.scrPane.firstChild; aS; aS=aS.nextSibling) {
      aS.firstChild.style.cursor = iId === '' ? '' : 'crosshair';
    }
  } ,

  setDimensions: function(iDiv) {
    var aPage = this.pjCurr.page[iDiv.parentNode.pgid];
    for (var a=0; aPage.layout[a].pid !== iDiv.pid; ++a) {}
    aPage.layout[a].style =
      'top: '+iDiv.style.top +'; left: '+iDiv.style.left +'; width: '+iDiv.style.width +'; height: '+iDiv.style.height+'; z-index: '+iDiv.style.zIndex+';';
    suae.touch(aPage.update);
  } ,

  scroll: function(iPage, iVert, iHorz) {
    iPage.screen.firstChild.firstChild.style.top = iVert + 'px';
    iPage.screen.firstChild.firstChild.style.left = iHorz + 'px';
    iPage.state.scroll.v = iVert;
    iPage.state.scroll.h = iHorz;
    this.touchState(iPage.state);
  } ,

  event: function(iEvt) {
    switch (iEvt.type) {
    case 'DOMMouseScroll':
      if (iEvt.detail) {
        var aPage = this.pjCurr.page[iEvt.currentTarget.firstChild.firstChild.pgid];
        aPage.scroll.objSetPos(-aPage.state.scroll.v + iEvt.detail*12);
      }
      break;
    }
  } ,

  handleDrag: function(iEvt) {
    switch (iEvt.type) {

    case 'mousedown':
      var aInPart = false;
      for (var aEl = iEvt.target; aEl.className !== 'screen'; aEl = aEl.parentNode) {
        if (aEl.className === 'partframe')
          aInPart = true;
        else if (aEl.className === 'part')
          this.focusEvent(aEl, aInPart);
      }
      switch (iEvt.target.className) {
      case 'screenclip':
        if (!this.currEditor)
          return false;
        this.dragPage = this.pjCurr.page[iEvt.target.firstChild.pgid];
        this.dragPage.dragbox.style.top  = (iEvt.layerY + +this.dragPage.state.scroll.v) + 'px';
        this.dragPage.dragbox.style.left = (iEvt.layerX + +this.dragPage.state.scroll.h) + 'px';
        this.dragPage.dragbox.style.width  = '20px';
        this.dragPage.dragbox.style.height = '20px';
        this.dragPage.dragbox.style.zIndex = this.dragPage.topZ +1;
        this.dragPage.dragbox.style.display = 'block';
        this.dragPage.dragbox.prevX = iEvt.clientX;
        this.dragPage.dragbox.prevY = iEvt.clientY;
        return true;
      case 'partknob':
        var aWhat = iEvt.target.getAttribute('name');
        if (/^g/.test(aWhat)) {
          var aId = iEvt.target.parentNode.groupid.split('|');
          this.dragknob = {
            parts: this.pjCurr.page[aId[0]].group[aId[1]].divs,
            top:  /t/.test(aWhat),
            left: /l/.test(aWhat),
            prevX: iEvt.clientX,
            prevY: iEvt.clientY
          };
        } else {
          this.dragknob = {
            part:   iEvt.target.parentNode,
            top:    /t/.test(aWhat),
            left:   /l/.test(aWhat),
            width:  /w/.test(aWhat),
            height: /h/.test(aWhat),
            deltaX: 0, deltaY: 0
          };
          this.dragknob.deltaX = iEvt.clientX - iEvt.target.parentNode[this.dragknob.left ? 'offsetLeft' : 'offsetWidth'];
          this.dragknob.deltaY = iEvt.clientY - iEvt.target.parentNode[this.dragknob.top  ? 'offsetTop' : 'offsetHeight'];
        }
        return true;
      }
      return false;

    case 'mousemove':
      if (this.dragPage) {
        var aLen;
        aLen = iEvt.clientX - this.dragPage.dragbox.prevX;
        this.dragPage.dragbox.style.width  = aLen < 20 ? '20px' : aLen +'px';
        aLen = iEvt.clientY - this.dragPage.dragbox.prevY;
        this.dragPage.dragbox.style.height = aLen < 20 ? '20px' : aLen +'px';
        return true;
      } else if (this.dragknob) {
        if (this.dragknob.parts) {
          for (var a=0; a < this.dragknob.parts.length; ++a) {
            if (this.dragknob.top)
              this.dragknob.parts[a].style.top = this.dragknob.parts[a].offsetTop + (iEvt.clientY - this.dragknob.prevY);
            if (this.dragknob.left)
              this.dragknob.parts[a].style.left = this.dragknob.parts[a].offsetLeft + (iEvt.clientX - this.dragknob.prevX);
          }
          this.dragknob.prevX = iEvt.clientX;
          this.dragknob.prevY = iEvt.clientY;
        } else {
          if (this.dragknob.top)
            this.dragknob.part.style.top = iEvt.clientY - this.dragknob.deltaY +'px';
          if (this.dragknob.left)
            this.dragknob.part.style.left  = iEvt.clientX - this.dragknob.deltaX +'px';
          if (this.dragknob.height)
            this.dragknob.part.style.height = iEvt.clientY - this.dragknob.deltaY +'px';
          if (this.dragknob.width)
            this.dragknob.part.style.width = iEvt.clientX - this.dragknob.deltaX +'px';
        }
        return true;
      }
      return false;

    case 'mouseup':
      if (this.dragPage) {
        this.dragPage.dragbox.style.display = null;
        this.addContent(this.currEditor, this.dragPage);
        this.selectEditor('');
        this.dragPage = null;
        return true;
      } else if (this.dragknob) {
        if (this.dragknob.parts) {
          for (var a=0; a < this.dragknob.parts.length; ++a)
            this.setDimensions(this.dragknob.parts[a]);
        } else {
          this.setDimensions(this.dragknob.part);
        }
        this.dragknob = null;
        return true;
      }
      return false;

    }
    return false; // draghandle expects return value
  }

} ; // pgEdit

// firefox 3.0 .innerHTML misparses <tag/> elements

