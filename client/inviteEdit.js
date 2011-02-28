
suae.registerApp(
{
  kAppName: 'inviteEdit',

  //kPalSpec: '\
  //  <size w="200px" h="300px"></size>\
  //  <div class="pallabel" name="title" style="top:5px; left:5px;">A Palette</div>\
  //  <div class="palbutton" name="button" style="top:50px; left:20px; width:50px; height:20px;">Toggle</div>' ,

  //pal: null,
  inFocus: null,
  div: null,
  index: new suae.Index('date', {fromAlias:'+str', date:'-str'}),

  init: function() {
    
  } ,

  open: function(iPgId, iPid, iDiv, iState, iTouch) {
    //iDiv.d = {
    //  state: iState,
    //  idPre: this.kAppName +'.'+ this.count++,
    //  dragger: suae.dragHandler.factory(),
    //  test: true
    //};

    //iDiv.d.dragger.start(iDiv, this, true);

    iDiv.id = this.kAppName+'.'+0;
    iDiv.style.fontFamily = 'verdana';
    iDiv.style.fontSize = '90%';
    iDiv.innerHTML = '\
      <style type="text/css">\
        .invitecell, .invitet { height:2em; margin:2px 0; line-height:2em; }\
        .invitecell { background-color:#eee; }\
      </style>\
      <div style="width:15%; float:left"></div>\
      <div style="width:20%; float:left"></div>\
      <div style="width:20%; float:left"></div>\
      <div style="width:45%; float:left"></div>';
    var that = this;
    iDiv.getElementsByTagName('div')[0].addEventListener('click', function(e){that.event(e)}, false);

    suae.pMgr.sizePart(iDiv, '70%', '', true);
    this.div = iDiv;
    if (suae.invitesLoaded)
      this.update();
    else {
      var that = this;
      suae.request({type:'getInvites'}, function(jso) {
        for (var a=0; a < jso.list.length; ++a) {
          suae.invites[jso.list[a].oid] = jso.list[a];
          that.index.add(jso.list[a].oid, jso.list[a]);
        }
        suae.invitesLoaded = true;
        that.update();
      });
    }
  } ,

  update: function(iItem) {
    if (iItem)
      this.index.add(iItem.oid, iItem);

    if (!document.getElementById(this.div.id)) {
      this.repaint = true;
      return;
    }
    var aCol = [
      '<div class="invitet">Accepted</div>',
      '<div class="invitet">Invited by</div>',
      '<div class="invitet">Title</div>',
      '<div class="invitet">Description</div>'
    ];
    var aList = this.index.getList('date');
    for (var a=0; a < aList.length; ++a) {
      var aRec = suae.invites[aList[a].id];
      var aC=0;
      aCol[aC++] += '<div class="invitecell" rowid="'+aList[a].id+'">'+(aRec.accept || 'click to join')+'</div>';
      aCol[aC++] += '<div class="invitecell" rowid="'+aList[a].id+'">'+aRec.fromAlias                    +'</div>';
      aCol[aC++] += '<div class="invitecell" rowid="'+aList[a].id+'">'+aRec.data.name                    +' </div>';
      aCol[aC++] += '<div class="invitecell" rowid="'+aList[a].id+'">'+aRec.data.blurb                   +' </div>';
    }
    for (var aEl=this.div.firstChild, a=0; aEl; aEl=aEl.nextSibling)
      if (aEl.tagName === 'DIV')
        aEl.innerHTML = aCol[a++];
    suae.pMgr.sizePart(this.div, '', this.div.lastChild.offsetHeight +'px', true);
  } ,

  view: function(iDiv) {
    if (this.repaint) {
      this.repaint = false;
      this.update();
    }
  } ,

  focus: function(iDiv) {
    //this.widgets.show();
    if (this.inFocus === iDiv)
      return;
    this.inFocus = iDiv;
  } ,

  close: function(iDiv) {
    //iDiv.d.dragger.stop();
    //delete iDiv.d;
    if (iDiv === this.inFocus)
      this.inFocus = null;
  } ,

  event: function(iEvt) {
    if (iEvt.target.className !== 'invitecell')
      return;
    var aRec = suae.invites[iEvt.target.getAttribute('rowid')];
    if (aRec.accept)
      return;
    var that = this;
    suae.request({type:'acceptInvite', oid:aRec.oid, service:aRec.service, to:aRec.fromAlias, alias:aRec.toAlias}, function(jso) {});
  } 

  /*paletteEvent: function(iPal, iName, iValue) {
    switch (iName) {
    case 'button':
      this.focus.style.fontWeight = this.focus.d.test ? 'bold' : '';
      this.focus.d.state.bold.@on = this.focus.d.test.toString();
      this.focus.d.test = !this.focus.d.test;
      break;
    }
    suae.pMgr.touchState(this.focus.d.state);
  } ,

  handleDrag: function(iEvt) {
    switch (iEvt.type) {
    case 'mousedown':
      if (iEvt.target === this.focus)
        return false;
      this.focus.d.dragger.deltaX = iEvt.clientX - iEvt.target.offsetLeft;
      this.focus.d.dragger.deltaY = iEvt.clientY - iEvt.target.offsetTop;
      return true;
    case 'mousemove':
      this.focus.firstChild.style.top = iEvt.clientY - this.focus.d.dragger.deltaY;
      this.focus.firstChild.style.left = iEvt.clientX - this.focus.d.dragger.deltaX;
      return true;
    case 'mouseup':
      this.focus.d.data.pos.@t = this.focus.firstChild.style.top;
      this.focus.d.data.pos.@l = this.focus.firstChild.style.left;
      suae.touch(this.focus.d.data);
      return true;
    }
  }*/

} );
