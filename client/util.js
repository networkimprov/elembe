
suae.paletteMgr = {

  base: null,
  dragger: null,
  seqnum: 0,

  init: function() {
    this.palette.ctor.prototype = this.palette;

    this.base = document.getElementById('palettes');
    this.dragger = suae.dragHandler.factory();
    this.dragger.start(this.base, this);
  } ,

  closeAllExcept: function(iExcept) {
    for (var a=this.base.firstChild; a; a=a.nextSibling)
      if ((!iExcept || a !== iExcept.div) && a.style.display)
        a.style.display = ''
  } ,

  create: function(iDef, iTop, iLeft, iTarget) {
    var aPal = new this.palette.ctor(iTarget, this.seqnum++);

    var aDiv = document.createElement('div');
    aDiv.className = 'palette';
    aDiv.style.top = iTop + 'px';
    aDiv.style.left = iLeft + 'px';
    aDiv.innerHTML = iDef;
    aDiv.appendChild(document.createElement('div')).className = 'palclose';

    this._paint(aDiv, aPal);

    this._startPal(aDiv, aPal);
    this.base.appendChild(aDiv);

    return aPal;
  } ,

  embed: function(iDef, iDiv, iTarget) {
    var aPal = new this.palette.ctor(iTarget, this.seqnum++);
    iDiv.innerHTML = iDef;

    this._paint(iDiv, aPal);
    this._startPal(iDiv, aPal);

    return aPal;
  } ,

  _startPal: function(iDiv, iPal) {
    iPal.div = iDiv;
    var aText = iDiv.getElementsByClassName('paltext');
    for (var a=0; a < aText.length; ++a)
      aText[a].prevVal = aText[a].value;

    iDiv.addEventListener('click', iPal.evtFn, false);
    iDiv.addEventListener('keydown', iPal.evtFn, false);
    iDiv.addEventListener('keyup', iPal.evtFn, false);
    iDiv.addEventListener('input-element', iPal.evtFn, false);
  } ,

  _sand: function(iEl) {
    do {
      switch (iEl.nodeType === 1 ? iEl.tagName.toLowerCase() : 'listname') {
      case 'size':
        iEl.parentNode.style.width = iEl.getAttribute('w');
        iEl.parentNode.style.height = iEl.getAttribute('h');
        // fall thru
      case 'embed':
      case 'listname':
        var aNext = iEl.nextSibling;
        iEl.parentNode.removeChild(iEl);
        if((iEl = aNext))
          continue;
      }
      return iEl;
    } while (true);
  } ,

  _paint: function(ioDiv, iPal) {
    for (var aEl=ioDiv.firstChild; aEl; aEl=aEl.nextSibling) {
      if (!(aEl = this._sand(aEl)))
        break;
      var aName = aEl.getAttribute('name');
      aEl.removeAttribute('name');
      aEl.id = iPal.uid + aName;
      switch(aEl.className) {
      case 'palclose':
      case 'pallabel':
      case 'palbutton':
      case 'palmenubtn':
        break;
      case 'paltext':
        aEl = ioDiv.insertBefore(document.createElement('input'), aEl);
        aEl.type = 'text';
        aEl.value = aEl.nextSibling.innerHTML;
        for (var a=0; a < aEl.nextSibling.attributes.length; ++a)
          aEl.setAttribute(aEl.nextSibling.attributes[a].name, aEl.nextSibling.attributes[a].value);
        ioDiv.removeChild(aEl.nextSibling);
        break;
      case 'palmenu':
        ioDiv.insertBefore(aEl.cloneNode(false), aEl).innerHTML = '<div class="palmenubtn" name="' +aName+ '-btn"></div>';
        aEl.className = 'palmenugrid';
        aEl.setAttribute('cellclass', 'palgridrow');
        aEl.setAttribute('name', aName+'-menu');
        aEl.setAttribute('style', 'top:0; left:0;');
        aEl = aEl.previousSibling;
        aEl.appendChild(aEl.nextSibling);
        this._paint(aEl, iPal);
        break;
      case 'palgrid':
      case 'palmenugrid':
        aEl.setAttribute('order', aEl.getAttribute('order') === '-' ? '-' : '+');
        aEl.setAttribute('cellclass', aEl.getAttribute('cellclass') || 'palgridcell');
        var aLName = aEl.getAttribute('listname') || aName;
        for (var aP=aEl.firstChild; aP; aP=aP.nextSibling) {
          if (!(aP = this._sand(aP)))
            break;
          aP.className = aEl.getAttribute('cellclass');
          aP.id = iPal.uid + aLName +'..'+ aP.getAttribute('value');
          aP.removeAttribute('value');
          aP.setAttribute('style', aEl.getAttribute('cellstyle'));
        }
        if (iPal.list) {
          if (!iPal.list[aLName])
            iPal.list[aLName] = { subset: [ ], value: '' };
          iPal.list[aLName].subset.push(aName);
        }
        break;
      case 'palhtml':
        aEl.setAttribute('order', aEl.getAttribute('order') === '-' ? '-' : '+');
        aEl.setAttribute('cellclass', 'palhtmldiv');
        aEl.setAttribute('cellstyle', aEl.getAttribute('divstyle'));
        aEl.removeAttribute('divstyle');
        for (var aP=aEl.firstChild; aP; aP=aP.nextSibling) {
          if (!(aP = this._sand(aP)))
            break;
          aP.className = 'palhtmldiv';
          aP.id = aEl.id +'..'+ aP.getAttribute('value');
          aP.removeAttribute('value');
          aP.setAttribute('style', aEl.getAttribute('divstyle'));
        }
        break;
      case 'palpanel':
        for (var aP=aEl.firstChild; aP; aP=aP.nextSibling) {
          if (!(aP = this._sand(aP)))
            break;
          aP.id = iPal.uid + aP.getAttribute('name');
          aP.removeAttribute('name');
          this._paint(aP, iPal);
        }
        break;
      default:
        throw 'paletteMgr._paint(): unknown tag '+ aEl.tagName +'.'+ aEl.className;
      }
    }
  } ,

  //delete: function(iRef) {
  //} ,

  triggerInputElement: function(iTarget) {
    if (!('name' in iTarget && 'value' in iTarget))
      throw 'paletteMgr.triggerInputElement(): target lacks name or value property';
    var aEvt = document.createEvent('Events');
    aEvt.initEvent('input-element', true, false);
    iTarget.dispatchEvent(aEvt);
  } ,

  palette: {
    ctor: function(iTarget, iId) {
      this.div = null;
      this.target = iTarget;
      this.uid = 'suaepal'+iId+'.';
      this.list = {};
      var that = this;
      this.evtFn = function(e) { that.event(e); };
    } ,

    getWidgetByName: function(iName) {
      return document.getElementById(this.uid + iName);
    } ,

    appendWidget: function(iDiv) {
      if (!/^suaepal/.test(iDiv.id))
        throw 'palette.putForeignWidget(): parameter not a widget';
      if (iDiv.id.slice(0, iDiv.id.indexOf('.')+1) !== this.uid)
        this._updateIds(iDiv);
      this.div.appendChild(iDiv);
    } ,

    removeWidget: function(iName) {
      var aW = document.getElementById(this.uid + iName);
      return aW ? this.div.removeChild(aW) : null;
    } ,

    _updateIds: function(iDiv) {
      iDiv.id = this.uid + iDiv.id.slice(iDiv.id.indexOf('.')+1);
      for (var a=iDiv.firstChild; a; a = a.nextSibling)
        if (a.hasAttribute && a.hasAttribute('id'))
          this._updateIds(a);
    } ,

    show: function() {
      this.div.style.display = 'block';
    } ,

    setValue: function(iName, iValue) {
      if (this.list[iName]) {
        var aEl = document.getElementById(this.uid + iName +'..'+ this.list[iName].value);
        if (aEl) {
          aEl.style.padding = '';
          aEl.style.borderWidth = '';
        }
        if (iValue === '' || iValue === null)
          return;
        aEl = document.getElementById(this.uid + iName +'..'+ iValue);
        if (!aEl)
          throw 'palette.setValue(): grid cell '+iName+'..'+iValue+' not found in palette';
        aEl.style.padding = '2px';
        aEl.style.borderWidth = '4px';
        this.list[iName].value = ''+iValue;
      } else {
        var aEl = document.getElementById(this.uid + iName);
        if (!aEl)
          throw 'palette.setValue(): widget '+iName+' not found in palette';
        switch(aEl.className) {
        case 'paltext':
          aEl.value = aEl.prevVal = ''+iValue;
          aEl.style.backgroundColor = null;
          break;
        case 'pallabel':
          aEl.innerHTML = ''+iValue;
          break;
        case 'palbutton':
          aEl.textContent = ''+iValue;
          break;
        case 'palmenu':
          this.setValue(iName+'-menu', iValue);
          aEl.firstChild.textContent = iValue === '' || iValue === null ? '' : document.getElementById(this.uid + iName+'-menu..'+ iValue).textContent;
          break;
        default:
          throw 'palette.setValue(): class '+aEl.className+' not known';
        }
      }
    } ,

    enable: function(iName, iOn) {
      if (this.list[iName]) {
        for (var a=0; a < this.list[iName].subset.length; ++a) {
          var aEl = document.getElementById(this.uid + this.list[iName].subset[a]);
          aEl.style.color = iOn ? null : '#aaa';
          if (iOn)
            aEl.removeAttribute('disabled');
          else
            aEl.setAttribute('disabled', '1');
        }
      } else {
        var aEl = document.getElementById(this.uid + iName);
        if (!aEl)
          throw 'palette.enable(): widget '+iName+' not found in palette';
        switch (aEl.className) {
        case 'palbutton':
        case 'paltext':
          aEl.style.color = iOn ? null : '#aaa';
          break;
        case 'palmenu':
          aEl.firstChild.style.color = iOn ? null : '#aaa';
          break;
        default:
          throw 'palette.enable(): class '+aEl.className+' not known';
        }
        if (iOn)
          aEl.removeAttribute('disabled');
        else
          aEl.setAttribute('disabled', 'disabled');
      }
    } ,

    listSet: function(iName, iValue, iText) {
      var aEl = document.getElementById(this.uid + iName);
      if (aEl && aEl.className === 'palmenu') {
        iName += '-menu';
        aEl = aEl.lastChild;
      }
      if (!aEl || !aEl.hasAttribute('cellclass'))
        throw 'palette.listSet(): list '+iName+' not found in palette';
      var aCellId = this.uid + (aEl.getAttribute('listname') || iName) +'..'+ iValue;
      var aC = document.getElementById(aCellId);
      if (!aC) {
        aC = document.createElement('div');
        aC.className = aEl.getAttribute('cellclass');
        aC.id = aCellId;
        aC.setAttribute('style', aEl.getAttribute('cellstyle'));
        if (aEl.getAttribute('order') === '-')
          aEl.insertBefore(aC, aEl.firstChild);
        else
          aEl.appendChild(aC);
      }
      if (aEl.className === 'palhtml')
        aC.innerHTML = iText;
      else
        aC.textContent = iText;
    } ,

    listMove: function(iName, iValue, iPos) {
      var aEl = document.getElementById(this.uid + iName);
      if (aEl && aEl.className === 'palmenu') {
        iName += '-menu';
        aEl = aEl.lastChild;
      }
      if (!aEl || !aEl.hasAttribute('cellclass'))
        throw 'palette.listMove(): list '+iName+' not found in palette';
      var aCellId = this.uid + (aEl.getAttribute('listname') || iName) +'..'+ iValue;
      var aC = document.getElementById(aCellId);
      if (!aC)
        throw 'palette.listMove(): item '+iValue+' not found in list '+iName;
      if (iPos < aEl.childNodes.length-1)
        aEl.insertBefore(aC, aEl.childNodes[iPos]);
      else
        aEl.appendChild(aC);
    } ,

    listDelete: function(iName, iValue) {
      var aEl = document.getElementById(this.uid + iName);
      if (aEl && aEl.className === 'palmenu') {
        iName += '-menu';
        aEl = aEl.lastChild;
      }
      if (!aEl || !aEl.hasAttribute('cellclass'))
        throw 'palette.listDelete(): list '+iName+' not found in palette';
      if (iValue === null) {
        aEl.innerHTML = '';
      } else {
        var aC = document.getElementById(this.uid + (aEl.getAttribute('listname') || iName) +'..'+ iValue);
        if (aC)
          aEl.removeChild(aC);
      }
    } ,

    showPanel: function(iName) {
      var aEl = document.getElementById(this.uid + iName);
      if (!aEl || aEl.className !== 'palsubpanel')
        throw 'palette.showPanel(): panel '+iName+' not found in palette';
      for (var a=aEl.parentNode.firstChild; a ; a=a.nextSibling)
        a.style.display = a === aEl ? 'block' : '';
    } ,

    hidePanel: function(iName) {
      var aEl = document.getElementById(this.uid + iName);
      if (!aEl || aEl.className !== 'palpanel')
        throw 'palette.hidePanel(): panel '+iName+' not found in palette';
      for (aEl = aEl.firstChild; aEl; aEl = aEl.nextSibling)
        aEl.style.display = null;
    } ,

    event: function(iEvt) {
      switch (iEvt.target.className) {
      case 'palette': case 'pallabel': case 'palgrid': case 'palpanel': case 'palsubpanel':
        return; //. shouldn't this be blocked by handleDrag?
      case 'palclose':
        this.div.style.display = '';
        return;
      }

      switch (iEvt.type) {
      case 'keydown':
        if (iEvt.keyCode === iEvt.DOM_VK_RETURN) {
          var aEnterset = iEvt.target.getAttribute('enterset');
          for (var aEl=iEvt.target.parentNode.firstChild; aEl; aEl=aEl.nextSibling)
            if (aEl.className === 'paltext' && aEl.getAttribute('enterset') === aEnterset) {
              aEl.style.backgroundColor = null;
              if (aEl.prevVal !== aEl.value) {
                var aNameVal = aEl.id.split('.', 2);
                try {
                this.target.paletteEvent(this, aNameVal[1], aEl.value);
                } catch (aEr) {
                  suae.pMgr.postMsg('paletteEvent(): '+aEr);
                }
                aEl.prevVal = aEl.value;
              }
            }
        } else if (iEvt.keyCode === iEvt.DOM_VK_TAB) {
          var aEl = iEvt.target;
          var aEnterset = aEl.getAttribute('enterset');
          while ((aEl = aEl.nextSibling || aEl.parentNode.firstChild).className !== 'paltext' || aEl.getAttribute('enterset') !== aEnterset) {}
          aEl.focus();
          iEvt.preventDefault();
        }
        return;

      case 'keyup':
        if (iEvt.target.value !== iEvt.target.prevVal)
          iEvt.target.style.backgroundColor = '#fcc';
        return;

      case 'click':
        var aNameVal = iEvt.target.id.split('.', 2);
        switch(iEvt.target.className) {
        case 'palgridcell':
        case 'palgridrow':
          if (iEvt.target.parentNode.hasAttribute('disabled'))
            return;
          this.setValue(aNameVal[1], aNameVal[2] = iEvt.target.id.slice(iEvt.target.id.indexOf('..')+2));
          var aM = aNameVal[1].indexOf('-menu');
          if (aM >= 0) {
            iEvt.target.parentNode.previousSibling.textContent = iEvt.target.textContent;
            aNameVal[1] = aNameVal[1].slice(0, aM);
          }
          break;
        case 'palbutton':
          if (iEvt.target.hasAttribute('disabled'))
            return;
          aNameVal[2] = null;
          break;
        case 'palmenubtn':
          if (iEvt.target.parentNode.hasAttribute('disabled'))
            return;
          iEvt.target.nextSibling.style.display = iEvt.target.nextSibling.style.display ? null : 'block';
          iEvt.target.nextSibling.style.left = -iEvt.target.nextSibling.offsetWidth +'px';
          if (iEvt.target.nextSibling.style.display) {
            iEvt.target.parentNode.addEventListener('mouseout', this.evtFn, true);
            iEvt.target.parentNode.addEventListener('mouseover', this.evtFn, true);
          } else {
            iEvt.target.parentNode.removeEventListener('mouseout', this.evtFn, true);
            iEvt.target.parentNode.removeEventListener('mouseover', this.evtFn, true);
          }
          return;
        default:
          return;
        }
        try {
        this.target.paletteEvent(this, aNameVal[1], aNameVal[2]);
        } catch (aEr) {
          suae.pMgr.postMsg('paletteEvent(): '+aEr);
        }
        return;

      case 'input-element':
        try {
        this.target.paletteEvent(this, iEvt.target.name, iEvt.target.value);
        } catch (aEr) {
          suae.pMgr.postMsg('paletteEvent(): '+aEr);
        }
        return;

      case 'mouseout':
        var aEl;
        for (aEl=iEvt.target; aEl.className !== 'palmenu'; aEl = aEl.parentNode) {}
        aEl.menuHider = setTimeout(function() {
          aEl.lastChild.style.display = null;
          aEl.removeEventListener('mouseout', this.evtFn, true);
          aEl.removeEventListener('mouseover', this.evtFn, true);
        }, 60);
        return;
      case 'mouseover':
        var aEl;
        for (aEl=iEvt.target; aEl.className !== 'palmenu'; aEl = aEl.parentNode) {}
        clearTimeout(aEl.menuHider);
        return;
      }
    }
  } , // palette

  handleDrag: function(iEvt) {
    switch(iEvt.type) {
    case 'mousedown':
      switch (iEvt.target.className) {
      case 'palette': case 'pallabel': case 'palgrid': case 'palpanel': case 'palsubpanel':
        for (var aEl = iEvt.target; aEl.className !== 'palette'; aEl = aEl.parentNode) ;
        break;
      default:
        return false;
      }
      this.dragger.palette = aEl;
      this.dragger.deltaX = iEvt.clientX - aEl.offsetLeft;
      this.dragger.deltaY = iEvt.clientY - aEl.offsetTop;
      return true;
    case 'mousemove':
      this.dragger.palette.style.top = iEvt.clientY - this.dragger.deltaY +'px';
      this.dragger.palette.style.left = iEvt.clientX - this.dragger.deltaX +'px';
      return true;
    case 'mouseup':
      this.dragger.palette = null;
      return true;
    }
    return false;
  }

} ; // paletteMgr

