
suae.registerApp(
{
  kAppName: 'imageEdit_',

  kPalSpec: '\
    <size w="220px" h="100px"></size>\
    <div class="pallabel" name="title" style="top:5px; left:5px;">Put File</div>\
    <div class="pallabel" name="form" style="top:25px; left:5px;">\
      <form id="imageEdit_.form" method="POST" action="" target="imageEdit_.postframe" enctype="multipart/form-data">\
      <input type="file" name="data" onchange="this.form.submit()"/>\
      </form><iframe name="imageEdit_.postframe" style="display:none; width:0; height:0; border-width:0;"></iframe>\
    </div>' ,

  pal: null,
  inFocus: null,
  count: 0,
  instance: {}, // indexed by pid

  init: function() {
    this.pal = suae.paletteMgr.create(this.kPalSpec, 200, 200, this);
  } ,

  open: function(iPgId, iPid, iDiv, iState, iUri) {
    iDiv.style.backgroundColor = '#ddd';
    var aInst = this.instance[iPgId+'|'+iPid] = {
      uri: iUri,
      div: iDiv,
      state: iState,
      idPre: this.kAppName +'.'+ this.count++,
      img: document.createElement('img')
    };
    aInst.img.setAttribute('style', 'width:100%; height:100%');
    iDiv.appendChild(aInst.img);
  } ,

  update: function(iPgId, iPid, iData) {
    var aInst = this.instance[iPgId+'|'+iPid];
    aInst.img.src = aInst.uri + (aInst.img.src ? '&time=' + (new Date).getTime() : '');
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
  } ,

  close: function(iPgId, iPid) {
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

