
suae.registerApp(
{
  kAppName: 'textEdit',

  kPalSpec: '\
    <size w="120px" h="150px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">Text Editor</div>\
    <div class="palbutton" name="xmlview" style="top:30px; left:10px; width:80px; height:25px;">Edit XML</div>\
    <div class="pallabel" name="status" style="top:70px; left:10px;"> </div>' ,

  pal: null,
  inFocus: null,
  count: 0,
  instance: {}, // indexed by pid

  init: function() {
    this.pal = suae.paletteMgr.create(this.kPalSpec, 200, 200, this);
  } ,

  open: function(iPgId, iPid, iDiv, iState, iTouch) {
    var aInst = this.instance[iPgId+'|'+iPid] = {
      state: iState,
      touch: iTouch,
      idPre: this.kAppName +'.'+ this.count++,
      text: document.createElement('textarea')
      //dragger: suae.dragHandler.factory(),
    };
    aInst.text.setAttribute('style', 'position:absolute; top:0; left:0; width:100%; height:100%; border-width:0; margin:0; padding:5px; overflow:hidden;');
    aInst.text.onchange = function() { suae.touch(aInst.touch, aInst.text.value); };
    iDiv.appendChild(aInst.text);

    //iDiv.d.dragger.start(iDiv, this, true);
  } ,

  update: function(iPgId, iPid, iData) {
    var aInst = this.instance[iPgId+'|'+iPid];
    aInst.text.value = iData;
  } ,

  view: function(iPgId, iPid) {
  } ,

  focus: function(iPgId, iPid) {
    var aInst = this.instance[iPgId+'|'+iPid];
    //this.pal.show();
    if (this.inFocus === aInst)
      return;
    this.inFocus = aInst;
    this.inFocus.text.focus();
  } ,

  close: function(iPgId, iPid) {
    //iDiv.d.dragger.stop();
    if (this.instance[iPgId+'|'+iPid] === this.inFocus)
      this.inFocus = null;
    delete this.instance[iPgId+'|'+iPid];
  } ,

  paletteEvent: function(iPal, iName, iValue) {
    switch (iName) {
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