suae.scrollbar = {

  eLeft: 'l', eRight: 'r', eBottom: 'b',

  ctor: function() { this.type = null; },

  factory: function() {
    if (this.ctor.prototype !== this)
      this.ctor.prototype = this;
    return new this.ctor();
  } ,

  setup: function(iParent, iType, iView, iCallback) {
    if (this.type)
      return null;
    this.type = iType; // eLeft, eRight, eBottom
    this.objLen = 2*iView; // length of controlled object
    this.viewLen = iView; // length of view on object
    this.objPos = 0; // position of controlled object
    this.callback = iCallback;

    this.bar = iParent.appendChild(document.createElement('div'));
    this.bar.className = 'scrollbar' + this.type;
    this.box = this.bar.appendChild(document.createElement('div'));
    this.box.className = 'scrollbtn';

    this.dragger = suae.dragHandler.factory();
    this.dragger.start(this.bar, this);

    return this.bar;
  } ,

  setDimension: function(iOffset, iSize, iView) {
    this.viewLen = iView;

    if (this.type === this.eBottom ) {
      this.bar.style.left = iOffset + 'px';
      this.bar.style.width = iSize + 'px';
      this.box.style.width = ((this.viewLen * iSize) / this.objLen) + 'px';
    } else {
      this.bar.style.top  = iOffset + 'px';
      this.bar.style.height = iSize + 'px';
      this.box.style.height = ((this.viewLen * iSize) / this.objLen) + 'px';
    }
  } ,

  objSetLen: function(iLen) {
    this.objLen = iLen < this.viewLen*1.6 ? this.viewLen*1.6 : iLen;
    if (this.type === this.eBottom) {
      this.box.style.left = ((this.objPos * this.bar.offsetWidth) / this.objLen) + 'px';
      this.box.style.width = ((this.viewLen * this.bar.offsetWidth) / this.objLen) + 'px';
    } else {
      this.box.style.top = ((this.objPos * this.bar.offsetHeight) / this.objLen) + 'px';
      this.box.style.height = ((this.viewLen * this.bar.offsetHeight) / this.objLen) + 'px';
    }
  } ,

  objSetPos: function(iPos) {
    var aBot = this.type === this.eBottom;
    if (iPos === this.objPos
     || iPos < this.objPos && (aBot ? this.box.offsetLeft : this.box.offsetTop) === 0
     || iPos > this.objPos && (aBot ? this.box.offsetLeft + this.box.offsetWidth === this.bar.offsetWidth : this.box.offsetTop + this.box.offsetHeight === this.bar.offsetHeight))
      return;
    this.objPos = iPos;
    iPos = this.objPos * (aBot ? this.bar.offsetWidth : this.bar.offsetHeight) / this.objLen;
    if (aBot)
      this.box.style.left = (iPos <= 0 ? 0 : iPos + this.box.offsetWidth > this.bar.offsetWidth ? this.bar.offsetWidth - this.box.offsetWidth : iPos) +'px';
    else
      this.box.style.top = (iPos <= 0 ? 0 : iPos + this.box.offsetHeight > this.bar.offsetHeight ? this.bar.offsetHeight - this.box.offsetHeight : iPos) +'px';
    this.callback(-this.objPos, 0);
  } ,

  handleDrag: function(iEvt) {
    var aY;
    switch (iEvt.type) {
    case 'mousedown':
      if (iEvt.target === this.box) {
        this.dragstart = iEvt.layerY;
        return true;
      } else
        this.dragstart = NaN;
      aY = this.box.offsetTop + (iEvt.layerY < this.box.offsetTop ? -1 : 1) * this.box.offsetHeight;
      break;
    case 'mousemove':
      if (isNaN(this.dragstart))
        return true;
      aY = iEvt.clientY - this.dragstart;
      break;
    case 'mouseup':
      return true;
    }
    this.box.style.top = (aY <= 0 ? 0 : aY + this.box.offsetHeight > this.bar.offsetHeight ? this.bar.offsetHeight - this.box.offsetHeight : aY) + 'px';
    this.objPos = (this.box.offsetTop * this.objLen) / (this.type === this.eBottom ? this.bar.offsetWidth : this.bar.offsetHeight);
    this.callback(-this.objPos, 0);
    return true;
  }

} ; // scrollbar

