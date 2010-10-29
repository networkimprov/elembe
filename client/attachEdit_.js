
suae.registerApp(
{
  kAppName: 'attachEdit_',

  kPalSpec: '\
    <size w="220px" h="100px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">Put File</div>\
    <div class="pallabel" name="form" style="top:25px; left:5px;">\
      <form id="attachEdit_.form" method="POST" action="" target="attachEdit_.postframe" enctype="multipart/form-data">\
      <input type="file" name="localfile" onchange="suae.paletteMgr.triggerInputElement(this); this.form.submit();"/>\
      </form><iframe name="attachEdit_.postframe" style="display:none; width:0; height:0; border-width:0;"></iframe>\
    </div>\
    <div class="palbutton" name="open" style="top:50px; left:5px; width:150px; height:25px;">Open in Editor</div>' ,

  pal: null,
  inFocus: null,
  count: 0,
  instance: {}, // indexed by pid

  init: function() {
    this.pal = suae.paletteMgr.create(this.kPalSpec, 200, 200, this);
  } ,

  open: function(iPgId, iPid, iDiv, iState, iUri, iMetadata) {
    iDiv.style.backgroundColor = '#ddd';
    var aInst = this.instance[iPgId+'|'+iPid] = {
      uri: iUri,
      metadata: iMetadata,
      updateMetadata: function() { suae.pMgr.setPartMetadata(iPgId, iPid, iMetadata); },
      div: iDiv,
      state: iState,
      idPre: this.kAppName +'.'+ this.count++
    };
    iDiv.innerHTML = '<div style="text-align:center; font-family:helvetica;"><div>Attachment</div><div></div</div>';
  } ,

  update: function(iPgId, iPid, iData) {
    var aInst = this.instance[iPgId+'|'+iPid];
    aInst.div.firstChild.lastChild.innerHTML = aInst.metadata.docType ? aInst.metadata.docType+' File' : 'No Document';
    this.pal.enable('open', aInst.metadata.docType);
  } ,

  view: function(iPgId, iPid) {
  } ,

  focus: function(iPgId, iPid) {
    var aInst = this.instance[iPgId+'|'+iPid];
    this.pal.show();
    if (this.inFocus === aInst)
      return;
    this.inFocus = aInst;
    var aForm = document.getElementById(this.kAppName +'.form');
    aForm.reset();
    aForm.action = aInst.uri;
    this.pal.enable('open', aInst.metadata.docType);
  } ,

  close: function(iPgId, iPid) {
  } ,

  paletteEvent: function(iPal, iName, iValue) {
    switch (iName) {
    case 'localfile':
      this.inFocus.metadata.docType = iValue.slice(iValue.lastIndexOf('.'));
      this.inFocus.updateMetadata();
      break;
    case 'open':
      var aInFocus = this.inFocus;
      suae.request({type:'readyAttachment', uri:aInFocus.uri, doctype:aInFocus.metadata.docType}, function(jso) {
        aInFocus.div.setAttribute('file', jso.path);
        var aEvt = document.createEvent('Events');
        aEvt.initEvent('networkimprov-applaunch-open', true, false);
        aInFocus.div.dispatchEvent(aEvt);
      });
      break;
    default:
      throw 'htmlEdit:paletteEvent() unknown event '+iName;
    }
  } ,

  handleDrag: function(iEvt) {
    /*switch (iEvt.type) {
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
      suae.touch(this.focus.d.data, this.focus.d.source);
      return true;
    }*/
  }
} );

