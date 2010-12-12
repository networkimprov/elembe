
suae.registerApp(
{
  kAppName: 'htmlEdit',

  kPalSpec: '\
    <size w="120px" h="150px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">HTML Editor</div>\
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
    iDiv.style.backgroundColor = '#fff';
    var aInst = this.instance[iPgId+'|'+iPid] = {
      div: iDiv,
      state: iState,
      touch: iTouch,
      idPre: this.kAppName +'.'+ this.count++,
      text: document.createElement('textarea')
      //dragger: suae.dragHandler.factory(),
    };
    aInst.text.setAttribute('style', 'position:absolute; top:0; left:0; width:100%; height:100%; border-width:0; margin:0; padding:5px;');

    //iDiv.d.dragger.start(iDiv, this, true);

    if (!aInst.state.xmlview) {
      aInst.state.xmlview = {show:''};
      suae.pMgr.touchState(aInst.state);
    } else if (aInst.state.xmlview.show) {
      aInst.div.appendChild(aInst.text);
    }
  } ,

  update: function(iPgId, iPid, iData) {
    var aInst = this.instance[iPgId+'|'+iPid];
    aInst.text.value = iData;
    aInst.div.innerHTML = iData;
  } ,

  view: function(iPgId, iPid) {
  } ,

  focus: function(iPgId, iPid) {
    var aInst = this.instance[iPgId+'|'+iPid];
    this.pal.show();
    if (this.inFocus === aInst)
      return;
    this.inFocus = aInst;
    if (this.inFocus.text.parentNode)
      this.inFocus.text.focus();
    this.pal.setValue('xmlview', this.inFocus.text.parentNode ? 'View XML' : 'Edit XML');
  } ,

  close: function(iPgId, iPid) {
    //iDiv.d.dragger.stop();
    if (this.instance[iPgId+'|'+iPid] === this.inFocus)
      this.inFocus = null;
    delete this.instance[iPgId+'|'+iPid];
  } ,

  paletteEvent: function(iPal, iName, iValue) {
    switch (iName) {
    case 'xmlview':
      if (this.inFocus.text.parentNode === null) {
        this.inFocus.div.appendChild(this.inFocus.text);
        this.inFocus.state.xmlview.show = 'on';
        this.inFocus.text.focus();
      } else {
        this.pal.setValue('status', '');
        this.inFocus.div.removeChild(this.inFocus.text);
        this.inFocus.state.xmlview.show = '';
        this.inFocus.div.innerHTML = this.inFocus.text.value;
        suae.touch(this.inFocus.touch, this.inFocus.text.value);
      }
      this.pal.setValue('xmlview', this.inFocus.text.parentNode ? 'View XML' : 'Edit XML');
      break;
    default:
      throw 'htmlEdit:paletteEvent() unknown event '+iName;
    }
    suae.pMgr.touchState(this.inFocus.state);
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