suae.dragHandler = {

  ctor: function() { this.destination = null; },

  factory: function() {
    if (this.ctor.prototype !== this)
      this.ctor.prototype = this;
    return new this.ctor();
  } ,

  start: function(iTarget, iDestination, iCapture) {
    if (this.destination)
      return;
    this.destination = iDestination;
    this.target = iTarget;

    var that = this;
    this.evtFn = function(e) { that.event(e); };
    this.target.addEventListener('mousedown', this.evtFn, iCapture || false);
  } ,

  stop: function() {
    this.target.removeEventListener('mousedown', this.evtFn, false);
    this.destination = null;
    this.target = null;
  } ,

  event: function(iEvt) {
    switch (iEvt.type) {
    case 'mousedown':
      if (this.destination.handleDrag(iEvt)) {
        document.addEventListener('mousemove', this.evtFn, true);
        document.addEventListener('mouseup',   this.evtFn, true);
        iEvt.stopPropagation();
        iEvt.preventDefault();
      }
      return;
    case 'mousemove':
      if (this.destination.handleDrag(iEvt))
        iEvt.stopPropagation();
      return;
    case 'mouseup':
      this.destination.handleDrag(iEvt);
      document.removeEventListener('mousemove', this.evtFn, true);
      document.removeEventListener('mouseup',   this.evtFn, true);
      iEvt.stopPropagation();
      return;
    }
  }

} ; // dragHandler
