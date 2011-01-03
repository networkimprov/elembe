
suae.registerApp(
{
  kAppName: 'serviceEdit',

  kPalSpec: '\
    <div class="pallabel" name="title" style="top: 38px; left: 25px; font-weight:bold;">Add Service</div>\
    <div class="pallabel" name="auto1" style="top: 70px; left: 25px;">Address</div>\
    <div class="paltext" name="host" style="top: 68px; left: 97px; width: 250px;"></div>\
    <div class="pallabel" name="auto2" style="top: 70px; left: 382px;">Aliases</div>\
    <div class="paltext" name="aliases" style="top: 68px; left: 463px; width: 250px;"></div>\
    <div class="pallabel" name="aliasset" style="top: 100px; left: 465px;">none</div>\
    <div class="pallabel" name="auto3" style="top: 38px; left: 382px;">Comment</div>\
    <div class="paltext" name="comment" style="top: 36px; left: 463px; width: 22em;"></div>' ,

  inFocus: null,
  pal: null,
  touch: { type: 'touchService', host: null, aliases: '', comment: '' },
  div: null,

  init: function() {
  } ,

  open: function(iPgId, iPid, iDiv, iState, iTouch) {
    //iDiv.d = {
    //  state: iState,
    //  dragger: suae.dragHandler.factory()
    //};
    //iDiv.d.dragger.start(iDiv, this, true);

    if (this.pal)
      throw 'serviceEdit.placeContent(): only one view allowed';

    iDiv.style.fontFamily = 'verdana';
    iDiv.style.fontSize = '90%';

    iDiv.innerHTML = '<div style="height:110px;"> </div><div style="margin:0 2em;"> </div>';
    this.pal = suae.paletteMgr.embed(this.kPalSpec, iDiv.firstChild, this);
    this.div = iDiv.lastChild;
    var that = this;
    this.div.addEventListener('click', function(e){that._event(e)}, false);

    suae.pMgr.sizePart(this.div.parentNode, '70%', '', true);
    this.update();
  } ,

  update: function(iList) {
    if (iList) {
      for (var a in iList)
        if (a === this.touch.host)
          this.pal.setValue('aliasset', iList[a].aliases);
    }

    if (!this.pal.getWidgetByName('title')) {
      this.repaint = true;
      return;
    }
    var aCol = [
      '<div style="width:10%; float:left"><div class="servicet">Joined</div>',
      '<div style="width:10%; float:left"><div class="servicet">Status</div>',
      '<div style="width:35%; float:left"><div class="servicet">Service</div>',
      //'<div style="width:05%; float:left"><div class="servicet"> </div>',
      '<div style="width:40%; float:left"><div class="servicet">Description</div>'
    ];

    for (var a in suae.services) {
      var aRec = suae.services[a];
      var aC=0;
      aCol[aC++] += '<div class="servicecell" rowid="'+aRec.host+'">'+aRec.joined+' </div>';
      aCol[aC++] += '<div class="servicecell" rowid="'+aRec.host+'">'+aRec.status+'</div>';
      aCol[aC++] += '<div class="servicecell" rowid="'+aRec.host+'">'+aRec.host+'</div>';
      //aCol[aC++] += '<div class="servicecell" rowid="'+aRec.host+'"><a \
      //  href="suae:'+aRec.host+'" onclick="'+suae.pMgr.kUserOnclick+'">'+(aRec.joined !== 'no' ? 'Profile' : ' ')+'</a></div>';
      aCol[aC++] += '<div class="servicecell" rowid="'+aRec.host+'">'+aRec.comment+' </div>';
    }
    var aHtml = '<style type="text/css">\
      .servicecell, .servicet { width:100%; height:2em; margin:2px 0; line-height:2em; overflow:hidden; }\
      .servicecell { background-color:#eee; }</style>';
    for (var a=0; a < aCol.length; ++a)
      aHtml += aCol[a] + '</div>';
    this.div.innerHTML = aHtml;
    suae.pMgr.sizePart(this.div.parentNode, '', this.div.lastChild.offsetHeight + this.div.previousSibling.offsetHeight + 'px', true);
  } ,

  view: function(iDiv) {
    if (this.repaint) {
      this.repaint = false;
      this.update();
    }
  } ,

  focus: function(iDiv) {
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

  paletteEvent: function(iPal, iName, iValue) {
    this.touch[iName] = iValue;
    if (!this.touch.host)
      return;
    var that = this;
    var aExist = this.touch.host in suae.services;
    suae.request(this.touch, function() {
      if (aExist)
        return;
      that.pal.setValue('title', 'Edit Service');
      that.pal.enable('host', false);
    });
  } ,

  _event: function(iEvt) {
    if (iEvt.target.href)
      return;
    if (iEvt.target.hasAttribute('rowid')) {
      this.touch.host = iEvt.target.getAttribute('rowid');
      this.touch.comment = suae.services[this.touch.host].comment;
      this.touch.aliases = suae.services[this.touch.host].aliases;
    } else {
      this.touch.host = null;
      this.touch.comment = this.touch.aliases = '';
    }
    this.pal.setValue('host', this.touch.host || '');
    this.pal.setValue('comment', this.touch.comment);
    this.pal.setValue('aliases', this.touch.aliases);
    this.pal.setValue('aliasset', this.touch.aliases);
    this.pal.setValue('title', this.touch.host ? 'Add Service' : 'Edit Service');
    this.pal.enable('host', !this.touch.host);
  }// ,

  /*handleDrag: function(iEvt) {
    switch (iEvt.type) {
    case 'mousedown':
      if (iEvt.target === this.inFocus)
        return false;
      this.inFocus.d.dragger.deltaX = iEvt.clientX - iEvt.target.offsetLeft;
      this.inFocus.d.dragger.deltaY = iEvt.clientY - iEvt.target.offsetTop;
      return true;
    case 'mousemove':
      this.inFocus.firstChild.style.top = iEvt.clientY - this.inFocus.d.dragger.deltaY;
      this.inFocus.firstChild.style.left = iEvt.clientX - this.inFocus.d.dragger.deltaX;
      return true;
    case 'mouseup':
      this.inFocus.d.data.pos.@t = this.inFocus.firstChild.style.top;
      this.inFocus.d.data.pos.@l = this.inFocus.firstChild.style.left;
      suae.touch(this.inFocus.d.data);
      return true;
    }
  }*/

} );
